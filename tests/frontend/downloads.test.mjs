import { test } from 'node:test';
import assert from 'node:assert/strict';

const downloadsPath = new URL('../../frontend/src/utils/downloads.ts', import.meta.url).pathname;
const { historyAudioDownloadUrl, safeDownloadName } = await import(downloadsPath);

test('historyAudioDownloadUrl builds browser-safe generated-audio URL', () => {
  assert.equal(
    historyAudioDownloadUrl('sample voice.wav'),
    'http://127.0.0.1:3900/audio/sample%20voice.wav',
  );
});

test('historyAudioDownloadUrl strips path components before encoding', () => {
  assert.equal(
    historyAudioDownloadUrl('../unsafe/sample.wav'),
    'http://127.0.0.1:3900/audio/sample.wav',
  );
});

test('safeDownloadName keeps basename and falls back when empty', () => {
  assert.equal(safeDownloadName('../unsafe/sample.wav', 'fallback.wav'), 'sample.wav');
  assert.equal(safeDownloadName('', 'fallback.wav'), 'fallback.wav');
  assert.equal(safeDownloadName('', ''), 'download.wav');
});
