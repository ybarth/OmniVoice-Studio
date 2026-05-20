"""Durable environment-variable storage for app-managed credentials."""
from __future__ import annotations

import os
from pathlib import Path


def user_env_path() -> Path:
    return Path(os.environ.get("OMNIVOICE_USER_ENV_PATH", "~/.config/omnivoice/env")).expanduser()


def _quote_env_value(value: str) -> str:
    escaped = (
        value
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
    )
    return f'"{escaped}"'


def persist_env_var(key: str, value: str) -> None:
    """Persist a single env var in the per-user OmniVoice env file."""
    path = user_env_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    prefix = f"{key}="
    export_prefix = f"export {key}="
    kept = [
        line for line in lines
        if not (line.startswith(prefix) or line.startswith(export_prefix))
    ]
    if value:
        kept.append(f"{key}={_quote_env_value(value)}")
    path.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _hf_token_path() -> Path:
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        return Path(hf_home).expanduser() / "token"
    try:
        from huggingface_hub.constants import HF_TOKEN_PATH
        return Path(HF_TOKEN_PATH).expanduser()
    except Exception:
        return Path("~/.cache/huggingface/token").expanduser()


def persist_hf_token(value: str) -> None:
    """Write the canonical Hugging Face token file used by HF tooling."""
    path = _hf_token_path()
    if value:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value.strip() + "\n", encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def set_persistent_env_var(key: str, value: str) -> None:
    if value:
        os.environ[key] = value
    else:
        os.environ.pop(key, None)
    persist_env_var(key, value)
    if key == "HF_TOKEN":
        persist_hf_token(value)
