"""Model catalog, platform detection, and cache introspection.

Extracted from the monolithic ``setup.py`` to keep concerns separate:
- ``KNOWN_MODELS`` loaded from ``config/models.yaml``
- ``GET /models`` endpoint (with 10 s response cache)
- ``GET /setup/recommendations`` device-aware preset endpoint
- ``ModelCatalog`` dependency for use with ``Depends()``
"""
from __future__ import annotations

import json
import logging
import platform as _platform
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

from fastapi import APIRouter, Depends
from core.storage import get_hf_cache_dir, get_hf_cache_dirs, t9_volume_path

logger = logging.getLogger("omnivoice.setup.models")
router = APIRouter()

# ── Model Catalog (loaded from YAML) ──────────────────────────────────────

_YAML_PATH = Path(__file__).resolve().parents[3] / "config" / "models.yaml"


def _load_models_from_yaml() -> list[dict]:
    """Load model catalog from config/models.yaml.

    Falls back to an empty list if the file is missing or unreadable.
    The YAML file is read once at import time — restart to pick up edits.
    """
    try:
        import yaml  # PyYAML is already a transitive dep of huggingface_hub
        with open(_YAML_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        models = data.get("models", [])
        logger.info("Loaded %d models from %s", len(models), _YAML_PATH)
        return models
    except FileNotFoundError:
        logger.warning("models.yaml not found at %s — using empty catalog", _YAML_PATH)
        return []
    except Exception as e:
        logger.error("Failed to load models.yaml: %s — using empty catalog", e)
        return []


KNOWN_MODELS = _load_models_from_yaml()

# Back-compat tuple view for code that expects (repo_id, label) pairs.
REQUIRED_MODELS = [(m["repo_id"], m["label"]) for m in KNOWN_MODELS if m.get("required")]


# ── Dependency Injection ───────────────────────────────────────────────────
# Use `catalog: ModelCatalog = Depends(get_model_catalog)` in endpoint params
# for testable, mockable access to the model registry.

class ModelCatalog:
    """Injectable service wrapping the model catalog + cache scanner."""

    def __init__(self, models: list[dict] | None = None):
        self.models = models if models is not None else KNOWN_MODELS
        self._by_id = {m["repo_id"]: m for m in self.models}
        self._required = [(m["repo_id"], m["label"]) for m in self.models if m.get("required")]

    def get(self, repo_id: str) -> dict | None:
        return self._by_id.get(repo_id)

    @property
    def required(self) -> list[tuple[str, str]]:
        return self._required

    @property
    def all(self) -> list[dict]:
        return self.models

    def supported_on_host(self, model: dict) -> bool:
        return _model_supported(model)


# Singleton — shared across all requests.
_catalog = ModelCatalog()


def get_model_catalog() -> ModelCatalog:
    """FastAPI dependency — inject with ``Depends(get_model_catalog)``."""
    return _catalog


# ── Platform Detection ─────────────────────────────────────────────────────

def _current_platform_tags() -> list[str]:
    """Return platform tags that the current host supports."""
    tags = [sys.platform]
    arch = _platform.machine()
    tags.append(f"{sys.platform}-{arch}")
    try:
        import torch
        if torch.cuda.is_available():
            tags.append("cuda")
    except Exception:
        pass
    return tags


def _model_supported(model: dict) -> bool:
    """Check if a model is supported on the current platform."""
    plats = model.get("platforms")
    if not plats:
        return True
    return bool(set(plats) & set(_current_platform_tags()))


# ── HF Cache Helpers ───────────────────────────────────────────────────────

def hf_cache_dir() -> str:
    return get_hf_cache_dir()


def hf_cache_dirs() -> list[str]:
    return get_hf_cache_dirs()


def _local_model_roots() -> list[Path]:
    volume = Path(t9_volume_path()).expanduser()
    if not volume.is_dir():
        return []
    return [
        volume / "ai-models" / "lmstudio-models",
        volume / "ai-models" / "adaptive-cua" / "models",
    ]


def _local_repo_id_from_dir(root: Path, path: Path) -> str | None:
    try:
        rel = path.relative_to(root)
    except ValueError:
        return None
    parts = rel.parts
    if len(parts) == 2:
        return f"{parts[0]}/{parts[1]}"
    if len(parts) == 1 and "_" in parts[0]:
        return parts[0].replace("_", "/", 1)
    return None


def _local_model_entries():
    entries = []
    for root in _local_model_roots():
        if not root.is_dir():
            continue
        candidates: list[Path] = []
        try:
            for child in root.iterdir():
                if not child.is_dir():
                    continue
                if "_" in child.name:
                    candidates.append(child)
                for grandchild in child.iterdir():
                    if grandchild.is_dir():
                        candidates.append(grandchild)
        except OSError:
            continue

        for path in candidates:
            repo_id = _local_repo_id_from_dir(root, path)
            if not repo_id:
                continue
            try:
                size = max(path.stat().st_size, 1)
                modified = path.stat().st_mtime
            except OSError:
                size = 1
                modified = None
            entries.append(SimpleNamespace(
                repo_id=repo_id,
                size_on_disk=size,
                last_accessed=modified,
                nb_files=0,
                cache_dir=str(path),
                source="local_dir",
            ))
    return entries


def _scan_all_cache_dirs():
    """Scan every visible HF cache root, preserving the active cache first."""
    from huggingface_hub import scan_cache_dir

    repos = []
    scanned_dirs: list[str] = []
    errors: list[str] = []
    for cache_dir in hf_cache_dirs():
        try:
            info = scan_cache_dir(cache_dir=cache_dir)
        except Exception as e:
            errors.append(f"{cache_dir}: {e}")
            continue
        scanned_dirs.append(cache_dir)
        for entry in list(getattr(info, "repos", []) or []):
            repos.append(SimpleNamespace(
                repo_id=entry.repo_id,
                size_on_disk=entry.size_on_disk,
                last_accessed=entry.last_accessed,
                nb_files=entry.nb_files,
                cache_dir=cache_dir,
                source="hf_cache",
            ))
    repos.extend(_local_model_entries())
    return SimpleNamespace(repos=repos, cache_dirs=scanned_dirs, errors=errors)


_WEIGHT_INDEX_FILES = (
    "model.safetensors.index.json",
    "pytorch_model.bin.index.json",
)

_WEIGHT_FILE_PATTERNS = (
    "*.safetensors",
    "*.bin",
    "*.gguf",
    "*.onnx",
    "*.pt",
    "*.pth",
)


def _repo_cache_name(repo_id: str) -> str:
    return f"models--{repo_id.replace('/', '--')}"


def _material_file(path: Path) -> bool:
    """True when a snapshot file resolves to a real, non-empty blob."""
    try:
        return path.is_file() and path.stat().st_size > 0 and not path.name.endswith(".incomplete")
    except OSError:
        return False


def _snapshot_weight_complete(snapshot: Path) -> bool:
    """Detect partially-downloaded sharded HF snapshots.

    `scan_cache_dir()` includes incomplete blobs in repo size totals. That can
    make a cancelled xet/LFS download look installed even though
    `from_pretrained()` will block trying to fetch missing shards. If an index
    exists, every referenced shard must resolve to a real blob.
    """
    for index_name in _WEIGHT_INDEX_FILES:
        index_path = snapshot / index_name
        if not _material_file(index_path):
            continue
        try:
            data = json.loads(index_path.read_text(encoding="utf-8"))
        except Exception:
            return False
        shards = {
            str(name)
            for name in (data.get("weight_map") or {}).values()
            if name
        }
        if shards:
            return all(_material_file(snapshot / shard) for shard in shards)

    candidates: list[Path] = []
    for pattern in _WEIGHT_FILE_PATTERNS:
        candidates.extend(snapshot.glob(pattern))
    if candidates:
        return any(_material_file(path) for path in candidates)
    return True


def _repo_has_complete_snapshot(repo_id: str, cache_dirs: list[str] | None = None) -> bool:
    checked_any = False
    for cache_dir in cache_dirs or hf_cache_dirs():
        repo_root = Path(cache_dir) / _repo_cache_name(repo_id)
        snapshots_root = repo_root / "snapshots"
        if not snapshots_root.is_dir():
            continue
        checked_any = True
        candidates: list[Path] = []
        ref_main = repo_root / "refs" / "main"
        try:
            ref = ref_main.read_text(encoding="utf-8").strip()
        except OSError:
            ref = ""
        if ref:
            candidates.append(snapshots_root / ref)
        try:
            candidates.extend(path for path in snapshots_root.iterdir() if path.is_dir())
        except OSError:
            continue

        seen: set[Path] = set()
        for snapshot in candidates:
            if snapshot in seen or not snapshot.is_dir():
                continue
            seen.add(snapshot)
            if _snapshot_weight_complete(snapshot):
                return True
    return not checked_any


def _entry_incomplete(entry) -> bool:
    if getattr(entry, "source", "hf_cache") != "hf_cache":
        return False
    cache_dir = getattr(entry, "cache_dir", None)
    cache_dirs = [cache_dir] if cache_dir else None
    return not _repo_has_complete_snapshot(entry.repo_id, cache_dirs)


def is_cached(repo_id: str) -> bool:
    """Best-effort check: does HF have this repo in its cache on disk?"""
    try:
        info = _scan_all_cache_dirs()
        for entry in info.repos:
            if entry.repo_id == repo_id and entry.size_on_disk > 0 and not _entry_incomplete(entry):
                return True
        return False
    except Exception as e:
        logger.debug("scan_cache_dir failed: %s", e)
        return False


# ── Response Cache ─────────────────────────────────────────────────────────
# Simple TTL dict cache to avoid re-scanning the HF cache directory on every
# frontend poll.  Entries expire after ``_CACHE_TTL`` seconds.

_CACHE_TTL = 10.0  # seconds
_cache: dict[str, tuple[float, object]] = {}
_SCAN_LOCK = threading.Lock()
_SCAN_STATUS: dict[str, object] = {
    "status": "idle",
    "stage": "idle",
    "detail": "Waiting to scan model cache",
    "progress_pct": 0,
    "cache_dir": hf_cache_dir(),
    "cache_dirs": hf_cache_dirs(),
    "current_repo_id": None,
    "total_models": len(KNOWN_MODELS),
    "scanned_models": 0,
    "cached_repos": 0,
    "installed_models": 0,
    "started_at": None,
    "finished_at": None,
    "elapsed_ms": 0,
    "error": None,
}


def _cached(key: str, ttl: float = _CACHE_TTL):
    """Return cached value if still valid, else None."""
    entry = _cache.get(key)
    if entry and (time.monotonic() - entry[0]) < ttl:
        return entry[1]
    return None


def _set_cache(key: str, value: object) -> None:
    _cache[key] = (time.monotonic(), value)


def invalidate_cache() -> None:
    """Called after install/delete to bust the models cache."""
    _cache.clear()
    _set_scan_status(
        status="idle",
        stage="idle",
        detail="Waiting to scan model cache",
        progress_pct=0,
        current_repo_id=None,
        total_models=len(KNOWN_MODELS),
        scanned_models=0,
        cached_repos=0,
        installed_models=0,
        started_at=None,
        finished_at=None,
        elapsed_ms=0,
        error=None,
    )


def _set_scan_status(**updates) -> dict:
    """Update and return a thread-safe snapshot of the model scan state."""
    with _SCAN_LOCK:
        _SCAN_STATUS.update(updates)
        _SCAN_STATUS["cache_dir"] = hf_cache_dir()
        _SCAN_STATUS["cache_dirs"] = hf_cache_dirs()
        started = _SCAN_STATUS.get("started_at")
        finished = _SCAN_STATUS.get("finished_at")
        if started:
            end = finished or time.time()
            _SCAN_STATUS["elapsed_ms"] = max(0, round((end - started) * 1000))
        return dict(_SCAN_STATUS)


def get_model_scan_status() -> dict:
    """Return current model cache scan progress for polling UI."""
    return _set_scan_status()


def _scan_progress(scanned: int, total: int) -> int:
    if total <= 0:
        return 100
    # Reserve 0-20 for cache walking and 96-100 for finalization.
    return min(96, 20 + round((scanned / total) * 76))


def _repo_snapshot(entry) -> dict:
    return {
        "size_on_disk": entry.size_on_disk,
        "last_accessed": entry.last_accessed,
        "nb_files": entry.nb_files,
        "cache_dir": getattr(entry, "cache_dir", None),
        "source": getattr(entry, "source", "hf_cache"),
        "incomplete": _entry_incomplete(entry),
    }


def _cached_repos_from_scan(info) -> dict[str, dict]:
    cached_by_repo: dict[str, dict] = {}
    repos = list(getattr(info, "repos", []) or [])
    _set_scan_status(
        status="scanning",
        stage="matching_models",
        detail=f"Matched {len(repos)} cached repos; checking known models",
        cached_repos=len(repos),
        progress_pct=20,
    )
    for entry in repos:
        cached = _repo_snapshot(entry)
        previous = cached_by_repo.get(entry.repo_id)
        if previous is None or cached["size_on_disk"] > previous["size_on_disk"]:
            cached_by_repo[entry.repo_id] = cached
    return cached_by_repo


def _related_repos_for_model(model: dict, cached_by_repo: dict[str, dict]) -> list[dict]:
    related = []
    for repo_id in model.get("related_repo_ids", []) or []:
        cached = cached_by_repo.get(repo_id)
        if cached and cached["size_on_disk"] > 0 and not cached.get("incomplete"):
            related.append({"repo_id": repo_id, **cached})
    return related


def _build_models_response(
    scan_info,
    *,
    final_status: str = "complete",
    final_stage: str = "complete",
    final_detail: str = "Scan complete",
    error: str | None = None,
) -> dict:
    cached_by_repo = _cached_repos_from_scan(scan_info)
    total_models = len(KNOWN_MODELS)
    out = []
    installed_models = 0

    for idx, m in enumerate(KNOWN_MODELS, start=1):
        repo_id = m["repo_id"]
        cached = cached_by_repo.get(repo_id)
        installed = cached is not None and cached["size_on_disk"] > 0 and not cached.get("incomplete")
        related_repos = _related_repos_for_model(m, cached_by_repo)
        related_installed = bool(related_repos)
        install_status = (
            "installed" if installed
            else "related_found" if related_installed
            else "not_installed"
        )
        installed_models += 1 if installed else 0
        _set_scan_status(
            status="scanning",
            stage="matching_models",
            detail=f"Checking {m.get('label') or repo_id}",
            current_repo_id=repo_id,
            scanned_models=idx,
            total_models=total_models,
            installed_models=installed_models,
            progress_pct=_scan_progress(idx, total_models),
        )
        out.append({
            **m,
            "installed": installed,
            "install_status": install_status,
            "size_on_disk_bytes": cached["size_on_disk"] if cached else 0,
            "nb_files": cached["nb_files"] if cached else 0,
            "cache_dir": cached["cache_dir"] if cached else None,
            "related_installed": related_installed,
            "related_repos": related_repos,
            "supported": _model_supported(m),
        })

    total_installed = sum(m["size_on_disk_bytes"] for m in out)
    _set_scan_status(
        status=final_status,
        stage=final_stage,
        detail=final_detail,
        current_repo_id=None,
        scanned_models=total_models,
        total_models=total_models,
        installed_models=installed_models,
        progress_pct=100,
        finished_at=time.time(),
        error=error,
    )
    response = {
        "models": out,
        "total_installed_bytes": total_installed,
        "hf_cache_dir": hf_cache_dir(),
        "hf_cache_dirs": list(getattr(scan_info, "cache_dirs", []) or hf_cache_dirs()),
        "platform_tags": _current_platform_tags(),
        "scan": get_model_scan_status(),
    }
    return response


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/models/scan-status")
def model_scan_status():
    """Current progress for the most recent /models cache scan."""
    return get_model_scan_status()


@router.get("/models")
def list_models():
    """Catalogue every known model + its on-disk install state.

    Uses a 10 s response cache to avoid repeated ``scan_cache_dir()`` disk
    walks when the frontend polls.
    """
    cached_response = _cached("models")
    if cached_response is not None:
        return cached_response

    try:
        _set_scan_status(
            status="scanning",
            stage="walking_cache",
            detail=f"Scanning {len(hf_cache_dirs())} model cache locations",
            progress_pct=8,
            cache_dir=hf_cache_dir(),
            cache_dirs=hf_cache_dirs(),
            current_repo_id=None,
            total_models=len(KNOWN_MODELS),
            scanned_models=0,
            cached_repos=0,
            installed_models=0,
            started_at=time.time(),
            finished_at=None,
            elapsed_ms=0,
            error=None,
        )
        info = _scan_all_cache_dirs()
        scan_errors = list(getattr(info, "errors", []) or [])
        response = _build_models_response(
            info,
            final_detail=(
                "Scan complete"
                if not scan_errors
                else f"Scan complete with {len(scan_errors)} cache warning"
                     f"{'' if len(scan_errors) == 1 else 's'}"
            ),
            error="; ".join(scan_errors) if scan_errors else None,
        )
    except Exception as e:
        logger.warning("scan_cache_dir failed: %s", e)
        response = _build_models_response(
            type("ScanInfo", (), {"repos": []})(),
            final_status="error",
            final_stage="error",
            final_detail="Scan failed",
            error=str(e),
        )
    _set_cache("models", response)
    return response


@router.get("/setup/recommendations")
def recommendations():
    """Return a curated model preset for the caller's device + architecture."""
    is_mac_arm = sys.platform == "darwin" and _platform.machine() == "arm64"
    is_mac_intel = sys.platform == "darwin" and _platform.machine() == "x86_64"
    is_linux = sys.platform.startswith("linux")
    is_windows = sys.platform == "win32"

    has_cuda = False
    try:
        import torch
        has_cuda = bool(torch.cuda.is_available())
    except Exception:
        pass

    # Device label — used as the card title.
    if is_mac_arm:
        device_label = f"Apple Silicon ({_platform.machine()})"
    elif is_mac_intel:
        device_label = "macOS Intel (x86_64)"
    elif is_windows:
        device_label = "Windows x64" + (" + CUDA" if has_cuda else "")
    elif is_linux:
        device_label = "Linux x64" + (" + CUDA" if has_cuda else "")
    else:
        device_label = f"{sys.platform} / {_platform.machine()}"

    # Pick the preset for this device.
    if is_mac_arm:
        recommended_ids = [
            "k2-fsa/OmniVoice",
            "Systran/faster-whisper-large-v3",
            "mlx-community/whisper-large-v3-mlx",
            "mlx-community/whisper-large-v3-turbo",
            "mlx-community/Kokoro-82M-bf16",
            "KittenML/kitten-tts-mini-0.8",
        ]
        rationale = (
            "Apple Silicon gets the full stack: OmniVoice for multilingual clone + "
            "WhisperX (faster-whisper weights) for cross-platform ASR + MLX-Whisper "
            "for the Apple-optimised speedup + Whisper Turbo (5× faster) for live "
            "dictation + Kokoro (mlx-audio) for fast local English + KittenTTS as "
            "a CPU-realtime backup."
        )
    else:
        recommended_ids = [
            "k2-fsa/OmniVoice",
            "Systran/faster-whisper-large-v3",
            "KittenML/kitten-tts-mini-0.8",
        ]
        if has_cuda:
            recommended_ids.append("openai/whisper-large-v3")
            rationale = (
                "Cross-platform stack + pytorch-whisper as a CUDA-accelerated "
                "ASR fallback. MLX / mlx-audio are Apple-Silicon-only and don't "
                "apply here."
            )
        else:
            rationale = (
                "Cross-platform stack: OmniVoice (multilingual clone) + WhisperX "
                "(faster-whisper ASR) + KittenTTS (English turbo, CPU-realtime). "
                "Clean install, every model runs on CPU."
            )

    known_by_id = {m["repo_id"]: m for m in KNOWN_MODELS}
    cached_ids: set[str] = set()
    try:
        info = _scan_all_cache_dirs()
        cached_ids = {
            entry.repo_id for entry in info.repos if entry.size_on_disk > 0
        }
    except Exception:
        pass

    entries = []
    for rid in recommended_ids:
        meta = known_by_id.get(rid, {})
        entries.append({
            "repo_id": rid,
            "label": meta.get("label", rid),
            "role": meta.get("role", ""),
            "size_gb": meta.get("size_gb", 0),
            "required": bool(meta.get("required", False)),
            "note": meta.get("note"),
            "installed": rid in cached_ids,
        })

    to_download_gb = sum(e["size_gb"] for e in entries if not e["installed"])
    all_installed = all(e["installed"] for e in entries)

    return {
        "device": {
            "os": sys.platform,
            "arch": _platform.machine(),
            "is_mac_arm": is_mac_arm,
            "is_mac_intel": is_mac_intel,
            "is_linux": is_linux,
            "is_windows": is_windows,
            "has_cuda": has_cuda,
            "label": device_label,
        },
        "rationale": rationale,
        "models": entries,
        "download_gb_remaining": round(to_download_gb, 2),
        "total_gb": round(sum(e["size_gb"] for e in entries), 2),
        "all_installed": all_installed,
    }
