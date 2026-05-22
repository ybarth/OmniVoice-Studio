import os
import io
import uuid
import time
import asyncio
import tempfile
import contextlib
import logging
import traceback
import threading
from typing import Optional
from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from fastapi.responses import StreamingResponse

from core.db import db_conn
from core.config import OUTPUTS_DIR, VOICES_DIR
from services.model_manager import get_model, _gpu_pool
from services.audio_dsp import apply_mastering, normalize_audio
from core import event_bus
from core.text_fields import clean_instruct_text, clean_optional_text
from services.cantonese_guard import (
    apply_cantonese_pronunciation_guard,
    is_cantonese_target,
    normalize_tts_language,
    validate_spoken_cantonese_text,
)

router = APIRouter()
logger = logging.getLogger("omnivoice.generate")
REFERENCE_TRANSCRIPT_REQUIRED = (
    "Add what the reference sample says in Reference Transcript before synthesizing."
)
_GENERATION_STATUS: dict[str, dict] = {}
_GENERATION_STATUS_LOCK = threading.Lock()
_GENERATION_STATUS_TTL_SECONDS = 30 * 60


def _set_generation_status(
    request_id: str | None,
    status: str,
    phase: str,
    detail: str,
    progress_pct: int | None = None,
    error: str | None = None,
) -> None:
    if not request_id:
        return
    now = time.time()
    with _GENERATION_STATUS_LOCK:
        _GENERATION_STATUS[request_id] = {
            "request_id": request_id,
            "status": status,
            "phase": phase,
            "detail": detail,
            "progress_pct": progress_pct,
            "error": error,
            "started_at": _GENERATION_STATUS.get(request_id, {}).get("started_at", now),
            "updated_at": now,
        }


def _get_generation_status(request_id: str) -> dict:
    now = time.time()
    with _GENERATION_STATUS_LOCK:
        stale_keys = [
            key for key, value in _GENERATION_STATUS.items()
            if now - float(value.get("updated_at") or 0) > _GENERATION_STATUS_TTL_SECONDS
        ]
        for key in stale_keys:
            _GENERATION_STATUS.pop(key, None)
        status = _GENERATION_STATUS.get(request_id)
        if status:
            return dict(status)
    return {
        "request_id": request_id,
        "status": "idle",
        "phase": "idle",
        "detail": "",
        "progress_pct": None,
        "error": None,
        "started_at": None,
        "updated_at": None,
    }


@router.get("/generate/status/{request_id}")
def generation_status(request_id: str):
    return _get_generation_status(request_id)

def _run_inference(
    model, text, language, ref_audio_path, ref_text, instruct, duration,
    num_step, guidance_scale, speed, t_shift, denoise,
    postprocess_output, layer_penalty_factor, position_temperature,
    class_temperature, used_seed, progress_callback=None,
):
    import torch
    try:
        if used_seed is not None:
            torch.manual_seed(used_seed)

        kwargs = {}
        if t_shift is not None: kwargs["t_shift"] = t_shift
        if layer_penalty_factor is not None: kwargs["layer_penalty_factor"] = layer_penalty_factor
        if position_temperature is not None: kwargs["position_temperature"] = position_temperature
        if class_temperature is not None: kwargs["class_temperature"] = class_temperature

        if progress_callback:
            progress_callback("running", "inferencing", "Synthesizing audio with the TTS model", None)
        audios = model.generate(
            text=text, language=language, ref_audio=ref_audio_path,
            ref_text=ref_text, instruct=instruct, duration=duration,
            num_step=num_step, guidance_scale=guidance_scale, speed=speed,
            denoise=denoise, postprocess_output=postprocess_output,
            **kwargs
        )
        if progress_callback:
            progress_callback("running", "mastering", "Mastering generated audio", 76)
        audio_out = audios[0]
        
        mastered_audio = apply_mastering(audio_out, sample_rate=model.sampling_rate if hasattr(model, 'sampling_rate') else 24000)
        normalized_audio = normalize_audio(mastered_audio, target_dBFS=-2.0)
        if progress_callback:
            progress_callback("running", "saving", "Preparing generated audio for history", 82)
        return normalized_audio
        
    except ValueError as e:
        # Don't wrap validation errors in OOM message
        raise e
    except Exception as e:
        import gc
        gc.collect()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()
        raise RuntimeError(
            f"TTS engine stopped mid-generation. This usually means it ran out of memory. "
            f"Try the Flush button to reload the model, then regenerate. Underlying error: {e}"
        )


@router.post("/generate")
async def generate_speech(
    text: str = Form(...),
    language: Optional[str] = Form(None),
    ref_audio: Optional[UploadFile] = File(None),
    ref_text: Optional[str] = Form(None),
    instruct: Optional[str] = Form(None),
    duration: Optional[float] = Form(None),
    num_step: int = Form(16),
    guidance_scale: float = Form(2.0),
    speed: float = Form(1.0),
    t_shift: Optional[float] = Form(None),
    denoise: bool = Form(True),
    postprocess_output: bool = Form(True),
    layer_penalty_factor: Optional[float] = Form(None),
    position_temperature: Optional[float] = Form(None),
    class_temperature: Optional[float] = Form(None),
    profile_id: Optional[str] = Form(None),
    seed: Optional[int] = Form(None),
    request_id: Optional[str] = Form(None),
):
    _set_generation_status(request_id, "running", "validating", "Checking prompt and voice source", 6)
    ref_audio_path = None
    cleanup_ref = False
    used_seed = seed
    resolved_profile_id = None
    ref_text = clean_optional_text(ref_text)
    instruct = clean_instruct_text(instruct)

    if profile_id:
        _set_generation_status(request_id, "running", "validating", "Loading selected voice profile", 10)
        with db_conn() as conn:
            row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
        if row:
            resolved_profile_id = profile_id
            if row["is_locked"] and row["locked_audio_path"]:
                ref_audio_path = os.path.join(VOICES_DIR, row["locked_audio_path"])
                if not ref_text:
                    ref_text = clean_optional_text(row["ref_text"])
                if not instruct:
                    instruct = clean_instruct_text(row["instruct"])
                if used_seed is None and row["seed"] is not None:
                    used_seed = row["seed"]
            elif row["instruct"] and not row["is_locked"]:
                if not instruct:
                    instruct = clean_instruct_text(row["instruct"])
                if used_seed is None and row["seed"] is not None:
                    used_seed = row["seed"]
            else:
                ref_audio_path = os.path.join(VOICES_DIR, row["ref_audio_path"]) if row["ref_audio_path"] else None
                if not ref_text and row["ref_text"]:
                    ref_text = clean_optional_text(row["ref_text"])
                if not instruct and row["instruct"]:
                    instruct = clean_instruct_text(row["instruct"])
                if used_seed is None and row["seed"] is not None:
                    used_seed = row["seed"]
            if language == "Auto":
                language = None
    elif ref_audio is not None:
        if not ref_text:
            _set_generation_status(request_id, "error", "error", REFERENCE_TRANSCRIPT_REQUIRED, None, REFERENCE_TRANSCRIPT_REQUIRED)
            raise HTTPException(status_code=400, detail=REFERENCE_TRANSCRIPT_REQUIRED)
        try:
            _set_generation_status(request_id, "running", "validating", "Reading uploaded reference audio", 12)
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as f:
                f.write(await ref_audio.read())
                ref_audio_path = f.name
                cleanup_ref = True
        except Exception as e:
            _set_generation_status(request_id, "error", "error", str(e), None, str(e))
            raise HTTPException(status_code=500, detail=str(e))

    if ref_audio_path and not ref_text:
        _set_generation_status(request_id, "error", "error", REFERENCE_TRANSCRIPT_REQUIRED, None, REFERENCE_TRANSCRIPT_REQUIRED)
        raise HTTPException(status_code=400, detail=REFERENCE_TRANSCRIPT_REQUIRED)

    if is_cantonese_target(language):
        _set_generation_status(request_id, "running", "validating", "Checking spoken Hong Kong Cantonese prompt", 15)
        pronunciation_pass = apply_cantonese_pronunciation_guard(text)
        if pronunciation_pass.changed:
            text = pronunciation_pass.text
        ok, reason = validate_spoken_cantonese_text(text)
        if not ok:
            detail = (
                f"{reason} Use Translate or Translate and Synthesize so the "
                "prompt is converted to spoken Hong Kong Cantonese before synthesis."
            )
            _set_generation_status(request_id, "error", "error", detail, None, detail)
            raise HTTPException(
                status_code=400,
                detail=detail,
            )
        language = normalize_tts_language(language)

    _set_generation_status(request_id, "running", "loading_model", "Loading TTS model", 22)
    try:
        _model = await get_model()
    except Exception as e:
        detail = f"Couldn't load the TTS model: {e}"
        _set_generation_status(request_id, "error", "error", detail, None, str(e))
        raise
    start_time = time.time()
    try:
        loop = asyncio.get_running_loop()
        def _progress(status, phase, detail, progress_pct=None, error=None):
            _set_generation_status(request_id, status, phase, detail, progress_pct, error)

        audio_tensor = await loop.run_in_executor(
            _gpu_pool, _run_inference,
            _model, text, language, ref_audio_path, ref_text, instruct, duration,
            num_step, guidance_scale, speed, t_shift, denoise,
            postprocess_output, layer_penalty_factor, position_temperature,
            class_temperature, used_seed, _progress,
        )
        gen_time = round(time.time() - start_time, 2)

        _set_generation_status(request_id, "running", "saving", "Saving generated audio", 84)
        audio_id = str(uuid.uuid4())[:8]
        audio_filename = f"{audio_id}.wav"
        audio_path = os.path.join(OUTPUTS_DIR, audio_filename)
        import torchaudio
        torchaudio.save(audio_path, audio_tensor, _model.sampling_rate)

        audio_dur = round(audio_tensor.shape[-1] / _model.sampling_rate, 2)

        _set_generation_status(request_id, "running", "recording_history", "Updating generated-audio history", 88)
        with db_conn() as conn:
            conn.execute(
                "INSERT INTO generation_history (id, text, mode, language, instruct, profile_id, audio_path, duration_seconds, generation_time, seed, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (audio_id, text[:200], "clone" if ref_audio_path else "design",
                 language or "Auto", instruct or "", resolved_profile_id,
                 audio_filename, audio_dur, gen_time, used_seed, time.time())
            )
        event_bus.emit("generation_history", {"action": "created", "id": audio_id})

        _set_generation_status(request_id, "running", "encoding", "Encoding generated WAV", 92)
        buffer = io.BytesIO()
        torchaudio.save(buffer, audio_tensor, _model.sampling_rate, format="wav")
        buffer.seek(0)
        wav_bytes = buffer.read()

        _set_generation_status(request_id, "running", "streaming", "Streaming generated WAV", 96)
        async def _stream_wav():
            chunk_size = 16384
            try:
                for i in range(0, len(wav_bytes), chunk_size):
                    yield wav_bytes[i:i + chunk_size]
            finally:
                _set_generation_status(request_id, "done", "done", "Audio ready", 100)

        return StreamingResponse(
            _stream_wav(),
            media_type="audio/wav",
            headers={
                "X-Audio-Id": audio_id,
                "X-Gen-Time": str(gen_time),
                "X-Audio-Path": audio_filename,
                "X-Seed": str(used_seed) if used_seed is not None else "",
                "X-Audio-Duration": str(audio_dur),
                "Content-Length": str(len(wav_bytes)),
            }
        )
    except HTTPException:
        _set_generation_status(request_id, "error", "error", "Synthesis request failed", None, "Synthesis request failed")
        raise
    except ValueError as e:
        logger.error("Validation failed: %s", e)
        _set_generation_status(request_id, "error", "error", str(e), None, str(e))
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        tb = traceback.format_exc()
        logger.error("Inference failed: %s\n%s", e, tb)
        detail = (
            f"Couldn't synthesize audio. See Settings → Logs → Backend for the full trace. "
            f"Underlying error: {e}"
        )
        _set_generation_status(request_id, "error", "error", detail, None, str(e))
        raise HTTPException(
            status_code=500,
            detail=detail,
        )
    finally:
        if cleanup_ref and ref_audio_path:
            with contextlib.suppress(OSError):
                os.remove(ref_audio_path)

def _safe_output_path(name):
    if not name:
        return None
    base = os.path.basename(name)
    if base != name:
        return None
    outputs_real = os.path.realpath(OUTPUTS_DIR)
    candidate = os.path.realpath(os.path.join(OUTPUTS_DIR, base))
    if not candidate.startswith(outputs_real + os.sep):
        return None
    return candidate


@router.get("/history")
def list_history():
    with db_conn() as conn:
        rows = conn.execute("SELECT * FROM generation_history ORDER BY created_at DESC LIMIT 50").fetchall()
    return [dict(r) for r in rows]

@router.delete("/history")
def clear_history():
    with db_conn() as conn:
        rows = conn.execute("SELECT audio_path FROM generation_history").fetchall()
        for r in rows:
            p = _safe_output_path(r["audio_path"])
            if p and os.path.exists(p):
                with contextlib.suppress(OSError):
                    os.remove(p)
        conn.execute("DELETE FROM generation_history")
    event_bus.emit("generation_history")
    return {"cleared": True}

@router.delete("/history/{history_id}")
def delete_single_history(history_id: str):
    with db_conn() as conn:
        row = conn.execute("SELECT audio_path FROM generation_history WHERE id=?", (history_id,)).fetchone()
        if row and row["audio_path"]:
            p = _safe_output_path(row["audio_path"])
            if p and os.path.exists(p):
                with contextlib.suppress(OSError):
                    os.remove(p)
        conn.execute("DELETE FROM generation_history WHERE id=?", (history_id,))
    event_bus.emit("generation_history", {"action": "deleted", "id": history_id})
    return {"deleted": True}
