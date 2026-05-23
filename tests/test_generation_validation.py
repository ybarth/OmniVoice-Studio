import io
import os
import asyncio
import sys
import types
import wave

from fastapi import HTTPException
from fastapi.testclient import TestClient
os.environ.setdefault("OMNIVOICE_STORAGE_ROOT", "/private/tmp/omnivoice-test-storage")
os.environ.setdefault("OMNIVOICE_MODEL", "test")


def make_wav_bytes(duration_s=0.1, sample_rate=24000):
    n_samples = int(duration_s * sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * n_samples)
    buf.seek(0)
    return buf.read()


def test_uploaded_clone_requires_reference_transcript(monkeypatch):
    from main import app
    from api.routers import generation

    async def fake_get_model():
        raise AssertionError("model should not load without a reference transcript")

    monkeypatch.setattr(generation, "get_model", fake_get_model)

    client = TestClient(app, client=("127.0.0.1", 50000))
    res = client.post(
        "/generate",
        data={"text": "Hello from the prompt", "ref_text": "   "},
        files={"ref_audio": ("sample.wav", make_wav_bytes(), "audio/wav")},
    )

    assert res.status_code == 400
    assert "Reference Transcript" in res.json()["detail"]


def test_create_profile_returns_saved_profile_record():
    from main import app
    from core.db import init_db

    init_db()

    client = TestClient(app, client=("127.0.0.1", 50000))
    res = client.post(
        "/profiles",
        data={
            "name": "Saved Clone",
            "ref_text": "This is the exact recording transcript.",
            "instruct": "",
            "language": "English",
        },
        files={"ref_audio": ("sample.wav", make_wav_bytes(), "audio/wav")},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["id"]
    assert body["name"] == "Saved Clone"
    assert body["ref_audio_path"].endswith(".wav")
    assert body["ref_text"] == "This is the exact recording transcript."


def test_create_profile_treats_regular_speaking_style_as_no_instruct():
    from main import app
    from core.db import init_db

    init_db()

    client = TestClient(app, client=("127.0.0.1", 50000))
    res = client.post(
        "/profiles",
        data={
            "name": "Neutral Style Clone",
            "ref_text": "This is the exact recording transcript.",
            "instruct": "Regular speaking style. ",
            "language": "English",
        },
        files={"ref_audio": ("sample.wav", make_wav_bytes(), "audio/wav")},
    )

    assert res.status_code == 200
    assert res.json()["instruct"] == ""


def test_clone_generation_treats_regular_speaking_style_as_no_instruct(monkeypatch):
    from main import app
    from api.routers import generation

    async def fake_get_model():
        return object()

    def capture_instruct(
        model, text, language, ref_audio_path, ref_text, instruct, duration,
        *args,
    ):
        raise HTTPException(status_code=418, detail={"instruct": instruct})

    monkeypatch.setattr(generation, "get_model", fake_get_model)
    monkeypatch.setattr(generation, "_run_inference", capture_instruct)

    client = TestClient(app, client=("127.0.0.1", 50000))
    res = client.post(
        "/generate",
        data={
            "text": "Hello from the prompt",
            "ref_text": "This is the exact recording transcript.",
            "instruct": "Regular speaking style. ",
        },
        files={"ref_audio": ("sample.wav", make_wav_bytes(), "audio/wav")},
    )

    assert res.status_code == 418
    assert res.json()["detail"]["instruct"] is None


def test_generation_routes_engine_voice_to_tts_backend(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "python_multipart",
        types.SimpleNamespace(__version__="0.0.99"),
    )
    from api.routers import generation
    from core.db import init_db
    import torch

    init_db()
    captured = {}

    class DummyBackend:
        id = "dummy-engine"
        display_name = "Dummy Engine"

        @classmethod
        def is_available(cls):
            return True, "ready"

        @property
        def sample_rate(self):
            return 24000

        def generate(self, text, **kwargs):
            captured["text"] = text
            captured["kwargs"] = kwargs
            return torch.zeros(1, 2400)

    def fail_get_model():
        raise AssertionError("engine voice generation should not load the default model")

    monkeypatch.setattr(generation, "get_model", fail_get_model)
    monkeypatch.setattr(generation.tts_backend, "get_backend_class", lambda engine_id: DummyBackend)
    monkeypatch.setitem(
        sys.modules,
        "torchaudio",
        types.SimpleNamespace(
            save=lambda target, *_args, **_kwargs: (
                target.write(b"RIFFenginevoice")
                if hasattr(target, "write")
                else open(target, "wb").write(b"RIFFenginevoice")
            )
        ),
    )

    res = asyncio.run(
        generation.generate_speech(
            text="Read this document chunk",
            ref_audio=None,
            ref_text=None,
            instruct=None,
            duration=None,
            num_step=16,
            guidance_scale=2.0,
            engine_id="dummy-engine",
            voice="expr-voice-3-m",
            speaker_id="2",
            language="English",
            speed=1.1,
            t_shift=None,
            denoise=True,
            postprocess_output=True,
            layer_penalty_factor=None,
            position_temperature=None,
            class_temperature=None,
            profile_id=None,
            seed=None,
            request_id=None,
        )
    )

    assert res.media_type == "audio/wav"
    assert captured["text"] == "Read this document chunk"
    assert captured["kwargs"]["voice"] == "expr-voice-3-m"
    assert captured["kwargs"]["speaker_id"] == "2"
    assert captured["kwargs"]["language"] == "English"
    assert captured["kwargs"]["speed"] == 1.1


def test_clone_generation_normalizes_cantonese_language_for_tts(monkeypatch):
    from main import app
    from api.routers import generation

    async def fake_get_model():
        return object()

    def capture_language(
        model, text, language, ref_audio_path, ref_text, instruct, duration,
        *args,
    ):
        raise HTTPException(status_code=418, detail={"language": language, "text": text})

    monkeypatch.setattr(generation, "get_model", fake_get_model)
    monkeypatch.setattr(generation, "_run_inference", capture_language)

    client = TestClient(app, client=("127.0.0.1", 50000))
    res = client.post(
        "/generate",
        data={
            "text": "我喺香港講廣東話。",
            "language": "Cantonese",
            "ref_text": "This is the exact recording transcript.",
        },
        files={"ref_audio": ("sample.wav", make_wav_bytes(), "audio/wav")},
    )

    assert res.status_code == 418
    assert res.json()["detail"] == {
        "language": "yue",
        "text": "我喺香港講廣東話。",
    }


def test_clone_generation_applies_cantonese_tts_pronunciation_guard(monkeypatch):
    from main import app
    from api.routers import generation

    async def fake_get_model():
        return object()

    def capture_text(
        model, text, language, ref_audio_path, ref_text, instruct, duration,
        *args,
    ):
        raise HTTPException(status_code=418, detail={"language": language, "text": text})

    monkeypatch.setattr(generation, "get_model", fake_get_model)
    monkeypatch.setattr(generation, "_run_inference", capture_text)

    client = TestClient(app, client=("127.0.0.1", 50000))
    res = client.post(
        "/generate",
        data={
            "text": "這樣可以嗎？",
            "language": "Cantonese",
            "ref_text": "This is the exact recording transcript.",
        },
        files={"ref_audio": ("sample.wav", make_wav_bytes(), "audio/wav")},
    )

    assert res.status_code == 418
    assert res.json()["detail"] == {
        "language": "yue",
        "text": "咁樣得唔得？",
    }


def test_clone_generation_blocks_mandarin_like_text_for_cantonese_tts(monkeypatch):
    from main import app
    from api.routers import generation

    async def fake_get_model():
        raise AssertionError("model should not load for Mandarin-like Cantonese text")

    monkeypatch.setattr(generation, "get_model", fake_get_model)

    client = TestClient(app, client=("127.0.0.1", 50000))
    res = client.post(
        "/generate",
        data={
            "text": "我在香港說中文。",
            "language": "Cantonese",
            "ref_text": "This is the exact recording transcript.",
        },
        files={"ref_audio": ("sample.wav", make_wav_bytes(), "audio/wav")},
    )

    assert res.status_code == 400
    assert "spoken Hong Kong Cantonese" in res.json()["detail"]


def test_generation_status_endpoint_reports_idle_for_unknown_request():
    from main import app

    client = TestClient(app, client=("127.0.0.1", 50000))
    res = client.get("/generate/status/missing-request")

    assert res.status_code == 200
    body = res.json()
    assert body["request_id"] == "missing-request"
    assert body["status"] == "idle"
    assert body["phase"] == "idle"
    assert body["progress_pct"] is None


def test_profile_without_reference_transcript_requires_reference_transcript(monkeypatch):
    from main import app
    from api.routers import generation
    from core.db import init_db

    init_db()

    async def fake_get_model():
        raise AssertionError("model should not load without a reference transcript")

    monkeypatch.setattr(generation, "get_model", fake_get_model)

    client = TestClient(app, client=("127.0.0.1", 50000))
    created = client.post(
        "/profiles",
        data={
            "name": "Blank Transcript Clone",
            "ref_text": "",
            "instruct": "",
            "language": "English",
        },
        files={"ref_audio": ("sample.wav", make_wav_bytes(), "audio/wav")},
    )
    assert created.status_code == 200
    profile_id = created.json()["id"]

    res = client.post(
        "/generate",
        data={"text": "Only this prompt should condition the current request", "profile_id": profile_id},
    )

    assert res.status_code == 400
    assert "Reference Transcript" in res.json()["detail"]
