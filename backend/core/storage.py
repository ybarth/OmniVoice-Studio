"""Storage location helpers for local app data and heavyweight caches."""
from __future__ import annotations

import os
import sys
from pathlib import Path


DEFAULT_T9_VOLUME = "/Volumes/T9"
STORAGE_DIR_NAME = "OmniVoice"


def _expanded(path: str | os.PathLike[str]) -> Path:
    return Path(path).expanduser()


def t9_volume_path() -> str:
    return str(_expanded(os.environ.get("OMNIVOICE_T9_VOLUME", DEFAULT_T9_VOLUME)))


def _is_writable_directory(path: Path) -> bool:
    try:
        return path.is_dir() and os.access(path, os.W_OK | os.X_OK)
    except OSError:
        return False


def external_storage_root() -> str | None:
    """Return the preferred external storage root, if one is available."""
    explicit = os.environ.get("OMNIVOICE_STORAGE_ROOT")
    if explicit:
        return str(_expanded(explicit))

    volume = _expanded(t9_volume_path())
    if _is_writable_directory(volume):
        return str(volume / STORAGE_DIR_NAME)
    return None


def _platform_app_data_dir() -> str:
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/OmniVoice")
    if sys.platform == "win32":
        return os.path.join(os.environ.get("APPDATA", ""), "OmniVoice")
    return os.path.expanduser("~/.omnivoice")


def get_app_data_dir() -> str:
    custom_dir = os.environ.get("OMNIVOICE_DATA_DIR")
    if custom_dir:
        return str(_expanded(custom_dir))
    return external_storage_root() or _platform_app_data_dir()


def _cache_override_dir() -> str | None:
    override = os.environ.get("OMNIVOICE_CACHE_DIR")
    return str(_expanded(override)) if override else None


def get_hf_cache_dir() -> str:
    """Return the Hugging Face hub cache directory used for model installs."""
    if os.environ.get("HF_HUB_CACHE"):
        return str(_expanded(os.environ["HF_HUB_CACHE"]))
    if os.environ.get("HUGGINGFACE_HUB_CACHE"):
        return str(_expanded(os.environ["HUGGINGFACE_HUB_CACHE"]))
    if os.environ.get("OMNIVOICE_CACHE_DIR"):
        return str(_expanded(os.environ["OMNIVOICE_CACHE_DIR"]))
    if os.environ.get("HF_HOME"):
        return str(_expanded(os.environ["HF_HOME"]) / "hub")

    root = external_storage_root()
    if root:
        return str(_expanded(root) / "huggingface" / "hub")
    return os.path.expanduser("~/.cache/huggingface/hub")


def _split_extra_cache_dirs(value: str) -> list[str]:
    parts: list[str] = []
    for chunk in value.replace(",", os.pathsep).split(os.pathsep):
        chunk = chunk.strip()
        if chunk:
            parts.append(chunk)
    return parts


def _append_unique(paths: list[str], candidate: Path, *, require_exists: bool = True) -> None:
    if require_exists and not candidate.is_dir():
        return
    value = str(candidate)
    if value not in paths:
        paths.append(value)


def get_hf_cache_dirs() -> list[str]:
    """Return HF cache directories worth scanning, primary install cache first."""
    paths: list[str] = []
    _append_unique(paths, _expanded(get_hf_cache_dir()), require_exists=False)

    extra = os.environ.get("OMNIVOICE_EXTRA_HF_CACHE_DIRS")
    if extra:
        for path in _split_extra_cache_dirs(extra):
            _append_unique(paths, _expanded(path))

    volume = _expanded(t9_volume_path())
    if volume.is_dir():
        # Many local model libraries use a shared Hugging Face cache outside
        # OmniVoice's managed app cache. Scan it for visibility without making
        # installs land there.
        _append_unique(paths, volume / "ai-models" / "huggingface-hub")
        _append_unique(paths, volume / "ai-models" / "huggingface-hub" / "hub")

    return paths


def configure_storage_environment() -> dict:
    """Set default env vars so heavy runtime data lands on external storage.

    Explicit user env vars win. T9 only supplies defaults when no existing
    ``OMNIVOICE_*`` / Hugging Face / Torch location has been chosen.
    """
    root = external_storage_root()
    cache_override = _cache_override_dir()

    if root:
        root_path = _expanded(root)
        root_path.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("OMNIVOICE_DATA_DIR", str(root_path))

    if cache_override:
        cache_path = _expanded(cache_override)
        cache_path.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(cache_path))
        os.environ.setdefault("HF_HUB_CACHE", str(cache_path))
        os.environ.setdefault("TORCH_HOME", str(cache_path))
    elif root:
        root_path = _expanded(root)
        hf_home = root_path / "huggingface"
        hf_cache = hf_home / "hub"
        torch_home = root_path / "torch"
        if not (
            os.environ.get("HF_HOME")
            or os.environ.get("HF_HUB_CACHE")
            or os.environ.get("HUGGINGFACE_HUB_CACHE")
        ):
            hf_cache.mkdir(parents=True, exist_ok=True)
            os.environ.setdefault("HF_HOME", str(hf_home))
            os.environ.setdefault("HF_HUB_CACHE", str(hf_cache))
        if not os.environ.get("TORCH_HOME"):
            torch_home.mkdir(parents=True, exist_ok=True)
            os.environ.setdefault("TORCH_HOME", str(torch_home))

    return storage_status()


def _is_relative_to(path: str, parent: str) -> bool:
    try:
        _expanded(path).resolve().relative_to(_expanded(parent).resolve())
        return True
    except (OSError, ValueError):
        return False


def storage_status() -> dict:
    root = external_storage_root()
    data_dir = get_app_data_dir()
    hf_cache = get_hf_cache_dir()
    uses_external = bool(
        root and (_is_relative_to(data_dir, root) or _is_relative_to(hf_cache, root))
    )
    return {
        "storage_root": root,
        "storage_volume": t9_volume_path(),
        "using_external_storage": uses_external,
        "storage_external": uses_external,
        "data_dir": data_dir,
        "hf_cache_dir": hf_cache,
    }
