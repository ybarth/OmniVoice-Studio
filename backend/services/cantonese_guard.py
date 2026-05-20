"""Guardrails that keep Cantonese distinct from Mandarin/generic Chinese."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

CANTONESE_TARGET_ALIASES = {
    "yue",
    "zh-hk",
    "zh-yue",
    "cantonese",
    "hong kong cantonese",
}

CANTONESE_MARKERS = {
    "嘅", "咗", "喺", "係", "唔", "佢", "哋", "冇", "啲", "咁",
    "呢", "啦", "喎", "呀", "㗎", "咩", "吖", "嚟", "畀", "俾",
    "睇", "嗰", "晒", "啱", "攞", "搵", "返", "嘢", "噉", "講",
}

MANDARIN_OR_SIMPLIFIED_MARKERS = {
    "我们", "你们", "他们", "她们", "它们", "这里", "那里", "这个",
    "那个", "怎么", "什么", "时候", "没有", "因为", "所以",
    "们", "这", "说", "听", "见", "语", "国", "为", "过", "后",
}

GENERIC_WRITTEN_CHINESE_MARKERS = {
    "我們", "你們", "他們", "她們", "這裡", "那裡", "這個", "那個",
    "怎麼", "什麼", "時候", "沒有", "因為", "所以", "的", "了",
    "在", "是", "說", "聽", "語",
}

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_PUNCT_RE = r"(?P<punct>[。！？,.!?]?)"
_RECIPIENT_RE = r"(?P<recipient>我|你|佢|他|她|我們|我们|你們|你们|他們|他们|她們|她们)"
_OBJECT_RE = r"(?P<object>一?[^，。！？,.!?]+)"

_LEXICAL_REPLACEMENTS = [
    ("我們", "我哋"), ("我们", "我哋"),
    ("你們", "你哋"), ("你们", "你哋"),
    ("他們", "佢哋"), ("他们", "佢哋"),
    ("她們", "佢哋"), ("她们", "佢哋"),
    ("它們", "佢哋"), ("它们", "佢哋"),
    ("這裡", "呢度"), ("这里", "呢度"),
    ("那裡", "嗰度"), ("那里", "嗰度"),
    ("這個", "呢個"), ("这个", "呢個"),
    ("那個", "嗰個"), ("那个", "嗰個"),
    ("這些", "呢啲"), ("这些", "呢啲"),
    ("那些", "嗰啲"),
    ("為什麼", "點解"), ("为什么", "點解"),
    ("什麼", "咩"), ("什么", "咩"),
    ("怎麼", "點樣"), ("怎么", "點樣"),
    ("現在", "而家"), ("现在", "而家"),
    ("不是", "唔係"),
    ("沒有", "冇"), ("没有", "冇"),
    ("說話", "講嘢"), ("说话", "講嘢"),
    ("說", "講"), ("说", "講"),
    ("看見", "睇到"), ("看见", "睇到"),
    ("看到", "睇到"),
    ("看", "睇"),
    ("給", "畀"), ("给", "畀"),
    ("回來", "返嚟"), ("回来", "返嚟"),
    ("喜歡", "鍾意"), ("喜欢", "鍾意"),
    ("一點", "少少"), ("一点", "少少"),
    ("這是", "呢個係"), ("这是", "呢個係"),
    ("那是", "嗰個係"),
    ("但是", "但係"),
    ("可是", "不過"),
    ("是", "係"),
    ("在", "喺"),
]

_POSSESSIVE_REPLACEMENTS = [
    (r"(我|你|佢|我哋|你哋|佢哋|他|她|他們|她們|他们|她们)的", r"\1嘅"),
]

_VERB_MAP = {
    "吃": "食", "食": "食",
    "喝": "飲", "飲": "飲",
    "看": "睇", "睇": "睇",
    "說": "講", "说": "講", "講": "講",
    "聽": "聽", "听": "聽",
    "讀": "讀", "读": "讀",
    "寫": "寫", "写": "寫",
    "做": "做",
}

_RESIDUAL_REWRITE_MARKERS = {"了", "吧", "嗎", "吗", "的", "正在"}


class RealizationLevel(str, Enum):
    NONE = "none"
    LEXICAL = "lexical"
    PATTERN = "pattern"


@dataclass(frozen=True)
class CantoneseRealization:
    text: str
    level: RealizationLevel
    needs_llm_rewrite: bool = False
    applied_rules: tuple[str, ...] = ()

    @property
    def changed(self) -> bool:
        return self.level != RealizationLevel.NONE


def is_cantonese_target(language: str | None) -> bool:
    if not language:
        return False
    normalized = language.strip().lower().replace("_", "-")
    if normalized in CANTONESE_TARGET_ALIASES:
        return True
    return "cantonese" in normalized or "hong kong" in normalized and "chinese" in normalized


def normalize_tts_language(language: str | None) -> str | None:
    if is_cantonese_target(language):
        return "yue"
    return language


def _recipient_to_cantonese(value: str) -> str:
    return {
        "他": "佢",
        "她": "佢",
        "他們": "佢哋",
        "他们": "佢哋",
        "她們": "佢哋",
        "她们": "佢哋",
        "我們": "我哋",
        "我们": "我哋",
        "你們": "你哋",
        "你们": "你哋",
    }.get(value, value)


def _strip_indefinite_one(obj: str) -> str:
    # In colloquial Cantonese, "一杯水" is often "杯水" in this ditransitive
    # pattern. Keep the rest intact so we do not over-normalise quantities.
    return obj[1:] if obj.startswith("一") and len(obj) >= 2 else obj


def _apply_pattern_rules(text: str) -> tuple[str, list[str]]:
    applied: list[str] = []
    value = text

    def give_repl(match: re.Match) -> str:
        applied.append("give-object-recipient")
        recipient = _recipient_to_cantonese(match.group("recipient"))
        obj = _strip_indefinite_one(match.group("object"))
        return f"畀{obj}{recipient}{match.group('punct') or ''}"

    value = re.sub(
        rf"(?:給|给){_RECIPIENT_RE}{_OBJECT_RE}{_PUNCT_RE}",
        give_repl,
        value,
    )

    def comparative_repl(match: re.Match) -> str:
        applied.append("comparative-gwo")
        return (
            f"{match.group('subject')}"
            f"{match.group('adjective')}"
            f"過{_recipient_to_cantonese(match.group('object'))}"
            f"{match.group('punct') or ''}"
        )

    value = re.sub(
        rf"(?P<subject>[^，。！？,.!?比]{{1,12}})比(?P<object>我|你|佢|他|她)"
        rf"(?P<adjective>高|低|大|細|小|快|慢|好|差|貴|贵|平|便宜){_PUNCT_RE}",
        comparative_repl,
        value,
    )

    def more_repl(match: re.Match) -> str:
        applied.append("verb-more-di")
        verb = _VERB_MAP.get(match.group("verb"), match.group("verb"))
        return f"{verb}多啲{match.group('punct') or ''}"

    value = re.sub(
        rf"多(?P<verb>{'|'.join(map(re.escape, _VERB_MAP.keys()))})點{_PUNCT_RE}",
        more_repl,
        value,
    )
    value = re.sub(
        rf"多(?P<verb>{'|'.join(map(re.escape, _VERB_MAP.keys()))})点{_PUNCT_RE}",
        more_repl,
        value,
    )

    def progressive_repl(match: re.Match) -> str:
        applied.append("progressive-gan")
        prefix = match.group("prefix")
        verb = _VERB_MAP.get(match.group("verb"), match.group("verb"))
        obj = match.group("object") or ""
        return f"{prefix}喺度{verb}緊{obj}{match.group('punct') or ''}"

    value = re.sub(
        rf"(?P<prefix>[^，。！？,.!?]{{0,16}}?)(?:正在|在)(?P<verb>{'|'.join(map(re.escape, _VERB_MAP.keys()))})(?P<object>[^，。！？,.!?]*){_PUNCT_RE}",
        progressive_repl,
        value,
    )

    return value, applied


def _apply_lexical_rules(text: str) -> tuple[str, list[str]]:
    value = text
    applied: list[str] = []

    for pattern, replacement in _POSSESSIVE_REPLACEMENTS:
        value, count = re.subn(pattern, replacement, value)
        if count:
            applied.append("possessive-ge")

    for source, target in _LEXICAL_REPLACEMENTS:
        if source in value:
            value = value.replace(source, target)
            applied.append(f"lexical:{source}")

    return value, applied


def _needs_model_rewrite(text: str) -> bool:
    return any(marker in text for marker in _RESIDUAL_REWRITE_MARKERS)


def realize_cantonese_for_tts(text: str) -> CantoneseRealization:
    """Convert written-Chinese-looking Cantonese into spoken HK Cantonese text.

    This is intentionally a conservative post-pass for TTS prompts. It is not a
    full translator; pattern rules handle only well-attested structures. If the
    remaining sentence still needs contextual grammar, the result asks the model
    translator for a whole-sentence rewrite instead of guessing.
    """
    value = text or ""
    if count_cjk(value) == 0:
        return CantoneseRealization(value, RealizationLevel.NONE)

    patterned, pattern_rules = _apply_pattern_rules(value)
    realized, lexical_rules = _apply_lexical_rules(patterned)
    applied_rules = tuple(pattern_rules + lexical_rules)
    if not applied_rules:
        return CantoneseRealization(
            value,
            RealizationLevel.NONE,
            needs_llm_rewrite=_needs_model_rewrite(value),
        )
    level = RealizationLevel.PATTERN if pattern_rules else RealizationLevel.LEXICAL
    return CantoneseRealization(
        realized,
        level,
        needs_llm_rewrite=_needs_model_rewrite(realized),
        applied_rules=applied_rules,
    )


def cantonese_translation_clause() -> str:
    return (
        " Use natural spoken Hong Kong Cantonese/Yue written in Traditional "
        "Chinese characters. Do NOT translate into Mandarin, Putonghua, or "
        "generic written Chinese. Prefer colloquial Cantonese wording and "
        "particles such as 係, 唔, 嘅, 咗, 喺, 佢, 哋, 冇, 啲, and 講. "
        "For voice synthesis, rewrite standard written Chinese forms into the "
        "spoken Cantonese forms people would actually say."
    )


def cantonese_retry_clause() -> str:
    return (
        " Your previous attempt looked like Mandarin or generic Chinese. "
        "Rewrite it as spoken Hong Kong Cantonese only, with Cantonese "
        "vocabulary/particles and no Mandarin wording."
    )


def count_cjk(text: str) -> int:
    return len(_CJK_RE.findall(text or ""))


def _has_any(text: str, needles: set[str]) -> bool:
    return any(needle in text for needle in needles)


def validate_spoken_cantonese_text(text: str) -> tuple[bool, str | None]:
    """Return whether CJK text is safe to synthesize as Cantonese.

    Standard written Chinese can be read aloud in Cantonese, but it gives the
    TTS model too much room to drift. For this app's Cantonese mode we require
    clearly spoken Hong Kong Cantonese orthography when the text is Chinese.
    """
    value = (text or "").strip()
    cjk_count = count_cjk(value)
    if cjk_count == 0:
        return True, None

    has_cantonese = _has_any(value, CANTONESE_MARKERS)
    if has_cantonese and _needs_model_rewrite(value):
        return (
            False,
            "Cantonese output still contains written-Chinese grammar that needs whole-sentence rewriting.",
        )
    if _has_any(value, MANDARIN_OR_SIMPLIFIED_MARKERS):
        return (
            False,
            "Cantonese guard rejected likely Mandarin/Simplified Chinese output.",
        )

    if has_cantonese:
        return True, None

    if cjk_count >= 4 or _has_any(value, GENERIC_WRITTEN_CHINESE_MARKERS):
        return (
            False,
            "Cantonese target needs spoken Hong Kong Cantonese, not generic written Chinese.",
        )

    return True, None
