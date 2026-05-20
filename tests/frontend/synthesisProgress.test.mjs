import { test } from 'node:test';
import assert from 'node:assert/strict';

const utilsPath = new URL('../../frontend/src/utils/synthesisProgress.ts', import.meta.url).href;
const {
  selectSynthesisProgressView,
} = await import(utilsPath);

test('synthesis progress stays indeterminate during model inference instead of faking a near-complete stall', () => {
  const view = selectSynthesisProgressView({
    backendStatus: {
      status: 'running',
      phase: 'inferencing',
      detail: 'Synthesizing audio with the TTS model',
      progress_pct: null,
    },
    elapsedSeconds: 37.4,
  });

  assert.equal(view.label, 'Synthesizing audio');
  assert.equal(view.detail, 'Synthesizing audio with the TTS model');
  assert.equal(view.progress, null);
  assert.equal(view.elapsedLabel, '37.4s');
});

test('synthesis progress maps response download onto the final receiving-audio range', () => {
  const view = selectSynthesisProgressView({
    backendStatus: {
      status: 'running',
      phase: 'streaming',
      detail: 'Streaming generated WAV',
      progress_pct: 96,
    },
    streamProgressPct: 50,
    elapsedSeconds: 4,
  });

  assert.equal(view.label, 'Receiving audio');
  assert.equal(view.progress, 95);
  assert.equal(view.elapsedLabel, '4.0s');
});

test('translation phase surfaces the selected engine detail and progress', () => {
  const view = selectSynthesisProgressView({
    clientPhase: 'translating',
    translationEngine: {
      display_name: 'HY-MT1.5 7B',
      runtime_detail: 'Rewriting segment 1/1 as spoken Hong Kong Cantonese',
      runtime_progress_pct: 97,
    },
    elapsedSeconds: 11,
  });

  assert.equal(view.label, 'Translating prompt');
  assert.equal(view.detail, 'Rewriting segment 1/1 as spoken Hong Kong Cantonese');
  assert.equal(view.progress, 97);
});

test('idle backend poll does not override an active client synthesis phase', () => {
  const view = selectSynthesisProgressView({
    clientPhase: 'requesting',
    backendStatus: {
      status: 'idle',
      phase: 'idle',
      detail: '',
      progress_pct: null,
    },
    elapsedSeconds: 0.5,
  });

  assert.equal(view.label, 'Starting synthesis');
  assert.equal(view.progress, 18);
});

test('client finalizing phase overrides stale backend streaming status', () => {
  const view = selectSynthesisProgressView({
    clientPhase: 'finalizing',
    backendStatus: {
      status: 'running',
      phase: 'streaming',
      detail: 'Streaming generated WAV',
      progress_pct: 96,
    },
    streamProgressPct: 100,
    elapsedSeconds: 9,
  });

  assert.equal(view.label, 'Finalizing audio');
  assert.equal(view.progress, 99);
});
