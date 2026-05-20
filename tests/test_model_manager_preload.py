from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest


@pytest.fixture
def model_manager(monkeypatch, tmp_path):
    monkeypatch.delenv("OMNIVOICE_DATA_DIR", raising=False)
    monkeypatch.delenv("OMNIVOICE_CACHE_DIR", raising=False)
    monkeypatch.delenv("HF_HOME", raising=False)
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_CACHE", raising=False)
    monkeypatch.setenv("OMNIVOICE_STORAGE_ROOT", str(tmp_path / "omnivoice"))

    for mod_name in ("core.config", "services.model_manager"):
        sys.modules.pop(mod_name, None)

    import services.model_manager as mm

    monkeypatch.setattr(mm, "_torch", None)
    monkeypatch.setattr(mm, "_OmniVoice", None)
    monkeypatch.setattr(mm, "model", None)
    monkeypatch.setenv("OMNIVOICE_MODEL", "test/checkpoint")
    return mm


def test_tts_asr_preload_is_opt_in(model_manager, monkeypatch):
    monkeypatch.delenv("OMNIVOICE_PRELOAD_TTS_ASR", raising=False)
    assert model_manager.should_preload_tts_asr() is False

    for value in ("1", "true", "TRUE", "yes", "on"):
        monkeypatch.setenv("OMNIVOICE_PRELOAD_TTS_ASR", value)
        assert model_manager.should_preload_tts_asr() is True

    monkeypatch.setenv("OMNIVOICE_PRELOAD_TTS_ASR", "0")
    assert model_manager.should_preload_tts_asr() is False


def test_load_model_skips_pytorch_whisper_by_default(model_manager, monkeypatch):
    calls = []

    class DummyOmniVoice:
        @staticmethod
        def from_pretrained(*args, **kwargs):
            calls.append((args, kwargs))
            return SimpleNamespace(llm=object())

    monkeypatch.delenv("OMNIVOICE_PRELOAD_TTS_ASR", raising=False)
    monkeypatch.setattr(model_manager, "_lazy_torch", lambda: SimpleNamespace(float16="float16"))
    monkeypatch.setattr(model_manager, "_lazy_omnivoice", lambda: DummyOmniVoice)
    monkeypatch.setattr(model_manager, "get_best_device", lambda: "mps")

    loaded = model_manager._load_model_sync()

    assert loaded.llm is not None
    assert calls == [
        (
            ("test/checkpoint",),
            {"device_map": "mps", "dtype": "float16", "load_asr": False},
        )
    ]


def test_load_model_can_preload_pytorch_whisper_when_requested(model_manager, monkeypatch):
    calls = []

    class DummyOmniVoice:
        @staticmethod
        def from_pretrained(*args, **kwargs):
            calls.append((args, kwargs))
            return SimpleNamespace(llm=object())

    monkeypatch.setenv("OMNIVOICE_PRELOAD_TTS_ASR", "1")
    monkeypatch.setattr(model_manager, "_lazy_torch", lambda: SimpleNamespace(float16="float16"))
    monkeypatch.setattr(model_manager, "_lazy_omnivoice", lambda: DummyOmniVoice)
    monkeypatch.setattr(model_manager, "get_best_device", lambda: "mps")

    model_manager._load_model_sync()

    assert calls[0][1]["load_asr"] is True


def test_model_status_does_not_report_stale_ready_when_unloaded(model_manager):
    model_manager.model = None
    model_manager._loading_detail.update({
        "sub_stage": "ready",
        "detail": "Model ready",
        "error": None,
        "progress": 100,
    })

    status = model_manager.get_model_status()

    assert status["status"] == "idle"
    assert "detail" not in status
    assert "progress" not in status


@pytest.mark.asyncio
async def test_get_model_uses_internal_gpu_pool_accessor(model_manager, monkeypatch):
    loaded = SimpleNamespace(name="loaded-model")
    calls = []

    class InlineExecutor:
        def submit(self, fn, *args, **kwargs):
            from concurrent.futures import Future

            calls.append(fn)
            fut = Future()
            try:
                fut.set_result(fn(*args, **kwargs))
            except Exception as exc:
                fut.set_exception(exc)
            return fut

    monkeypatch.setattr(model_manager, "_get_gpu_pool", lambda: InlineExecutor())
    monkeypatch.setattr(model_manager, "_load_model_sync", lambda: loaded)

    assert await model_manager.get_model() is loaded
    assert calls == [model_manager._load_model_sync]
