# 260521-nao Summary: Fix Cantonese Translation Rewrite Failure

## Result

- Fixed the translation failure where English to Cantonese could abort with:
  `Cantonese output needs whole-sentence spoken Hong Kong rewrite`
- That specific Cantonese rewrite-needed state now returns the best available Cantonese draft with metadata instead of a row-level `error`.
- True failures still remain errors: empty model responses, wrong-script output, model load failures, missing config, and network/API failures.

## Root Cause

The Cantonese guard/rewrite path was treating "still needs whole-sentence rewrite" as fatal even after the backend had a usable Cantonese-realized draft. The frontend throws any `/dub/translate` row-level `error`, so this guard detail surfaced as a full translation failure.

## Fix

- Added a shared Cantonese rewrite warning helper in `backend/api/routers/dub_translate.py`.
- Updated the Google/finalizer path to set `needs_cantonese_rewrite` and `cantonese_rewrite_warning` without `error`.
- Updated HY-MT/local-model and OpenAI/OpenAI-compatible paths to preserve the best Cantonese draft when their rewrite attempt still trips the same whole-sentence guard.

## Verification

- Added failing regression tests for:
  - Google/finalizer best-effort Cantonese rewrite-needed output.
  - HY-MT/local-model rewrite-needed output.
  - OpenAI rewrite-needed output.
- Ran `uv run pytest tests/test_dub_translate.py -q` successfully.
- Ran `uv run pytest tests/test_cantonese_guard.py tests/test_generation_validation.py -q` successfully.
- Ran `bun run test:frontend` successfully.
- Ran `bun run --cwd frontend test` successfully.
- Ran `bun run --cwd frontend typecheck:ci` successfully.
- Ran `bun run --cwd frontend build` successfully.
