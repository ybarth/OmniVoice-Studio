import os
import time
import asyncio
import logging
import json
import urllib.error
import urllib.request
from collections.abc import Mapping
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from schemas.requests import TranslateRequest
from services.model_manager import _cpu_pool, _gpu_pool
from services.translator import cinematic_available, cinematic_refine_many
from services import translation_engines
from services.cantonese_guard import (
    cantonese_retry_clause,
    cantonese_translation_clause,
    is_cantonese_target,
    realize_cantonese_for_tts,
    validate_spoken_cantonese_text,
)
from api.routers.dub_core import _get_job

router = APIRouter()
logger = logging.getLogger("omnivoice.api")

TRANSLATE_CODES = {
    "en": "en", "es": "es", "fr": "fr", "de": "de", "it": "it", "pt": "pt",
    "ru": "ru", "ja": "ja", "ko": "ko", "zh": "zh-CN", "ar": "ar", "hi": "hi",
    "tr": "tr", "pl": "pl", "nl": "nl", "sv": "sv", "th": "th", "vi": "vi",
    "id": "id", "uk": "uk", "yue": "yue", "zh-HK": "yue", "zh-yue": "yue",
}

DEEP_TRANSLATOR_CODES = {
    "yue": "zh-TW",
    "zh-HK": "zh-TW",
    "zh-yue": "zh-TW",
}

FLORES_CODES = {
    "en": "eng_Latn", "es": "spa_Latn", "fr": "fra_Latn", "de": "deu_Latn",
    "it": "ita_Latn", "pt": "por_Latn", "ru": "rus_Cyrl", "ja": "jpn_Jpan",
    "ko": "kor_Hang", "zh": "zho_Hans", "zh-CN": "zho_Hans", "yue": "yue_Hant",
    "zh-HK": "yue_Hant", "zh-yue": "yue_Hant", "ar": "arb_Arab",
    "hi": "hin_Deva", "tr": "tur_Latn", "pl": "pol_Latn", "nl": "nld_Latn",
    "sv": "swe_Latn", "th": "tha_Thai", "vi": "vie_Latn", "id": "ind_Latn",
    "uk": "ukr_Cyrl",
}

# Human-readable language names for LLM prompts. Empirically a tiny / 7B
# local LLM produces Devanagari Hindi reliably when told "translate into
# Hindi" but drifts to German / English / phonetic-Latin when told
# "translate into hi". The two-letter ISO codes "hi" / "de" / "fr" can
# overlap with everyday tokens ("hi" = greeting), which throws off small
# instruction-tuned models. Pass the full name in the prompt so the model
# can't misread it.
LANG_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German",
    "it": "Italian", "pt": "Portuguese", "ru": "Russian", "ja": "Japanese",
    "ko": "Korean", "zh": "Chinese (Simplified)", "zh-CN": "Chinese (Simplified)",
    "yue": "Cantonese (Yue, Hong Kong, Traditional Chinese characters)",
    "zh-HK": "Cantonese (Yue, Hong Kong, Traditional Chinese characters)",
    "zh-yue": "Cantonese (Yue, Hong Kong, Traditional Chinese characters)",
    "auto": "the detected source language",
    "ar": "Arabic", "hi": "Hindi", "tr": "Turkish", "pl": "Polish",
    "nl": "Dutch", "sv": "Swedish", "th": "Thai", "vi": "Vietnamese",
    "id": "Indonesian", "uk": "Ukrainian",
}

# Per-language script enforcement. Maps language code → required Unicode
# block(s) the translation must contain. Used as a sanity gate after the
# LLM responds: if the output contains <50% characters from the expected
# block, we treat the translation as corrupted and retry. The block names
# here are the keys recognised by Python's `unicodedata.name()` lookup or
# regex Unicode property classes.
LANG_REQUIRED_SCRIPT = {
    "hi":  ("DEVANAGARI", (0x0900, 0x097F)),
    "ar":  ("ARABIC",     (0x0600, 0x06FF)),
    "zh":  ("CJK",        (0x4E00, 0x9FFF)),
    "zh-CN": ("CJK",      (0x4E00, 0x9FFF)),
    "yue": ("CJK",        (0x4E00, 0x9FFF)),
    "zh-HK": ("CJK",      (0x4E00, 0x9FFF)),
    "zh-yue": ("CJK",     (0x4E00, 0x9FFF)),
    "ja":  ("JAPANESE",   (0x3040, 0x30FF)),
    "ko":  ("HANGUL",     (0xAC00, 0xD7AF)),
    "th":  ("THAI",       (0x0E00, 0x0E7F)),
    "ru":  ("CYRILLIC",   (0x0400, 0x04FF)),
    "uk":  ("CYRILLIC",   (0x0400, 0x04FF)),
}


def _script_ratio(text: str, code: str) -> float:
    """Fraction of letters in `text` that fall inside the script block we
    expect for `code`. Punctuation/digits/whitespace are excluded from the
    denominator so a Hindi sentence ending in "." still scores 1.0."""
    info = LANG_REQUIRED_SCRIPT.get(code)
    if not info:
        return 1.0
    _, (lo, hi) = info
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 1.0
    inside = sum(1 for c in letters if lo <= ord(c) <= hi)
    return inside / len(letters)


def _looks_like_target(text: str, code: str, threshold: float = 0.5) -> bool:
    """Sanity gate for non-Latin targets. True if `text` is *plausibly* in
    the target language by script. Only meaningful for languages with a
    distinctive script (Indic, CJK, Arabic, etc.); Latin-script targets
    always return True since we can't distinguish English from German by
    codepoints alone."""
    return _script_ratio(text, code) >= threshold

_nllb_model = None
_nllb_tokenizer = None
_nllb_device = None
_local_translation_models = {}

LOCAL_TRANSLATION_MODELS = {
    "hymt-1.8b": "tencent/HY-MT1.5-1.8B",
    "hymt-7b": "tencent/HY-MT1.5-7B",
}


def _local_translation_timeout_seconds() -> float:
    try:
        return max(15.0, float(os.environ.get("OMNIVOICE_LOCAL_TRANSLATION_TIMEOUT_SECONDS", "180")))
    except ValueError:
        return 180.0


def _deep_translator_code(code: str | None) -> str | None:
    if not code:
        return code
    if code == "auto":
        return "auto"
    return DEEP_TRANSLATOR_CODES.get(code, TRANSLATE_CODES.get(code, code))


def _resolve_source_lang(req: TranslateRequest) -> str:
    """Pick source language: explicit request > job.source_lang > 'en' fallback."""
    if getattr(req, "source_lang", None):
        return req.source_lang
    if getattr(req, "job_id", None):
        job = _get_job(req.job_id)
        if job and job.get("source_lang"):
            return job["source_lang"]
    return "en"


def _unload_nllb():
    """Release NLLB VRAM so TTS model can reload."""
    global _nllb_model, _nllb_tokenizer
    import gc
    _nllb_model = None
    _nllb_tokenizer = None
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass


def _unload_local_translation_models():
    """Release local LLM translation models so TTS can reclaim VRAM/RAM."""
    global _local_translation_models
    import gc
    _local_translation_models = {}
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            empty_cache = getattr(getattr(torch, "mps", None), "empty_cache", None)
            if callable(empty_cache):
                empty_cache()
    except Exception:
        pass


def _local_translation_prompt(src_code: str, tgt_code: str, text: str, attempt: int = 0) -> str:
    tgt_name = LANG_NAMES.get(tgt_code, tgt_code)
    if src_code and src_code != "auto":
        src_name = LANG_NAMES.get(src_code, src_code)
        lead = f"Translate the following segment from {src_name} into {tgt_name}"
    else:
        lead = f"Translate the following segment into {tgt_name}"
    style = ""
    if is_cantonese_target(tgt_code):
        style = cantonese_translation_clause()
        if attempt > 0:
            style += cantonese_retry_clause()
    return f"{lead}, without additional explanation. Target language code: {tgt_code}.{style}\n\n{text}"


def _cantonese_rewrite_system_prompt() -> str:
    return (
        "You rewrite Cantonese drafts for voice synthesis. Produce "
        "whole-sentence spoken Hong Kong Cantonese only, written in "
        "Traditional Chinese characters. Preserve the exact meaning. Fix "
        "Mandarin wording, generic written Chinese grammar, sentence-final "
        "了/嗎/吧, 的 possessives, 正在 progressives, and unnatural written "
        "Chinese word order. Reply only with the rewritten Cantonese text."
    )


def _cantonese_rewrite_user_prompt(source_text: str, draft_text: str) -> str:
    return (
        "Rewrite this Cantonese draft as whole-sentence spoken Hong Kong "
        "Cantonese for voice synthesis. Keep the source meaning exactly and "
        "make the draft sound like natural Hong Kong speech. Reply only with "
        "the rewritten Cantonese text.\n\n"
        f"Source:\n{source_text}\n\n"
        f"Cantonese draft:\n{draft_text}"
    )


def _load_local_translation_model(model_id: str):
    cached = _local_translation_models.get(model_id)
    if cached:
        return cached

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(
        model_id,
        trust_remote_code=True,
        local_files_only=True,
    )

    load_kwargs = {"trust_remote_code": True, "local_files_only": True}
    target_device = "cpu"
    if torch.cuda.is_available():
        target_device = "cuda"
        load_kwargs["device_map"] = "auto"
        if hasattr(torch, "bfloat16"):
            load_kwargs["torch_dtype"] = torch.bfloat16
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        target_device = "mps"
        if hasattr(torch, "float16"):
            load_kwargs["torch_dtype"] = torch.float16

    model = AutoModelForCausalLM.from_pretrained(model_id, **load_kwargs)
    if target_device != "cpu" and "device_map" not in load_kwargs:
        try:
            model = model.to(target_device)
        except Exception as e:
            logger.warning("Local translation model %s placement failed, falling back to CPU: %s", target_device, e)

    _local_translation_models[model_id] = (tokenizer, model)
    return tokenizer, model


def _generated_token_slice(outputs, input_ids):
    try:
        input_len = int(getattr(input_ids, "shape", [0, 0])[-1])
    except Exception:
        input_len = 0
    try:
        return outputs[0][input_len:] if input_len else outputs[0]
    except Exception:
        return outputs[0]


def _prepare_local_generation_inputs(tokenized_chat, device):
    moved = tokenized_chat.to(device) if hasattr(tokenized_chat, "to") else tokenized_chat
    if isinstance(moved, Mapping):
        kwargs = {key: moved[key] for key in moved.keys()}
        return (), kwargs, kwargs.get("input_ids")
    return (moved,), {}, moved


def _error_message(exc: Exception) -> str:
    return str(exc) or f"{type(exc).__name__}: {repr(exc)}"


def _translation_guard_error(text: str, code: str) -> str | None:
    if not _looks_like_target(text, code):
        return (
            f"model output script_ratio={_script_ratio(text, code):.2f} "
            f"below threshold for {code}"
        )
    if is_cantonese_target(code):
        ok, reason = validate_spoken_cantonese_text(text)
        if not ok:
            return reason or "Cantonese guard rejected output."
    return None


def _realize_cantonese_text_for_target(text: str, code: str) -> tuple[str, bool, bool]:
    if not is_cantonese_target(code):
        return text, False, False
    realized = realize_cantonese_for_tts(text)
    return realized.text, realized.changed, realized.needs_llm_rewrite


def _finalize_translation_row(row: dict, target_code: str) -> dict:
    if row.get("error") or not is_cantonese_target(target_code):
        return row
    original = row.get("text") or ""
    realized, changed, needs_rewrite = _realize_cantonese_text_for_target(original, target_code)
    guard_err = _translation_guard_error(realized, target_code)
    if not changed and not guard_err and not needs_rewrite:
        return row

    next_row = dict(row)
    next_row["text"] = realized
    if changed:
        next_row["cantonese_realized"] = True
    if needs_rewrite:
        next_row["needs_cantonese_rewrite"] = True
        guard_err = (
            "Cantonese realization needs Tencent or OpenAI to rewrite this "
            "whole sentence into natural Hong Kong spoken Cantonese."
        )
    if guard_err:
        next_row["error"] = guard_err
    return next_row


def _finalize_translation_rows(rows: list[dict], req: TranslateRequest) -> list[dict]:
    target_by_id = {
        str(seg.id): (seg.target_lang or req.target_lang)
        for seg in req.segments
    }
    return [
        _finalize_translation_row(row, target_by_id.get(str(row.get("id")), req.target_lang))
        for row in rows
    ]


@router.post("/dub/translate")
async def dub_translate(req: TranslateRequest):
    try:
        provider = (req.provider if req.provider else os.environ.get("TRANSLATE_PROVIDER", "google")).lower()
        lang_code = _deep_translator_code(req.target_lang)
        api_key = os.environ.get("TRANSLATE_API_KEY", "")
        loop = asyncio.get_running_loop()
        src_lang = _resolve_source_lang(req)

        # Offline NLLB Transformer Translation
        if provider == "nllb":
            flores_tgt = FLORES_CODES.get(req.target_lang, "eng_Latn")
            flores_src = FLORES_CODES.get(src_lang, "eng_Latn")

            def _translate_nllb():
                global _nllb_model, _nllb_tokenizer, _nllb_device
                import torch
                from transformers import AutoTokenizer, AutoModelForSeq2SeqLM

                if torch.cuda.is_available():
                    target_device = "cuda"
                elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                    target_device = "mps"
                else:
                    target_device = "cpu"

                try:
                    if _nllb_tokenizer is None:
                        _nllb_tokenizer = AutoTokenizer.from_pretrained("facebook/nllb-200-distilled-600M")
                    if _nllb_model is None:
                        _nllb_model = AutoModelForSeq2SeqLM.from_pretrained("facebook/nllb-200-distilled-600M")
                        if target_device != "cpu":
                            try:
                                _nllb_model = _nllb_model.to(target_device)
                                _nllb_device = target_device
                            except Exception as e:
                                logger.warning("NLLB %s placement failed, falling back to CPU: %s", target_device, e)
                                _nllb_device = "cpu"
                        else:
                            _nllb_device = "cpu"
                except Exception as e:
                    logger.exception("NLLB model load failed")
                    return [{"id": seg.id, "text": seg.text, "error": f"Model load error: {str(e)}"} for seg in req.segments]

                results = []
                for seg in req.segments:
                    try:
                        if not seg.text or not seg.text.strip():
                            results.append({"id": seg.id, "text": seg.text})
                            continue

                        tgt = FLORES_CODES.get(seg.target_lang, flores_tgt) if seg.target_lang else flores_tgt

                        _nllb_tokenizer.src_lang = flores_src
                        inputs = _nllb_tokenizer(seg.text, return_tensors="pt")
                        if _nllb_device and _nllb_device != "cpu":
                            inputs = {k: v.to(_nllb_device) for k, v in inputs.items()}

                        forced_bos_token_id = _nllb_tokenizer.convert_tokens_to_ids(tgt)
                        try:
                            translated_tokens = _nllb_model.generate(
                                **inputs, forced_bos_token_id=forced_bos_token_id, max_length=400
                            )
                        except (RuntimeError, NotImplementedError) as e:
                            if _nllb_device == "mps":
                                logger.warning("MPS generate failed, retrying on CPU: %s", e)
                                _nllb_model.to("cpu")
                                _nllb_device = "cpu"
                                inputs = {k: v.to("cpu") for k, v in inputs.items()}
                                translated_tokens = _nllb_model.generate(
                                    **inputs, forced_bos_token_id=forced_bos_token_id, max_length=400
                                )
                            else:
                                raise
                        translated_text = _nllb_tokenizer.batch_decode(translated_tokens, skip_special_tokens=True)[0]
                        results.append({"id": seg.id, "text": translated_text})
                    except Exception as e:
                        results.append({"id": seg.id, "text": seg.text, "error": str(e)})
                return results

            translated = await loop.run_in_executor(_gpu_pool, _translate_nllb)
            translated = _finalize_translation_rows(translated, req)
            if os.environ.get("OMNIVOICE_UNLOAD_NLLB", "1") == "1":
                _unload_nllb()
            return {"translated": translated, "target_lang": req.target_lang, "source_lang": src_lang}

        if provider in LOCAL_TRANSLATION_MODELS:
            model_id = LOCAL_TRANSLATION_MODELS[provider]
            if not translation_engines.is_model_installed(provider):
                message = (
                    f"{model_id} is not installed. Download it from Models first; "
                    "then retry translation."
                )
                translation_engines.set_runtime_status(provider, "error", message)
                return JSONResponse(status_code=400, content={"error": message})

            def _translate_local_model():
                try:
                    translation_engines.set_runtime_status(
                        provider,
                        "loading",
                        f"Loading {model_id}",
                        progress_pct=10,
                    )
                    import torch
                    tokenizer, model = _load_local_translation_model(model_id)
                except Exception as e:
                    logger.exception("Local translation model load failed for %s", model_id)
                    translation_engines.set_runtime_status(
                        provider,
                        "error",
                        f"Model load error: {str(e)}",
                    )
                    return [{"id": seg.id, "text": seg.text, "error": f"Model load error: {str(e)}"} for seg in req.segments]

                translation_engines.set_runtime_status(
                    provider,
                    "generating",
                    f"Running {model_id}",
                    progress_pct=45,
                )
                results = []
                total_segments = max(len(req.segments), 1)
                for idx, seg in enumerate(req.segments, start=1):
                    translation_engines.set_runtime_status(
                        provider,
                        "generating",
                        f"Translating segment {idx}/{total_segments} with {model_id}",
                        progress_pct=min(95, 45 + round((idx - 1) / total_segments * 45)),
                    )
                    try:
                        if not seg.text or not seg.text.strip():
                            results.append({"id": seg.id, "text": seg.text})
                            continue

                        def _generate_local_text(user_prompt: str) -> str:
                            tokenized_chat = tokenizer.apply_chat_template(
                                [{"role": "user", "content": user_prompt}],
                                tokenize=True,
                                add_generation_prompt=False,
                                return_tensors="pt",
                            )
                            model_device = getattr(model, "device", "cpu")
                            gen_args, gen_kwargs, input_ids = _prepare_local_generation_inputs(
                                tokenized_chat,
                                model_device,
                            )
                            with torch.no_grad():
                                outputs = model.generate(
                                    *gen_args,
                                    max_new_tokens=512,
                                    top_k=20,
                                    top_p=0.6,
                                    repetition_penalty=1.05,
                                    temperature=0.7,
                                    **gen_kwargs,
                                )
                            generated_ids = _generated_token_slice(outputs, input_ids)
                            return tokenizer.decode(generated_ids, skip_special_tokens=True).strip()

                        tgt_code = seg.target_lang if seg.target_lang else req.target_lang
                        attempts = 2 if is_cantonese_target(tgt_code) else 1
                        out_text = ""
                        last_err = None
                        was_realized = False
                        rewrite_draft = ""
                        for attempt in range(attempts):
                            user_prompt = _local_translation_prompt(src_lang, tgt_code, seg.text, attempt=attempt)
                            out_text = _generate_local_text(user_prompt)
                            if not out_text:
                                last_err = "empty model response"
                            else:
                                out_text, was_realized, needs_rewrite = _realize_cantonese_text_for_target(out_text, tgt_code)
                                if needs_rewrite:
                                    rewrite_draft = out_text
                                last_err = (
                                    "Cantonese output needs whole-sentence spoken Hong Kong rewrite"
                                    if needs_rewrite
                                    else _translation_guard_error(out_text, tgt_code)
                                )
                            if not last_err:
                                break
                            logger.warning(
                                "translate %s: local attempt %d failed guard: %s",
                                seg.id, attempt + 1, last_err,
                            )
                        if last_err and rewrite_draft and is_cantonese_target(tgt_code):
                            translation_engines.set_runtime_status(
                                provider,
                                "generating",
                                f"Rewriting segment {idx}/{total_segments} as spoken Hong Kong Cantonese",
                                progress_pct=min(97, 45 + round(idx / total_segments * 45)),
                            )
                            rewrite_prompt = _cantonese_rewrite_user_prompt(seg.text, rewrite_draft)
                            out_text = _generate_local_text(rewrite_prompt)
                            if not out_text:
                                last_err = "empty Cantonese rewrite response"
                            else:
                                out_text, was_realized, needs_rewrite = _realize_cantonese_text_for_target(out_text, tgt_code)
                                last_err = (
                                    "Cantonese output needs whole-sentence spoken Hong Kong rewrite"
                                    if needs_rewrite
                                    else _translation_guard_error(out_text, tgt_code)
                                )
                        if last_err:
                            raise RuntimeError(last_err)
                        row = {"id": seg.id, "text": out_text}
                        if is_cantonese_target(tgt_code) and was_realized:
                            row["cantonese_realized"] = True
                        results.append(row)
                    except Exception as e:
                        message = _error_message(e)
                        logger.exception("translate %s: local model failed: %s", seg.id, message)
                        results.append({"id": seg.id, "text": seg.text, "error": message})
                    finally:
                        translation_engines.set_runtime_status(
                            provider,
                            "generating",
                            f"Translated segment {idx}/{total_segments} with {model_id}",
                            progress_pct=min(98, 45 + round(idx / total_segments * 50)),
                        )
                return results

            try:
                translated = await asyncio.wait_for(
                    loop.run_in_executor(_gpu_pool, _translate_local_model),
                    timeout=_local_translation_timeout_seconds(),
                )
            except asyncio.TimeoutError:
                message = (
                    f"{model_id} did not finish within "
                    f"{_local_translation_timeout_seconds():.0f}s. "
                    "The local model may still be downloading, incomplete, or too large for this machine. "
                    "Use HY-MT1.5 1.8B or finish reinstalling the model in Settings > Models."
                )
                translation_engines.set_runtime_status(provider, "error", message)
                return JSONResponse(status_code=504, content={"error": message})
            if os.environ.get("OMNIVOICE_UNLOAD_HYMT", "1") == "1":
                _unload_local_translation_models()
                translation_engines.set_runtime_status(provider, "idle", "Model unloaded after translation")
            else:
                translation_engines.set_runtime_status(provider, "ready", f"{model_id} loaded")
            return {"translated": translated, "target_lang": req.target_lang, "source_lang": src_lang}

        # OpenAI / OpenAI-compatible LLM Translation
        if provider in {"openai", "openai-compatible"}:
            base_url = None if provider == "openai" else os.environ.get("TRANSLATE_BASE_URL")
            if provider == "openai-compatible" and not base_url:
                return JSONResponse(
                    status_code=400,
                    content={"error": "TRANSLATE_BASE_URL is required for OpenAI-compatible translation."},
                )
            model_name = os.environ.get("TRANSLATE_MODEL", "gpt-4o-mini")
            llm_api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
            if provider == "openai" and not llm_api_key:
                return JSONResponse(
                    status_code=400,
                    content={"error": "OPENAI_API_KEY or TRANSLATE_API_KEY is required for OpenAI translation."},
                )
            if provider == "openai-compatible" and not llm_api_key:
                llm_api_key = "local"
            endpoint = (base_url or "https://api.openai.com/v1").rstrip("/") + "/chat/completions"
            total_segments = max(len(req.segments), 1)
            translation_engines.set_runtime_status(
                provider,
                "generating",
                f"Starting translation with {model_name}",
                progress_pct=12,
            )

            def _chat_completion(system_msg: str, user_msg: str) -> str:
                payload = json.dumps({
                    "model": model_name,
                    "temperature": 0.2,
                    "messages": [
                        {"role": "system", "content": system_msg},
                        {"role": "user", "content": user_msg},
                    ],
                }).encode("utf-8")
                headers = {"Content-Type": "application/json"}
                if llm_api_key:
                    headers["Authorization"] = f"Bearer {llm_api_key}"
                request = urllib.request.Request(endpoint, data=payload, headers=headers, method="POST")
                try:
                    with urllib.request.urlopen(request, timeout=120) as response:
                        data = json.loads(response.read().decode("utf-8"))
                except urllib.error.HTTPError as e:
                    detail = e.read().decode("utf-8", errors="replace")
                    raise RuntimeError(f"{e.code} {e.reason}: {detail[:500]}") from e
                return ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "")

            def _build_prompt(src_code: str, tgt_code: str) -> str:
                """Build a system prompt that resists hallucinations on small
                local LLMs. Three things matter:

                1. Use full language names (Hindi, German) not ISO codes —
                   tiny models read 'hi' as a greeting and drift.
                2. For non-Latin targets, name the required script explicitly
                   so the model can't fall back to phonetic Latin or another
                   target it knows better (Hindi → German is a common drift
                   we've actually observed).
                3. End with a strict format guard so the model can't prepend
                   'Translation:' or quote the output.
                """
                src_name = LANG_NAMES.get(src_code, src_code)
                tgt_name = LANG_NAMES.get(tgt_code, tgt_code)
                script_clause = ""
                info = LANG_REQUIRED_SCRIPT.get(tgt_code)
                if info:
                    script_name, _ = info
                    script_clause = (
                        f" The output MUST be written in {script_name} script "
                        f"only — do not use Latin/Roman letters, do not "
                        f"transliterate, do not output any other language."
                    )
                dialect_clause = cantonese_translation_clause() if is_cantonese_target(tgt_code) else ""
                return (
                    f"You are a professional dubbing translator. "
                    f"Translate the user's text from {src_name} into "
                    f"{tgt_name}.{script_clause}{dialect_clause} "
                    f"Reply ONLY with the translated {tgt_name} text, do not "
                    f"add quotes, notes, headers, explanations, or commentary."
                )

            def _translate_llm(seg):
                if not seg.text or not seg.text.strip():
                    return {"id": seg.id, "text": seg.text}
                tgt_code = seg.target_lang if seg.target_lang else req.target_lang
                system_msg = _build_prompt(src_lang, tgt_code)
                last_err = None
                rewrite_draft = ""
                translation_engines.set_runtime_status(
                    provider,
                    "generating",
                    f"Translating segment {seg.id} with {model_name}",
                    progress_pct=35,
                )
                # Up to 2 attempts: if the first response fails the
                # script-ratio gate (e.g. Hindi target but mostly Latin
                # output), retry once with a more emphatic instruction.
                for attempt in range(2):
                    sys_for_attempt = system_msg
                    if attempt == 1:
                        retry_clause = (
                            cantonese_retry_clause()
                            if is_cantonese_target(tgt_code)
                            else (
                                " Your previous attempt produced output in the "
                                "wrong language or script. Output ONLY the "
                                f"{LANG_NAMES.get(tgt_code, tgt_code)} translation."
                            )
                        )
                        sys_for_attempt = system_msg + retry_clause
                    try:
                        out_text = (_chat_completion(sys_for_attempt, seg.text) or "").strip()
                        if not out_text:
                            last_err = "empty LLM response"
                            continue
                        out_text, was_realized, needs_rewrite = _realize_cantonese_text_for_target(out_text, tgt_code)
                        if needs_rewrite:
                            rewrite_draft = out_text
                        guard_err = (
                            "Cantonese output needs whole-sentence spoken Hong Kong rewrite"
                            if needs_rewrite
                            else _translation_guard_error(out_text, tgt_code)
                        )
                        if guard_err:
                            last_err = f"LLM output failed guard: {guard_err}"
                            logger.warning(
                                "translate %s: attempt %d failed guard (%s); retrying",
                                seg.id, attempt + 1, last_err,
                            )
                            continue
                        row = {"id": seg.id, "text": out_text}
                        if is_cantonese_target(tgt_code) and was_realized:
                            row["cantonese_realized"] = True
                        return row
                    except Exception as e:
                        last_err = f"{type(e).__name__}: {e}"
                        logger.warning(
                            "translate %s: LLM attempt %d failed: %s",
                            seg.id, attempt + 1, e,
                        )
                if is_cantonese_target(tgt_code) and rewrite_draft:
                    try:
                        translation_engines.set_runtime_status(
                            provider,
                            "generating",
                            f"Rewriting segment {seg.id} as spoken Hong Kong Cantonese",
                            progress_pct=82,
                        )
                        out_text = (_chat_completion(
                            _cantonese_rewrite_system_prompt(),
                            _cantonese_rewrite_user_prompt(seg.text, rewrite_draft),
                        ) or "").strip()
                        if not out_text:
                            last_err = "empty Cantonese rewrite response"
                        else:
                            out_text, was_realized, needs_rewrite = _realize_cantonese_text_for_target(out_text, tgt_code)
                            guard_err = (
                                "Cantonese output needs whole-sentence spoken Hong Kong rewrite"
                                if needs_rewrite
                                else _translation_guard_error(out_text, tgt_code)
                            )
                            if guard_err:
                                last_err = f"LLM Cantonese rewrite failed guard: {guard_err}"
                            else:
                                row = {"id": seg.id, "text": out_text}
                                if was_realized:
                                    row["cantonese_realized"] = True
                                return row
                    except Exception as e:
                        last_err = f"{type(e).__name__}: {e}"
                        logger.warning("translate %s: LLM Cantonese rewrite failed: %s", seg.id, e)
                # Both attempts failed — keep source text + flag error so the
                # frontend can surface "fallback to literal" warning.
                return {"id": seg.id, "text": seg.text, "error": last_err or "llm-failed"}

            tasks = [loop.run_in_executor(_cpu_pool, _translate_llm, seg) for seg in req.segments]
            translated = await asyncio.gather(*tasks)
            translated.sort(key=lambda x: str(x["id"]))
            failed = [row for row in translated if row.get("error")]
            if failed:
                translation_engines.set_runtime_status(
                    provider,
                    "error",
                    failed[0].get("error") or "Translation failed",
                    progress_pct=None,
                )
            else:
                translation_engines.set_runtime_status(
                    provider,
                    "ready",
                    f"Translated {total_segments} segment{'s' if total_segments != 1 else ''}",
                    progress_pct=100,
                )
            return {"translated": translated, "target_lang": req.target_lang, "source_lang": src_lang}

        # Offline Argos Translate
        if provider == "argos" or provider == "libretranslate":
            def _translate_argos():
                cache_dir = os.environ.get("OMNIVOICE_CACHE_DIR")
                if cache_dir:
                    argos_cache = os.path.join(cache_dir, "argos-translate")
                    os.makedirs(argos_cache, exist_ok=True)
                    os.environ.setdefault("ARGOS_PACKAGES_DIR", argos_cache)
                    os.environ.setdefault("ARGOS_DATA_DIR", argos_cache)
                import argostranslate.package
                import argostranslate.translate

                from_code = src_lang
                available_packages = argostranslate.package.get_installed_packages()

                results = []
                for seg in req.segments:
                    try:
                        if not seg.text or not seg.text.strip():
                            results.append({"id": seg.id, "text": seg.text})
                            continue
                        to_code = seg.target_lang if seg.target_lang else req.target_lang
                        installed_pkg = next(filter(lambda x: x.from_code == from_code and x.to_code == to_code, available_packages), None)

                        if installed_pkg is None:
                            argostranslate.package.update_package_index()
                            all_packages = argostranslate.package.get_available_packages()
                            package_to_install = next(filter(lambda x: x.from_code == from_code and x.to_code == to_code, all_packages), None)
                            if package_to_install:
                                argostranslate.package.install_from_path(package_to_install.download())
                                available_packages = argostranslate.package.get_installed_packages()
                            else:
                                raise Exception(f"No Argos package available for {from_code} -> {to_code}")

                        translated_text = argostranslate.translate.translate(seg.text, from_code, to_code)
                        results.append({"id": seg.id, "text": translated_text})
                    except Exception as e:
                        results.append({"id": seg.id, "text": seg.text, "error": str(e)})
                return results

            translated = await loop.run_in_executor(_cpu_pool, _translate_argos)
            translated = _finalize_translation_rows(translated, req)
            return {"translated": translated, "target_lang": req.target_lang, "source_lang": src_lang}

        # Legacy / API Deep_Translator logic.
        # Preflight the optional `deep_translator` dep once so we fail with a
        # single actionable error instead of N identical per-segment
        # ModuleNotFoundErrors that flood the UI's error badge.
        try:
            import deep_translator  # noqa: F401
        except ImportError:
            friendly = (
                f"The '{provider}' translation engine needs the optional "
                f"`deep_translator` Python package, which isn't installed in "
                f"this backend. Install it with `uv pip install deep_translator` "
                f"(or `pip install deep_translator`) and restart the server, or "
                f"switch the Engine dropdown to Argos (local, bundled), NLLB "
                f"(local, heavier), OpenAI (API), or OpenAI-compatible LLM."
            )
            return JSONResponse(status_code=400, content={"error": friendly})

        src_arg = _deep_translator_code(src_lang) or "auto"

        def _build_translator(src, tgt):
            if provider == "deepl":
                from deep_translator import DeeplTranslator
                return DeeplTranslator(api_key=os.environ.get("DEEPL_API_KEY") or api_key, source=src, target=tgt)
            if provider == "mymemory":
                from deep_translator import MyMemoryTranslator
                return MyMemoryTranslator(source=src, target=tgt)
            if provider == "microsoft":
                from deep_translator import MicrosoftTranslator
                return MicrosoftTranslator(api_key=os.environ.get("MICROSOFT_API_KEY") or api_key, source=src, target=tgt)
            from deep_translator import GoogleTranslator
            return GoogleTranslator(source=src, target=tgt)

        def _translate_single(seg):
            seg_lc = (
                _deep_translator_code(seg.target_lang)
                if seg.target_lang else lang_code
            )
            if not seg.text or not seg.text.strip():
                return {"id": seg.id, "text": seg.text}
            last_err = None
            # Try: (src_arg, tgt) → retry once → fall back to (auto, tgt).
            for attempt, src in enumerate([src_arg, src_arg, "auto"]):
                try:
                    out = _build_translator(src, seg_lc).translate(seg.text)
                    if out and out.strip():
                        return {"id": seg.id, "text": out}
                    last_err = "empty translation"
                except Exception as e:
                    last_err = f"{type(e).__name__}: {e}"
                    logger.warning(
                        "translate attempt %d %s->%s (provider=%s) failed: %s",
                        attempt + 1, src, seg_lc, provider, e,
                    )
                    time.sleep(0.25 * (attempt + 1))
            logger.error("translate %s -> %s gave up (provider=%s): %s", src_arg, seg_lc, provider, last_err)
            return {"id": seg.id, "text": seg.text, "error": last_err or "unknown"}

        total_segments = max(len(req.segments), 1)
        translation_engines.set_runtime_status(
            provider,
            "generating",
            f"Translating {total_segments} segment{'s' if total_segments != 1 else ''} with {provider}",
            progress_pct=20,
        )
        tasks = [loop.run_in_executor(_cpu_pool, _translate_single, seg) for seg in req.segments]
        translated = await asyncio.gather(*tasks)
        translated.sort(key=lambda x: str(x["id"]))
        translated = _finalize_translation_rows(translated, req)
        failed = [row for row in translated if row.get("error")]
        translation_engines.set_runtime_status(
            provider,
            "error" if failed else "ready",
            (failed[0].get("error") if failed else f"Translated {total_segments} segment{'s' if total_segments != 1 else ''}"),
            progress_pct=None if failed else 100,
        )

        return await _maybe_cinematic(
            translated, req, src_lang, loop,
        )
    except Exception as e:
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


async def _maybe_cinematic(translated, req, src_lang, loop):
    """If quality=cinematic and a usable LLM is configured, run REFLECT+ADAPT.
    Otherwise return Fast-mode shape unchanged.
    """
    quality = (getattr(req, "quality", None) or "fast").lower()
    base = {"translated": translated, "target_lang": req.target_lang, "source_lang": src_lang, "quality_used": "fast"}

    if quality != "cinematic":
        return base

    if not cinematic_available():
        logger.warning("cinematic requested but no LLM configured — returning Fast result.")
        base["cinematic_skipped"] = "no-llm-configured"
        return base

    # Build a map from id → original segment (to fetch source text + direction).
    source_by_id: dict[str, str] = {str(s.id): s.text for s in req.segments}
    directions: dict[str, str] = {
        str(s.id): s.direction
        for s in req.segments
        if getattr(s, "direction", None)
    }
    pairs = []
    passthrough_index = {}
    for i, row in enumerate(translated):
        seg_id = str(row["id"])
        literal = row.get("text", "") or ""
        if row.get("error") or not literal.strip():
            passthrough_index[seg_id] = row  # keep as-is, LLM won't help
            continue
        pairs.append((seg_id, source_by_id.get(seg_id, ""), literal))

    if not pairs:
        return base

    refined = await cinematic_refine_many(
        pairs,
        source_lang=src_lang,
        target_lang=req.target_lang,
        glossary=req.glossary,
        directions=directions,
        executor=_cpu_pool,
    )
    refined_by_id = {r["id"]: r for r in refined}

    # Phase 4.4 — speech-rate fit pass. Segment boundaries aren't in the
    # translate request (by design — translator is boundary-agnostic), so we
    # only run it when the caller supplied `slot_seconds` on each segment.
    # The frontend populates this for Cinematic calls from the edit view.
    slots_by_id = {
        str(s.id): getattr(s, "slot_seconds", None)
        for s in req.segments
        if getattr(s, "slot_seconds", None)
    }

    merged = []
    for row in translated:
        seg_id = str(row["id"])
        if seg_id in passthrough_index:
            merged.append(row)
            continue
        r = refined_by_id.get(seg_id)
        if r is None:
            merged.append(row)
            continue
        out = {
            "id": row["id"],
            "text": r["text"],
            "literal": r["literal"],
            "critique": r.get("critique", ""),
        }
        if r.get("error"):
            out["error"] = r["error"]

        # Optional slot-fit pass — only when the caller asked for cinematic
        # *and* provided a slot. Runs best-effort; no-LLM or mid-loop failure
        # just leaves the cinematic text untouched.
        slot = slots_by_id.get(seg_id)
        if slot and out["text"]:
            try:
                from services.speech_rate import adjust_for_slot
                fit = await asyncio.to_thread(
                    adjust_for_slot,
                    out["text"],
                    slot_seconds=float(slot),
                    target_lang=req.target_lang,
                    source_text=source_by_id.get(seg_id),
                )
                if fit.get("text"):
                    out["text"] = fit["text"]
                out["rate_ratio"] = fit.get("rate_ratio")
                if fit.get("error"):
                    out["rate_error"] = fit["error"]
            except Exception as e:
                logger.warning("rate-fit skipped for %s: %s", seg_id, e)

        merged.append(out)

    merged = _finalize_translation_rows(merged, req)
    return {
        "translated": merged,
        "target_lang": req.target_lang,
        "source_lang": src_lang,
        "quality_used": "cinematic",
    }
