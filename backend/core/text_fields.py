import re
from typing import Optional


_NEUTRAL_INSTRUCTS = {
    "default",
    "none",
    "normal",
    "normal speaking style",
    "regular",
    "regular speaking style",
}


def clean_optional_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def clean_instruct_text(value: Optional[str]) -> Optional[str]:
    stripped = clean_optional_text(value)
    if stripped is None:
        return None
    normalized = re.sub(r"\s+", " ", stripped).strip(" \t\r\n.。!！?？").lower()
    if normalized in _NEUTRAL_INSTRUCTS:
        return None
    return stripped
