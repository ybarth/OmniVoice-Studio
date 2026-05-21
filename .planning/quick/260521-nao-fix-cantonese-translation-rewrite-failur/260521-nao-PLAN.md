# 260521-nao Plan: Fix Cantonese Translation Rewrite Failure

## Problem

Remote users translating English to Cantonese can see:

`Translation failed: Cantonese output needs whole-sentence spoken Hong Kong rewrite`

The frontend shows this when `/dub/translate` returns a row-level `error`.

## Root Cause

The backend Cantonese guard correctly detects when a translation draft is mostly Cantonese but still has written-Chinese grammar. It attempts a retry/rewrite path. If the final rewrite still trips the same whole-sentence guard, the backend marks the row as an error even when it has a usable best-effort Cantonese-realized draft.

That is too harsh for translation UX. It aborts prompt/conversation translation instead of returning the best local result with a warning flag.

## Fix

- Treat the specific `needs whole-sentence spoken Hong Kong rewrite` state as non-fatal when a Cantonese draft exists.
- Return the best available Cantonese text with `needs_cantonese_rewrite` metadata instead of `error`.
- Keep true failures as errors: empty responses, wrong script/language, model load failures, missing config, network failures.

## Verification

- Add failing tests for Google/finalizer and OpenAI rewrite-still-needed cases.
- Run the focused backend test file.
- Run frontend translation API tests.
- Run broader frontend/build checks before commit.
