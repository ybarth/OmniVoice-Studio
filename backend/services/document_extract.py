import io
import re
import zlib
import zipfile
from html import unescape
from pathlib import Path
from xml.etree import ElementTree

from fastapi import HTTPException

MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

DOCUMENT_KINDS = {
    ".pdf": "PDF",
    ".doc": "Word",
    ".docx": "Word",
    ".rtf": "RTF",
    ".txt": "Text",
    ".text": "Text",
    ".md": "Markdown",
    ".markdown": "Markdown",
}


def _decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "utf-16-le", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\t \f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _extract_plain_text(data: bytes) -> str:
    return normalize_text(_decode_text(data))


def _decode_rtf_hex(match: re.Match[str]) -> str:
    try:
        return bytes.fromhex(match.group(1)).decode("latin-1")
    except Exception:
        return ""


def _extract_rtf_text(data: bytes) -> str:
    text = _decode_text(data)
    text = re.sub(r"\\'([0-9a-fA-F]{2})", _decode_rtf_hex, text)
    text = re.sub(r"\\(?:par|line)\b\s*", "\n", text)
    text = re.sub(r"\\tab\b\s*", "\t", text)
    text = re.sub(r"\\[{}\\]", lambda m: m.group(0)[1:], text)
    text = re.sub(r"\\[a-zA-Z]+-?\d* ?", "", text)
    text = re.sub(r"\\[^a-zA-Z\s]", "", text)
    text = text.replace("{", "").replace("}", "")
    return normalize_text(text)


def _extract_docx_text(data: bytes) -> str:
    parts = []
    xml_paths = [
        "word/document.xml",
        "word/header1.xml",
        "word/footer1.xml",
        "word/footnotes.xml",
        "word/endnotes.xml",
    ]
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = set(zf.namelist())
            for xml_path in xml_paths:
                if xml_path not in names:
                    continue
                root = ElementTree.fromstring(zf.read(xml_path))
                for paragraph in root.iter():
                    if not paragraph.tag.endswith("}p"):
                        continue
                    line = []
                    for node in paragraph.iter():
                        if node.tag.endswith("}t") and node.text:
                            line.append(node.text)
                        elif node.tag.endswith("}tab"):
                            line.append("\t")
                        elif node.tag.endswith("}br"):
                            line.append("\n")
                    joined = "".join(line).strip()
                    if joined:
                        parts.append(joined)
    except (ElementTree.ParseError, KeyError, zipfile.BadZipFile) as exc:
        raise HTTPException(status_code=400, detail=f"Could not read Word document: {exc}") from exc
    return normalize_text("\n".join(parts))


def _extract_legacy_doc_text(data: bytes) -> str:
    utf16_chunks = [
        chunk.decode("utf-16-le", errors="ignore")
        for chunk in re.findall(rb"(?:[\x20-\x7e]\x00){4,}", data)
    ]
    ascii_chunks = [
        chunk.decode("latin-1", errors="ignore")
        for chunk in re.findall(rb"[A-Za-z0-9][A-Za-z0-9\s,.;:'\"!?()\-]{5,}", data)
    ]
    return normalize_text("\n".join(utf16_chunks + ascii_chunks))


def _decode_pdf_literal(value: str) -> str:
    value = value[1:-1]

    def replace_octal(match: re.Match[str]) -> str:
        try:
            return chr(int(match.group(1), 8))
        except ValueError:
            return ""

    value = re.sub(r"\\([0-7]{1,3})", replace_octal, value)
    replacements = {
        r"\n": "\n",
        r"\r": "\n",
        r"\t": "\t",
        r"\b": "",
        r"\f": "",
        r"\(": "(",
        r"\)": ")",
        r"\\": "\\",
    }
    for src, dst in replacements.items():
        value = value.replace(src, dst)
    return value


def _decode_pdf_hex(value: str) -> str:
    raw = re.sub(r"\s+", "", value[1:-1])
    if len(raw) % 2:
        raw += "0"
    try:
        payload = bytes.fromhex(raw)
    except ValueError:
        return ""
    for encoding in ("utf-16-be", "utf-8", "latin-1"):
        try:
            return payload.decode(encoding)
        except UnicodeDecodeError:
            continue
    return payload.decode("latin-1", errors="ignore")


def _inflate_pdf_stream(stream: bytes) -> bytes:
    for kwargs in ({}, {"wbits": -15}):
        try:
            return zlib.decompress(stream, **kwargs)
        except Exception:
            continue
    return stream


def _extract_pdf_text_fallback(data: bytes) -> str:
    chunks = []
    streams = re.findall(rb"stream\r?\n(.*?)\r?\nendstream", data, flags=re.S)
    if not streams:
        streams = [data]
    for raw_stream in streams:
        text = _inflate_pdf_stream(raw_stream).decode("latin-1", errors="ignore")
        for literal in re.findall(r"\((?:\\.|[^\\)])*\)\s*Tj", text, flags=re.S):
            chunks.append(_decode_pdf_literal(literal.rsplit(")", 1)[0] + ")"))
        for array_body in re.findall(r"\[(.*?)\]\s*TJ", text, flags=re.S):
            for literal in re.findall(r"\((?:\\.|[^\\)])*\)", array_body, flags=re.S):
                chunks.append(_decode_pdf_literal(literal))
            for hex_value in re.findall(r"<[0-9A-Fa-f\s]+>", array_body):
                chunks.append(_decode_pdf_hex(hex_value))
        for hex_value in re.findall(r"<[0-9A-Fa-f\s]+>\s*Tj", text):
            chunks.append(_decode_pdf_hex(hex_value.rsplit(">", 1)[0] + ">"))
    return normalize_text(" ".join(part for part in chunks if part.strip()))


def _extract_pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader  # type: ignore

        reader = PdfReader(io.BytesIO(data))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
        if text.strip():
            return normalize_text(text)
    except Exception:
        pass
    return _extract_pdf_text_fallback(data)


def extract_document_text(filename: str, data: bytes) -> tuple[str, str]:
    ext = Path(filename or "").suffix.lower()
    kind = DOCUMENT_KINDS.get(ext)
    if not kind:
        raise HTTPException(status_code=400, detail="Unsupported document type. Upload PDF, Word, RTF, TXT, or Markdown.")
    if ext in {".txt", ".text", ".md", ".markdown"}:
        text = _extract_plain_text(data)
    elif ext == ".rtf":
        text = _extract_rtf_text(data)
    elif ext == ".docx":
        text = _extract_docx_text(data)
    elif ext == ".doc":
        text = _extract_legacy_doc_text(data)
    elif ext == ".pdf":
        text = _extract_pdf_text(data)
    else:
        text = ""
    if not text:
        raise HTTPException(status_code=400, detail=f"Could not extract readable text from this {kind} document.")
    return kind, unescape(text)
