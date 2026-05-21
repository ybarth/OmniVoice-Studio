import os
import uuid
import time
import shutil
import mimetypes
from typing import Optional
from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from core.db import db_conn
from core.config import VOICES_DIR, PROFILE_PHOTOS_DIR, OUTPUTS_DIR
from core import event_bus
from core.personalities import get_personalities
from core.text_fields import clean_instruct_text

router = APIRouter()

_PHOTO_EXTENSIONS = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    ref_text: Optional[str] = None
    instruct: Optional[str] = None
    language: Optional[str] = None
    personality: Optional[str] = None


@router.get("/personalities")
def list_personalities():
    """Return built-in voice personality presets."""
    return get_personalities()

@router.get("/profiles")
def list_profiles():
    with db_conn() as conn:
        rows = conn.execute("SELECT * FROM voice_profiles ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]

@router.post("/profiles")
async def create_profile(
    name: str = Form(...),
    ref_audio: UploadFile = File(...),
    ref_text: str = Form(""),
    instruct: str = Form(""),
    language: str = Form("Auto"),
    seed: Optional[int] = Form(None),
    personality: str = Form(""),
):
    instruct = clean_instruct_text(instruct) or ""
    profile_id = str(uuid.uuid4())[:8]
    ext = os.path.splitext(ref_audio.filename or ".wav")[1]
    audio_filename = f"{profile_id}{ext}"
    audio_path = os.path.join(VOICES_DIR, audio_filename)

    with open(audio_path, "wb") as f:
        f.write(await ref_audio.read())

    try:
        with db_conn() as conn:
            conn.execute(
                "INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, instruct, language, seed, personality, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (profile_id, name, audio_filename, ref_text, instruct, language, seed, personality, time.time())
            )
            profile = conn.execute("SELECT * FROM voice_profiles WHERE id = ?", (profile_id,)).fetchone()
    except Exception:
        # Clean up orphaned audio file if DB insert fails
        if os.path.exists(audio_path):
            os.remove(audio_path)
        raise
    event_bus.emit("profiles", {"action": "created", "id": profile_id})
    return dict(profile)

@router.get("/profiles/{profile_id}")
def get_profile(profile_id: str):
    """Full profile record for the voice profile page."""
    with db_conn() as conn:
        row = conn.execute(
            "SELECT * FROM voice_profiles WHERE id = ?", (profile_id,),
        ).fetchone()
    if not row:
        raise HTTPException(
            status_code=404,
            detail="That voice profile doesn't exist. It may have been deleted from another tab.",
        )
    return dict(row)


@router.put("/profiles/{profile_id}")
def update_profile(profile_id: str, patch: ProfileUpdate):
    """Partial update — only fields set on the payload are changed."""
    fields = []
    params = []
    for col in ("name", "ref_text", "instruct", "language", "personality"):
        val = getattr(patch, col)
        if val is None:
            continue
        if col == "name" and not val.strip():
            raise HTTPException(status_code=400, detail="A voice profile needs a name.")
        fields.append(f"{col} = ?")
        if col == "instruct":
            params.append(clean_instruct_text(val) or "")
        else:
            params.append(val.strip() if col in ("name", "language") else val)
    if not fields:
        raise HTTPException(
            status_code=400,
            detail="PUT /profiles/{id} body contained no editable fields. Include at least one of: name, language, instruct, description.",
        )
    params.append(profile_id)
    with db_conn() as conn:
        cur = conn.execute(
            f"UPDATE voice_profiles SET {', '.join(fields)} WHERE id = ?",
            params,
        )
        if cur.rowcount == 0:
            raise HTTPException(
                status_code=404,
                detail="That voice profile doesn't exist. It may have been deleted from another tab.",
            )
        row = conn.execute(
            "SELECT * FROM voice_profiles WHERE id = ?", (profile_id,),
        ).fetchone()
    event_bus.emit("profiles", {"action": "updated", "id": profile_id})
    return dict(row)


@router.get("/profiles/{profile_id}/usage")
def get_profile_usage(profile_id: str):
    """Where has this voice been used? Synth-history + segment counts per project."""
    with db_conn() as conn:
        synth_rows = conn.execute(
            "SELECT id, text, audio_path, created_at, generation_time "
            "FROM generation_history WHERE profile_id = ? "
            "ORDER BY created_at DESC LIMIT 20",
            (profile_id,),
        ).fetchall()
        synth_total = conn.execute(
            "SELECT COUNT(*) AS n FROM generation_history WHERE profile_id = ?",
            (profile_id,),
        ).fetchone()["n"]

    # Dub project usage is harder — profile_id lives inside state_json.segments[].profile_id.
    # We scan the persisted state blob; for tens of projects this is fine.
    import json
    project_hits: list[dict] = []
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, updated_at, state_json FROM studio_projects ORDER BY updated_at DESC"
        ).fetchall()
    for r in rows:
        try:
            state = json.loads(r["state_json"] or "{}")
        except Exception:
            continue
        segs = state.get("segments") or []
        n = sum(1 for s in segs if s.get("profile_id") == profile_id)
        if n:
            project_hits.append({
                "project_id": r["id"],
                "project_name": r["name"],
                "segment_count": n,
                "updated_at": r["updated_at"],
            })

    return {
        "synth_recent": [dict(r) for r in synth_rows],
        "synth_total": synth_total,
        "projects": project_hits,
        "project_total_segments": sum(p["segment_count"] for p in project_hits),
    }


@router.get("/profiles/{profile_id}/audio")
def get_profile_audio(profile_id: str):
    with db_conn() as conn:
        row = conn.execute("SELECT ref_audio_path, locked_audio_path FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    if not row:
        return Response("Profile not found", status_code=404)
    audio_file = row["locked_audio_path"] or row["ref_audio_path"]
    if not audio_file:
        return Response("No audio available", status_code=404)
    audio_path = os.path.join(VOICES_DIR, audio_file)
    if not os.path.exists(audio_path):
        return Response("Audio file missing", status_code=404)
    return FileResponse(audio_path, media_type="audio/wav")


@router.get("/profiles/{profile_id}/photo")
def get_profile_photo(profile_id: str):
    with db_conn() as conn:
        row = conn.execute("SELECT photo_path FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    if not row:
        return Response("Profile not found", status_code=404)
    if not row["photo_path"]:
        return Response("No photo available", status_code=404)
    photo_path = os.path.join(PROFILE_PHOTOS_DIR, row["photo_path"])
    if not os.path.exists(photo_path):
        return Response("Photo file missing", status_code=404)
    media_type = mimetypes.guess_type(photo_path)[0] or "application/octet-stream"
    return FileResponse(photo_path, media_type=media_type)


@router.post("/profiles/{profile_id}/photo")
async def upload_profile_photo(profile_id: str, photo: UploadFile = File(...)):
    ext = os.path.splitext(photo.filename or "")[1].lower()
    if ext not in _PHOTO_EXTENSIONS:
        content_type = (photo.content_type or "").split(";")[0].strip().lower()
        ext = next((candidate for candidate, media in _PHOTO_EXTENSIONS.items() if media == content_type), "")
    if ext not in _PHOTO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Profile photos must be PNG, JPG, WEBP, or GIF images.")

    with db_conn() as conn:
        current = conn.execute(
            "SELECT photo_path FROM voice_profiles WHERE id=?", (profile_id,),
        ).fetchone()
        if not current:
            raise HTTPException(
                status_code=404,
                detail="That voice profile doesn't exist. It may have been deleted from another tab.",
            )

    os.makedirs(PROFILE_PHOTOS_DIR, exist_ok=True)
    photo_filename = f"{profile_id}_photo{ext}"
    photo_path = os.path.join(PROFILE_PHOTOS_DIR, photo_filename)
    with open(photo_path, "wb") as f:
        f.write(await photo.read())

    old_photo = current["photo_path"]
    if old_photo and old_photo != photo_filename:
        old_path = os.path.join(PROFILE_PHOTOS_DIR, old_photo)
        if os.path.exists(old_path):
            os.remove(old_path)

    with db_conn() as conn:
        conn.execute(
            "UPDATE voice_profiles SET photo_path=? WHERE id=?",
            (photo_filename, profile_id),
        )
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    event_bus.emit("profiles", {"action": "updated", "id": profile_id})
    return dict(row)

@router.post("/profiles/{profile_id}/lock")
async def lock_profile(
    profile_id: str,
    history_id: str = Form(...),
    seed: Optional[int] = Form(None),
):
    with db_conn() as conn:
        profile = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
        if not profile:
            raise HTTPException(
                status_code=404,
                detail="Voice profile not found. It may have been deleted from another window — refresh the sidebar to see the current list.",
            )

        history = conn.execute("SELECT * FROM generation_history WHERE id=?", (history_id,)).fetchone()
        if not history or not history["audio_path"]:
            raise HTTPException(status_code=404, detail="History item not found or has no audio")

        src_path = os.path.join(OUTPUTS_DIR, history["audio_path"])
        if not os.path.exists(src_path):
            raise HTTPException(status_code=404, detail="Audio file not found on disk")

        locked_filename = f"{profile_id}_locked.wav"
        locked_path = os.path.join(VOICES_DIR, locked_filename)
        shutil.copy2(src_path, locked_path)

        ref_text = history["text"][:100] if history["text"] else ""

        conn.execute(
            "UPDATE voice_profiles SET locked_audio_path=?, seed=?, is_locked=1, ref_text=? WHERE id=?",
            (locked_filename, seed, ref_text, profile_id)
        )
    event_bus.emit("profiles", {"action": "locked", "id": profile_id})
    return {"locked": True, "profile_id": profile_id, "locked_audio_path": locked_filename}

@router.post("/profiles/{profile_id}/unlock")
async def unlock_profile(profile_id: str):
    with db_conn() as conn:
        profile = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
        if not profile:
            raise HTTPException(
                status_code=404,
                detail="Voice profile not found. It may have been deleted from another window — refresh the sidebar to see the current list.",
            )

        if profile["locked_audio_path"]:
            locked_path = os.path.join(VOICES_DIR, profile["locked_audio_path"])
            if os.path.exists(locked_path):
                os.remove(locked_path)

        conn.execute(
            "UPDATE voice_profiles SET locked_audio_path='', seed=NULL, is_locked=0 WHERE id=?",
            (profile_id,)
        )
    event_bus.emit("profiles", {"action": "unlocked", "id": profile_id})
    return {"unlocked": True, "profile_id": profile_id}

@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str):
    with db_conn() as conn:
        row = conn.execute("SELECT ref_audio_path, locked_audio_path, photo_path FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
        if row:
            for col in ["ref_audio_path", "locked_audio_path"]:
                if row[col]:
                    path = os.path.join(VOICES_DIR, row[col])
                    if os.path.exists(path):
                        os.remove(path)
            if row["photo_path"]:
                path = os.path.join(PROFILE_PHOTOS_DIR, row["photo_path"])
                if os.path.exists(path):
                    os.remove(path)
        # Prevent FOREIGN KEY constraint failure
        conn.execute("UPDATE generation_history SET profile_id = NULL WHERE profile_id=?", (profile_id,))
        conn.execute("DELETE FROM voice_profiles WHERE id=?", (profile_id,))
    event_bus.emit("profiles", {"action": "deleted", "id": profile_id})
    return {"deleted": profile_id}
