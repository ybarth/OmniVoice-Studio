"""
Translation engine registry + UI-driven install/uninstall.

This is the single source of truth for which translation providers we know
about, what pip package they need, and whether that package is importable
right now. The Engine dropdown in the Dub tab reads list_engines() to
decide which options are ready-to-use vs. "needs install".

Why a registry rather than inline probes in dub_translate.py? The UI wants
to render the availability table BEFORE the user clicks Translate, so we
don't surface a cryptic ModuleNotFoundError for every segment. Having the
registry live next to the dub_translate dispatch also means adding a new
engine is one entry here + one branch in _build_translator.
"""
from __future__ import annotations

import asyncio
import importlib
import logging
import os
import shutil
import sys
import time

logger = logging.getLogger("omnivoice.translation_engines")


# Engine ID → registry entry. Keyed by the `provider` string sent from the
# frontend (must match the values of `translateProvider` in the store).
REGISTRY: dict[str, dict] = {
    "argos": {
        "id": "argos",
        "display_name": "Argos (Local, Fast)",
        "pip_package": "argostranslate",
        "probe_module": "argostranslate",
        "category": "offline",
        "needs_key": False,
        "builtin": True,
        "notes": "Pure-CPU offline translator. Downloads a ~50MB language pack on first use per pair.",
    },
    "nllb": {
        "id": "nllb",
        "display_name": "NLLB-200 (Local, Heavy)",
        "pip_package": None,          # uses HF transformers — already a core dep
        "probe_module": "transformers",
        "category": "offline",
        "needs_key": False,
        "builtin": True,
        "notes": "Meta's 200-language NMT model. Large download (~2.4GB), best offline quality.",
    },
    "hymt-1.8b": {
        "id": "hymt-1.8b",
        "display_name": "HY-MT1.5 1.8B (Local Cantonese)",
        "pip_package": None,
        "probe_module": "transformers",
        "category": "offline",
        "needs_key": False,
        "builtin": True,
        "model_repo_id": "tencent/HY-MT1.5-1.8B",
        "model_size_gb": 4.1,
        "notes": (
            "Tencent's compact multilingual translation model with explicit "
            "Cantonese/yue support. Download it from Models before first use."
        ),
    },
    "hymt-7b": {
        "id": "hymt-7b",
        "display_name": "HY-MT1.5 7B (Local, Higher Quality)",
        "pip_package": None,
        "probe_module": "transformers",
        "category": "offline",
        "needs_key": False,
        "builtin": True,
        "model_repo_id": "tencent/HY-MT1.5-7B",
        "model_size_gb": 16.1,
        "notes": (
            "Higher-quality HY-MT1.5 translation model with Cantonese/yue "
            "support. Heavier download and memory footprint than 1.8B."
        ),
    },
    "google": {
        "id": "google",
        "display_name": "Google Translate (Online, Free)",
        "pip_package": "deep_translator",
        "probe_module": "deep_translator",
        "category": "online",
        "needs_key": False,
        "notes": "Free web endpoint via deep_translator. Rate-limited by Google; no API key required.",
    },
    "deepl": {
        "id": "deepl",
        "display_name": "DeepL (Online, Key)",
        "pip_package": "deep_translator",
        "probe_module": "deep_translator",
        "category": "online",
        "needs_key": True,
        "notes": "High-quality EU MT. Free tier: 500K chars/month. Set DEEPL_API_KEY.",
    },
    "microsoft": {
        "id": "microsoft",
        "display_name": "Microsoft Translator (Online, Key)",
        "pip_package": "deep_translator",
        "probe_module": "deep_translator",
        "category": "online",
        "needs_key": True,
        "notes": "Azure Cognitive Services. Free tier: 2M chars/month. Set MICROSOFT_API_KEY.",
    },
    "mymemory": {
        "id": "mymemory",
        "display_name": "MyMemory (Online, No Key)",
        "pip_package": "deep_translator",
        "probe_module": "deep_translator",
        "category": "online",
        "needs_key": False,
        "notes": "Crowdsourced MT. Free, 5K chars/day anonymous; more with an email param.",
    },
    "openai": {
        "id": "openai",
        "display_name": "OpenAI (API)",
        "pip_package": None,
        "probe_module": None,
        "category": "llm",
        "needs_key": True,
        "notes": (
            "OpenAI chat-completions translation. Set OPENAI_API_KEY or "
            "TRANSLATE_API_KEY; optionally set TRANSLATE_MODEL."
        ),
    },
    "openai-compatible": {
        "id": "openai-compatible",
        "display_name": "OpenAI-compatible LLM",
        "pip_package": None,
        "probe_module": None,
        "category": "llm",
        "needs_key": True,
        "notes": (
            "Any OpenAI-compatible endpoint: OpenRouter, Gemini compatibility "
            "mode, DeepSeek, Qwen, Ollama, or LM Studio. Set TRANSLATE_BASE_URL, "
            "TRANSLATE_API_KEY, and TRANSLATE_MODEL."
        ),
    },
}

_RUNTIME_STATUS: dict[str, dict] = {}
_RUNTIME_STALE_SECONDS = 10 * 60
_RUNNING_STATUSES = {"loading", "generating"}


def set_runtime_status(
    engine_id: str,
    status: str,
    detail: str = "",
    progress_pct: int | None = None,
):
    _RUNTIME_STATUS[engine_id] = {
        "status": status,
        "detail": detail,
        "progress_pct": progress_pct,
        "updated_at": time.time(),
    }


def get_runtime_status(engine_id: str) -> dict:
    status = _RUNTIME_STATUS.get(engine_id)
    if status:
        updated_at = status.get("updated_at")
        if (
            status.get("status") in _RUNNING_STATUSES
            and updated_at
            and time.time() - float(updated_at) > _RUNTIME_STALE_SECONDS
        ):
            age = round(time.time() - float(updated_at))
            return {
                **status,
                "status": "error",
                "detail": (
                    f"Previous translation attempt stalled after {age}s"
                    + (f" while {status.get('detail')}" if status.get("detail") else "")
                ),
                "progress_pct": None,
                "stale": True,
            }
        return status
    return {
        "status": "idle",
        "detail": "",
        "progress_pct": None,
        "updated_at": None,
    }


def is_frozen() -> bool:
    """True when running inside a packaged Tauri / PyInstaller bundle.

    In that case the Python site-packages is read-only and signed, so we
    refuse install/uninstall requests instead of corrupting the bundle.
    """
    return bool(getattr(sys, "frozen", False) or os.environ.get("OMNIVOICE_FROZEN"))


def _probe(entry: dict) -> tuple[bool, str]:
    mod = entry.get("probe_module")
    if not mod:
        return True, "no module required"
    try:
        importlib.import_module(mod)
        return True, "ready"
    except ImportError as e:
        return False, f"import {mod!r} failed: {e}"


def is_model_installed(engine_id: str) -> bool:
    entry = REGISTRY.get(engine_id)
    repo_id = entry.get("model_repo_id") if entry else None
    if not repo_id:
        return True
    try:
        from api.routers.setup.models import is_cached
        return bool(is_cached(repo_id))
    except Exception as e:
        logger.debug("model cache probe failed for %s: %s", repo_id, e)
        return False


def _availability(entry: dict) -> dict:
    dependency_installed, dep_reason = _probe(entry)
    model_repo_id = entry.get("model_repo_id")
    model_installed = is_model_installed(entry["id"]) if model_repo_id else None
    installed = dependency_installed and (model_installed is not False)
    if not dependency_installed:
        reason = dep_reason
    elif model_installed is False:
        reason = f"Model {model_repo_id} is not installed. Download it from Models first."
    else:
        reason = dep_reason
    runtime = get_runtime_status(entry["id"])
    return {
        "installed": installed,
        "dependency_installed": dependency_installed,
        "model_installed": model_installed,
        "availability_reason": reason,
        "runtime_status": runtime["status"],
        "runtime_detail": runtime["detail"],
        "runtime_progress_pct": runtime["progress_pct"],
        "running": runtime["status"] in {"loading", "generating", "ready"},
        "last_runtime_update": runtime["updated_at"],
    }


def list_engines() -> list[dict]:
    """Return a UI-ready list with per-engine availability stamped in."""
    out = []
    for e in REGISTRY.values():
        out.append({
            **e,
            **_availability(e),
        })
    return out


def get_engine(engine_id: str) -> dict | None:
    return REGISTRY.get(engine_id)


def is_installed(engine_id: str) -> bool:
    entry = REGISTRY.get(engine_id)
    if not entry:
        return False
    return bool(_availability(entry)["installed"])


def _in_virtualenv() -> bool:
    """True if the current interpreter is inside a venv/virtualenv."""
    return getattr(sys, "base_prefix", sys.prefix) != sys.prefix or hasattr(sys, "real_prefix")


def _installer_cmd() -> list[str]:
    """Prefer `uv pip` (the dev install's default), fall back to `python -m pip`.

    `python -m pip` ensures we target the same interpreter the server is
    running under — avoids the classic "pip installed into the wrong venv"
    footgun.
    """
    if shutil.which("uv"):
        return ["uv", "pip"]
    return [sys.executable, "-m", "pip"]


async def run_pip(args: list[str], timeout: float = 600.0) -> tuple[int, str]:
    """Run a pip command async and return (rc, combined_output).

    Combines stdout + stderr so the UI can surface a useful tail on failure
    (pip's "ERROR: ..." lines go to stderr).

    When using `uv pip` and running outside a venv (e.g. inside the Docker
    image where Python runs as system), inject `--system` after the
    install/uninstall subcommand. Without it, uv refuses to write to system
    Python with: "No virtual environment found; run `uv venv` to create an
    environment, or pass `--system`...". The `UV_SYSTEM_PYTHON` env var only
    affects `uv venv`, not `uv pip install`.
    """
    base = _installer_cmd()
    using_uv = base[:1] == ["uv"]
    if using_uv and not _in_virtualenv() and args and args[0] in ("install", "uninstall") and "--system" not in args:
        args = [args[0], "--system", *args[1:]]
    cmd = base + args
    logger.info("pip: %s", " ".join(cmd))
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError as e:
        return 1, f"installer not found: {e}"
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return 1, f"pip timed out after {timeout:.0f}s"
    out = stdout.decode(errors="replace") if stdout else ""
    return proc.returncode or 0, out
