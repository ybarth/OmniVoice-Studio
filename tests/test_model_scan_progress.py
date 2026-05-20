from types import SimpleNamespace
import json


def test_model_scan_response_reports_complete_progress(monkeypatch):
    import api.routers.setup.models as models

    fake_models = [
        {"repo_id": "k2-fsa/OmniVoice", "label": "OmniVoice", "role": "TTS"},
        {"repo_id": "Systran/faster-whisper-large-v3", "label": "Whisper", "role": "ASR"},
    ]
    fake_repo = SimpleNamespace(
        repo_id="k2-fsa/OmniVoice",
        size_on_disk=1234,
        last_accessed=10,
        nb_files=3,
    )
    monkeypatch.setattr(models, "KNOWN_MODELS", fake_models)
    monkeypatch.setattr(models, "_current_platform_tags", lambda: ["darwin", "darwin-arm64"])

    response = models._build_models_response(SimpleNamespace(repos=[fake_repo]))
    status = models.get_model_scan_status()

    assert response["models"][0]["installed"] is True
    assert response["models"][1]["installed"] is False
    assert response["scan"]["status"] == "complete"
    assert response["scan"]["progress_pct"] == 100
    assert response["scan"]["scanned_models"] == 2
    assert response["scan"]["total_models"] == 2
    assert response["scan"]["installed_models"] == 1
    assert status["status"] == "complete"
    assert status["detail"] == "Scan complete"


def test_model_scan_status_resets_when_cache_invalidates():
    import api.routers.setup.models as models

    models.invalidate_cache()
    status = models.get_model_scan_status()

    assert status["status"] == "idle"
    assert status["progress_pct"] == 0
    assert status["current_repo_id"] is None


def test_model_scan_reports_related_cached_variants(monkeypatch):
    import api.routers.setup.models as models

    fake_models = [{
        "repo_id": "mlx-community/Kokoro-82M-bf16",
        "label": "Kokoro MLX",
        "role": "TTS",
        "related_repo_ids": ["hexgrad/Kokoro-82M"],
    }]
    fake_repo = SimpleNamespace(
        repo_id="hexgrad/Kokoro-82M",
        size_on_disk=4321,
        last_accessed=20,
        nb_files=4,
        cache_dir="/Volumes/T9/ai-models/huggingface-hub",
    )
    monkeypatch.setattr(models, "KNOWN_MODELS", fake_models)
    monkeypatch.setattr(models, "_current_platform_tags", lambda: ["darwin", "darwin-arm64"])

    response = models._build_models_response(SimpleNamespace(repos=[fake_repo]))
    row = response["models"][0]

    assert row["installed"] is False
    assert row["install_status"] == "related_found"
    assert row["related_installed"] is True
    assert row["related_repos"][0]["repo_id"] == "hexgrad/Kokoro-82M"
    assert row["related_repos"][0]["size_on_disk"] == 4321


def test_model_scan_reports_related_local_model_dirs(monkeypatch, tmp_path):
    import api.routers.setup.models as models

    fake_models = [{
        "repo_id": "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-4bit",
        "label": "Qwen3 VoiceDesign",
        "role": "TTS",
        "related_repo_ids": ["mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"],
    }]
    local_root = tmp_path / "lmstudio-models"
    local_model = local_root / "mlx-community" / "Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
    local_model.mkdir(parents=True)
    (local_model / "config.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(models, "KNOWN_MODELS", fake_models)
    monkeypatch.setattr(models, "hf_cache_dirs", lambda: [])
    monkeypatch.setattr(models, "_local_model_roots", lambda: [local_root])

    response = models._build_models_response(models._scan_all_cache_dirs())
    row = response["models"][0]

    assert row["installed"] is False
    assert row["install_status"] == "related_found"
    assert row["related_repos"][0]["repo_id"] == "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
    assert row["related_repos"][0]["source"] == "local_dir"


def test_is_cached_rejects_incomplete_sharded_hf_snapshot(monkeypatch, tmp_path):
    import api.routers.setup.models as models

    cache_dir = tmp_path / "hub"
    snapshot = cache_dir / "models--tencent--HY-MT1.5-7B" / "snapshots" / "abc123"
    snapshot.mkdir(parents=True)
    (snapshot / "model.safetensors.index.json").write_text(
        json.dumps({
            "weight_map": {
                "layer.0": "model-00001-of-00002.safetensors",
                "layer.1": "model-00002-of-00002.safetensors",
            }
        }),
        encoding="utf-8",
    )
    (snapshot / "model-00002-of-00002.safetensors").write_bytes(b"ok")
    fake_repo = SimpleNamespace(
        repo_id="tencent/HY-MT1.5-7B",
        size_on_disk=1024,
        last_accessed=20,
        nb_files=2,
        cache_dir=str(cache_dir),
        source="hf_cache",
    )
    monkeypatch.setattr(models, "hf_cache_dirs", lambda: [str(cache_dir)])
    monkeypatch.setattr(models, "_scan_all_cache_dirs", lambda: SimpleNamespace(repos=[fake_repo]))

    assert models.is_cached("tencent/HY-MT1.5-7B") is False
