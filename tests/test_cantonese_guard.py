def test_cantonese_target_aliases_are_recognized():
    from services.cantonese_guard import is_cantonese_target

    assert is_cantonese_target("yue")
    assert is_cantonese_target("zh-HK")
    assert is_cantonese_target("Cantonese")
    assert is_cantonese_target("Cantonese (Yue, Hong Kong)")
    assert not is_cantonese_target("zh")
    assert not is_cantonese_target("Mandarin")


def test_cantonese_text_guard_accepts_spoken_hong_kong_cantonese():
    from services.cantonese_guard import validate_spoken_cantonese_text

    ok, reason = validate_spoken_cantonese_text("我哋喺香港講廣東話。")

    assert ok
    assert reason is None


def test_cantonese_text_guard_rejects_mandarin_or_generic_chinese():
    from services.cantonese_guard import validate_spoken_cantonese_text

    ok, reason = validate_spoken_cantonese_text("我们在香港说中文。")

    assert not ok
    assert "Mandarin" in reason


def test_cantonese_translation_guard_rejects_generic_traditional_chinese():
    from services.cantonese_guard import validate_spoken_cantonese_text

    ok, reason = validate_spoken_cantonese_text("我在香港說中文。")

    assert not ok
    assert "spoken Hong Kong Cantonese" in reason


def test_cantonese_language_is_normalized_for_tts():
    from services.cantonese_guard import normalize_tts_language

    assert normalize_tts_language("Cantonese") == "yue"
    assert normalize_tts_language("zh-HK") == "yue"
    assert normalize_tts_language("English") == "English"


def test_cantonese_realization_handles_ditransitive_give_pattern():
    from services.cantonese_guard import RealizationLevel, realize_cantonese_for_tts

    result = realize_cantonese_for_tts("給我一杯水。")

    assert result.text == "畀杯水我。"
    assert result.level == RealizationLevel.PATTERN


def test_cantonese_realization_handles_comparative_bi_pattern():
    from services.cantonese_guard import RealizationLevel, realize_cantonese_for_tts

    result = realize_cantonese_for_tts("我比你高。")

    assert result.text == "我高過你。"
    assert result.level == RealizationLevel.PATTERN


def test_cantonese_realization_handles_adverbial_more_pattern():
    from services.cantonese_guard import RealizationLevel, realize_cantonese_for_tts

    result = realize_cantonese_for_tts("多吃點。")

    assert result.text == "食多啲。"
    assert result.level == RealizationLevel.PATTERN


def test_cantonese_realization_places_progressive_aspect_around_verb():
    from services.cantonese_guard import RealizationLevel, realize_cantonese_for_tts

    result = realize_cantonese_for_tts("我正在看書。")

    assert result.text == "我喺度睇緊書。"
    assert result.level == RealizationLevel.PATTERN


def test_cantonese_realization_rewrites_common_written_question_forms():
    from services.cantonese_guard import RealizationLevel, realize_cantonese_for_tts

    result = realize_cantonese_for_tts("這樣可以嗎？")

    assert result.text == "咁樣得唔得？"
    assert result.level == RealizationLevel.PRONUNCIATION
    assert result.needs_llm_rewrite is False
    assert "pronunciation:這樣" in result.applied_rules
    assert "pronunciation:可以嗎" in result.applied_rules


def test_cantonese_realization_keeps_unambiguous_spoken_cantonese_stable():
    from services.cantonese_guard import RealizationLevel, realize_cantonese_for_tts

    result = realize_cantonese_for_tts("我哋陣間去食飯啦。")

    assert result.text == "我哋陣間去食飯啦。"
    assert result.level == RealizationLevel.NONE
    assert result.applied_rules == ()


def test_cantonese_realization_does_not_blindly_rewrite_sentence_final_le():
    from services.cantonese_guard import RealizationLevel, realize_cantonese_for_tts

    result = realize_cantonese_for_tts("我們在香港說中文了。")

    assert result.text == "我哋喺香港講中文了。"
    assert result.level == RealizationLevel.LEXICAL
    assert result.needs_llm_rewrite is True


def test_realized_pattern_cantonese_passes_spoken_guard():
    from services.cantonese_guard import (
        realize_cantonese_for_tts,
        validate_spoken_cantonese_text,
    )

    result = realize_cantonese_for_tts("給我一杯水。")
    ok, reason = validate_spoken_cantonese_text(result.text)

    assert ok
    assert reason is None
