import csv
import io
import json
import os
import tempfile
import time
import zipfile
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from core.config import OUTPUTS_DIR
from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

router = APIRouter()

AudioFormat = Literal["wav", "mp3", "flac"]
AudioLayout = Literal["folder", "single"]
TextFormat = Literal["txt", "json", "csv", "pdf"]


class ConversationExportTurn(BaseModel):
    id: str
    index: int = 0
    speakerName: str
    sourceText: str = ""
    translatedText: str = ""
    sourceLanguage: str = ""
    targetLanguage: str = ""
    audioPath: str = ""
    audioId: str = ""


class ConversationExportRequest(BaseModel):
    conversation: dict = Field(default_factory=dict)
    turns: list[ConversationExportTurn]
    textFormats: list[TextFormat] = Field(default_factory=lambda: ["txt"])
    audioFormat: AudioFormat = "wav"
    audioLayout: AudioLayout = "folder"
    includeAudio: bool = True


def _safe_export_name(value: str, fallback: str = "conversation") -> str:
    safe = "".join(ch for ch in (value or "") if ch.isalnum() or ch in " -_").strip()
    return safe.replace(" ", "_") or fallback


def _safe_output_audio_path(audio_path: str) -> str | None:
    if not audio_path:
        return None
    base = os.path.basename(audio_path)
    if base != audio_path:
        return None
    outputs_real = os.path.realpath(OUTPUTS_DIR)
    candidate = os.path.realpath(os.path.join(OUTPUTS_DIR, base))
    if not candidate.startswith(outputs_real + os.sep):
        return None
    if not os.path.exists(candidate) or os.path.getsize(candidate) <= 0:
        return None
    return candidate


def _turn_filename(turn: ConversationExportTurn, suffix: str) -> str:
    index = turn.index if turn.index > 0 else 1
    speaker = _safe_export_name(turn.speakerName, "speaker")
    return f"{index:03d}_{speaker}.{suffix}"


def _conversation_title(req: ConversationExportRequest) -> str:
    return str(req.conversation.get("title") or req.conversation.get("name") or "Conversation")


def _text_rows(req: ConversationExportRequest) -> list[dict]:
    return [
        {
            "index": turn.index or idx,
            "speaker": turn.speakerName,
            "source_language": turn.sourceLanguage,
            "target_language": turn.targetLanguage,
            "source_text": turn.sourceText,
            "translated_text": turn.translatedText,
            "audio_path": turn.audioPath,
        }
        for idx, turn in enumerate(req.turns, start=1)
    ]


def _render_txt(req: ConversationExportRequest) -> str:
    title = _conversation_title(req)
    lines = [title, "=" * len(title), ""]
    for idx, turn in enumerate(req.turns, start=1):
        number = turn.index or idx
        route = " -> ".join(part for part in [turn.sourceLanguage, turn.targetLanguage] if part)
        suffix = f" ({route})" if route else ""
        lines.append(f"{number:03d}. {turn.speakerName}{suffix}")
        if turn.sourceText:
            lines.append(f"Source: {turn.sourceText}")
        if turn.translatedText:
            lines.append(f"Translation: {turn.translatedText}")
        lines.append("")
    return "\n".join(lines)


def _render_json(req: ConversationExportRequest) -> str:
    return json.dumps(
        {
            "conversation": req.conversation,
            "turns": _text_rows(req),
            "exported_at": time.time(),
        },
        ensure_ascii=False,
        indent=2,
    )


def _render_csv(req: ConversationExportRequest) -> str:
    rows = _text_rows(req)
    out = io.StringIO()
    writer = csv.DictWriter(
        out,
        fieldnames=[
            "index",
            "speaker",
            "source_language",
            "target_language",
            "source_text",
            "translated_text",
            "audio_path",
        ],
    )
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()


def _pdf_escape(value: str) -> str:
    return (value or "").replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _wrap_text(value: str, max_chars: int = 86) -> list[str]:
    words = (value or "").replace("\n", " ").split()
    if not words:
        return [""]
    lines: list[str] = []
    current = ""
    for word in words:
        next_line = f"{current} {word}".strip()
        if len(next_line) > max_chars and current:
            lines.append(current)
            current = word
        else:
            current = next_line
    if current:
        lines.append(current)
    return lines


def _build_pdf(req: ConversationExportRequest, attachments: list[tuple[str, bytes, str]]) -> bytes:
    title = _conversation_title(req)
    text_lines = [title, ""]
    for idx, turn in enumerate(req.turns, start=1):
        number = turn.index or idx
        text_lines.append(f"{number:03d}. {turn.speakerName}")
        for line in _wrap_text(f"Source: {turn.sourceText}"):
            text_lines.append(line)
        for line in _wrap_text(f"Translation: {turn.translatedText}"):
            text_lines.append(line)
        text_lines.append("")
    if attachments:
        text_lines.append("Audio files are embedded as PDF file attachments.")

    visible_lines = text_lines[:50]
    content_parts = ["BT", "/F1 10 Tf", "50 780 Td", "14 TL"]
    for line in visible_lines:
        content_parts.append(f"({_pdf_escape(line)}) Tj")
        content_parts.append("T*")
    content_parts.append("ET")
    content = "\n".join(content_parts).encode("utf-8")

    objects: list[bytes] = []

    def add_object(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog_id = add_object(b"")
    pages_id = add_object(b"")
    page_id = add_object(b"")
    font_id = add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    content_id = add_object(
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n"
        + content + b"\nendstream"
    )

    file_spec_ids: list[tuple[str, int]] = []
    for filename, data, mime in attachments:
        subtype = mime.replace("/", "#2F").encode("ascii", errors="ignore")
        embedded_id = add_object(
            b"<< /Type /EmbeddedFile /Subtype /" + subtype
            + b" /Params << /Size " + str(len(data)).encode("ascii") + b" >>"
            + b" /Length " + str(len(data)).encode("ascii") + b" >>\nstream\n"
            + data + b"\nendstream"
        )
        escaped_name = _pdf_escape(filename).encode("utf-8")
        spec_id = add_object(
            b"<< /Type /Filespec /F (" + escaped_name + b") /UF (" + escaped_name
            + b") /EF << /F " + str(embedded_id).encode("ascii") + b" 0 R >> >>"
        )
        file_spec_ids.append((filename, spec_id))

    names_body = b"<< /Names ["
    for filename, spec_id in file_spec_ids:
        names_body += (
            b" (" + _pdf_escape(filename).encode("utf-8") + b") "
            + str(spec_id).encode("ascii") + b" 0 R"
        )
    names_body += b" ] >>"
    names_id = add_object(names_body)

    objects[pages_id - 1] = (
        b"<< /Type /Pages /Kids [ " + str(page_id).encode("ascii")
        + b" 0 R ] /Count 1 >>"
    )
    objects[page_id - 1] = (
        b"<< /Type /Page /Parent " + str(pages_id).encode("ascii")
        + b" 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 "
        + str(font_id).encode("ascii")
        + b" 0 R >> >> /Contents "
        + str(content_id).encode("ascii")
        + b" 0 R >>"
    )
    objects[catalog_id - 1] = (
        b"<< /Type /Catalog /Pages " + str(pages_id).encode("ascii")
        + b" 0 R /Names << /EmbeddedFiles " + str(names_id).encode("ascii")
        + b" 0 R >> /PageMode /UseAttachments >>"
    )

    output = io.BytesIO()
    output.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for obj_id, body in enumerate(objects, start=1):
        offsets.append(output.tell())
        output.write(f"{obj_id} 0 obj\n".encode("ascii"))
        output.write(body)
        output.write(b"\nendobj\n")
    xref_at = output.tell()
    output.write(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.write(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.write(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.write(
        b"trailer\n<< /Size " + str(len(objects) + 1).encode("ascii")
        + b" /Root " + str(catalog_id).encode("ascii") + b" 0 R >>\n"
        + b"startxref\n" + str(xref_at).encode("ascii") + b"\n%%EOF\n"
    )
    return output.getvalue()


def _codec_args(fmt: AudioFormat) -> list[str]:
    if fmt == "mp3":
        return ["-codec:a", "libmp3lame", "-b:a", "192k"]
    if fmt == "flac":
        return ["-codec:a", "flac"]
    return ["-codec:a", "pcm_s16le"]


async def _convert_audio(src: str, fmt: AudioFormat) -> bytes:
    if fmt == "wav":
        with open(src, "rb") as f:
            return f.read()
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise HTTPException(status_code=500, detail="ffmpeg is required for MP3/FLAC conversation exports")
    with tempfile.TemporaryDirectory() as tmp:
        out_path = os.path.join(tmp, f"turn.{fmt}")
        cmd = [ffmpeg, "-y", "-i", src, *_codec_args(fmt), out_path]
        rc, _, stderr = await run_ffmpeg(cmd, timeout=600.0)
        if rc != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) <= 0:
            detail = stderr.decode(errors="replace") if stderr else "audio conversion failed"
            raise HTTPException(status_code=500, detail=detail[:600])
        with open(out_path, "rb") as f:
            return f.read()


async def _concat_audio(paths: list[str], fmt: AudioFormat) -> bytes:
    if not paths:
        return b""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise HTTPException(status_code=500, detail="ffmpeg is required for single-file conversation exports")
    with tempfile.TemporaryDirectory() as tmp:
        list_path = os.path.join(tmp, "inputs.txt")
        out_path = os.path.join(tmp, f"conversation.{fmt}")
        with open(list_path, "w", encoding="utf-8") as f:
            for path in paths:
                f.write(f"file '{path.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n")
        cmd = [
            ffmpeg,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_path,
            *_codec_args(fmt),
            out_path,
        ]
        rc, _, stderr = await run_ffmpeg(cmd, timeout=900.0)
        if rc != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) <= 0:
            detail = stderr.decode(errors="replace") if stderr else "audio concatenation failed"
            raise HTTPException(status_code=500, detail=detail[:600])
        with open(out_path, "rb") as f:
            return f.read()


def _media_type(fmt: AudioFormat) -> str:
    return {
        "wav": "audio/wav",
        "mp3": "audio/mpeg",
        "flac": "audio/flac",
    }[fmt]


@router.post("/conversation/export")
async def conversation_export(req: ConversationExportRequest):
    if not req.turns:
        raise HTTPException(status_code=400, detail="No conversation turns selected for export")

    zip_buffer = io.BytesIO()
    attachments: list[tuple[str, bytes, str]] = []
    missing_audio: list[str] = []

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        formats = req.textFormats or ["txt"]
        if "txt" in formats:
            zf.writestr("text/conversation.txt", _render_txt(req))
        if "json" in formats:
            zf.writestr("text/conversation.json", _render_json(req))
        if "csv" in formats:
            zf.writestr("text/conversation.csv", _render_csv(req))

        if req.includeAudio:
            source_paths: list[tuple[ConversationExportTurn, str]] = []
            for idx, turn in enumerate(req.turns, start=1):
                path = _safe_output_audio_path(turn.audioPath)
                if not path:
                    missing_audio.append(f"{turn.index or idx:03d} {turn.speakerName}: {turn.audioPath or 'no audio path'}")
                    continue
                source_paths.append((turn, path))

            if req.audioLayout == "single" and source_paths:
                data = await _concat_audio([path for _, path in source_paths], req.audioFormat)
                filename = f"conversation_audio.{req.audioFormat}"
                zf.writestr(f"audio/{filename}", data)
                attachments.append((filename, data, _media_type(req.audioFormat)))
            else:
                for turn, path in source_paths:
                    data = await _convert_audio(path, req.audioFormat)
                    filename = _turn_filename(turn, req.audioFormat)
                    zf.writestr(f"audio/{filename}", data)
                    attachments.append((filename, data, _media_type(req.audioFormat)))

        if missing_audio:
            zf.writestr("audio/missing_audio.txt", "\n".join(missing_audio) + "\n")

        if "pdf" in formats:
            zf.writestr("pdf/conversation.pdf", _build_pdf(req, attachments))

    zip_buffer.seek(0)
    safe_title = _safe_export_name(_conversation_title(req), "conversation")
    return Response(
        content=zip_buffer.read(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_title}_export.zip"'},
    )
