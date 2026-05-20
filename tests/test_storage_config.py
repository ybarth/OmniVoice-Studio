import importlib
import os
from pathlib import Path


_STORAGE_ENV = [
    "OMNIVOICE_STORAGE_ROOT",
    "OMNIVOICE_DATA_DIR",
    "OMNIVOICE_CACHE_DIR",
    "HF_HOME",
    "HF_HUB_CACHE",
    "HUGGINGFACE_HUB_CACHE",
    "TORCH_HOME",
]


def _load_storage(monkeypatch, t9_volume: Path):
    for key in _STORAGE_ENV:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("OMNIVOICE_T9_VOLUME", str(t9_volume))
    import core.storage as storage

    return importlib.reload(storage)


def test_t9_volume_becomes_default_storage_root(tmp_path, monkeypatch):
    t9_volume = tmp_path / "T9"
    t9_volume.mkdir()
    storage = _load_storage(monkeypatch, t9_volume)

    assert storage.external_storage_root() == str(t9_volume / "OmniVoice")
    assert storage.get_app_data_dir() == str(t9_volume / "OmniVoice")


def test_explicit_data_dir_overrides_t9_default(tmp_path, monkeypatch):
    t9_volume = tmp_path / "T9"
    t9_volume.mkdir()
    custom_data = tmp_path / "custom-data"
    storage = _load_storage(monkeypatch, t9_volume)
    monkeypatch.setenv("OMNIVOICE_DATA_DIR", str(custom_data))

    assert storage.get_app_data_dir() == str(custom_data)


def test_configure_storage_environment_routes_heavy_caches_to_t9(tmp_path, monkeypatch):
    t9_volume = tmp_path / "T9"
    t9_volume.mkdir()
    storage = _load_storage(monkeypatch, t9_volume)

    info = storage.configure_storage_environment()

    expected_root = t9_volume / "OmniVoice"
    assert info["using_external_storage"] is True
    assert info["storage_root"] == str(expected_root)
    assert info["hf_cache_dir"] == str(expected_root / "huggingface" / "hub")
    assert Path(storage.os.environ["OMNIVOICE_DATA_DIR"]) == expected_root
    assert Path(storage.os.environ["HF_HOME"]) == expected_root / "huggingface"
    assert Path(storage.os.environ["HF_HUB_CACHE"]) == expected_root / "huggingface" / "hub"
    assert Path(storage.os.environ["TORCH_HOME"]) == expected_root / "torch"
    assert (expected_root / "huggingface" / "hub").is_dir()


def test_existing_hf_cache_override_is_preserved(tmp_path, monkeypatch):
    t9_volume = tmp_path / "T9"
    t9_volume.mkdir()
    custom_cache = tmp_path / "hf-cache"
    storage = _load_storage(monkeypatch, t9_volume)
    monkeypatch.setenv("HF_HUB_CACHE", str(custom_cache))

    info = storage.configure_storage_environment()

    assert info["using_external_storage"] is True
    assert info["hf_cache_dir"] == str(custom_cache)
    assert storage.os.environ["HF_HUB_CACHE"] == str(custom_cache)


def test_hf_cache_dirs_include_shared_t9_model_library(tmp_path, monkeypatch):
    t9_volume = tmp_path / "T9"
    t9_volume.mkdir()
    shared_cache = t9_volume / "ai-models" / "huggingface-hub"
    shared_cache.mkdir(parents=True)
    storage = _load_storage(monkeypatch, t9_volume)

    dirs = storage.get_hf_cache_dirs()

    assert dirs[0] == str(t9_volume / "OmniVoice" / "huggingface" / "hub")
    assert str(shared_cache) in dirs


def test_hf_cache_dirs_include_explicit_extra_dirs(tmp_path, monkeypatch):
    t9_volume = tmp_path / "T9"
    t9_volume.mkdir()
    extra_a = tmp_path / "hf-a"
    extra_b = tmp_path / "hf-b"
    extra_a.mkdir()
    extra_b.mkdir()
    storage = _load_storage(monkeypatch, t9_volume)
    monkeypatch.setenv(
        "OMNIVOICE_EXTRA_HF_CACHE_DIRS",
        f"{extra_a}{os.pathsep}{extra_b}",
    )

    dirs = storage.get_hf_cache_dirs()

    assert str(extra_a) in dirs
    assert str(extra_b) in dirs
