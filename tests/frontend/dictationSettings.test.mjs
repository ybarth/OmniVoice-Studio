import { test } from 'node:test';
import assert from 'node:assert/strict';

const utilsPath = new URL('../../frontend/src/utils/dictationSettings.ts', import.meta.url).pathname;
const {
  DEFAULT_DICTATION_BACKEND,
  LS_CAPTURE_ASR_BACKEND,
  LS_CAPTURE_MODE,
  buildDictationFormData,
  conversationDictationControlState,
  normalizeAudioLevels,
  readDictationSettings,
} = await import(utilsPath);

test('readDictationSettings falls back to fast auto capture', () => {
  const storage = { getItem: () => null };

  assert.deepEqual(readDictationSettings(storage), {
    mode: 'fast',
    backend: DEFAULT_DICTATION_BACKEND,
  });
});

test('readDictationSettings keeps explicit Parakeet or Whisper backend choices', () => {
  const values = new Map([
    [LS_CAPTURE_MODE, 'accurate'],
    [LS_CAPTURE_ASR_BACKEND, 'nemo-parakeet'],
  ]);

  assert.deepEqual(readDictationSettings({ getItem: key => values.get(key) || null }), {
    mode: 'accurate',
    backend: 'nemo-parakeet',
  });
});

test('buildDictationFormData sends mode, backend, language, and audio', async () => {
  const blob = new Blob(['fake'], { type: 'audio/webm' });
  const formData = buildDictationFormData(blob, {
    filename: 'turn.webm',
    language: 'English',
    mode: 'fast',
    backend: 'faster-whisper',
  });

  assert.equal(formData.get('mode'), 'fast');
  assert.equal(formData.get('backend'), 'faster-whisper');
  assert.equal(formData.get('language'), 'English');
  assert.equal(formData.get('audio').name, 'turn.webm');
});

test('conversation dictation control starts recording when no turn audio exists', () => {
  assert.deepEqual(conversationDictationControlState({
    isWorking: false,
    isTurnRecording: false,
    isDictatingText: false,
    isTurnTranscribing: false,
    hasTurnAudio: false,
  }), {
    disabled: false,
    label: 'Dictate Text',
    action: 'start-recording',
  });
});

test('conversation dictation control stops active dictation recording', () => {
  assert.deepEqual(conversationDictationControlState({
    isWorking: false,
    isTurnRecording: true,
    isDictatingText: true,
    isTurnTranscribing: false,
    hasTurnAudio: false,
  }), {
    disabled: false,
    label: 'Stop Dictation',
    action: 'stop-recording',
  });
});

test('normalizeAudioLevels converts analyser bytes into stable visual bins', () => {
  assert.deepEqual(normalizeAudioLevels(new Uint8Array([0, 128, 255, 64]), 4), [0, 0.5, 1, 0.25]);
  assert.deepEqual(normalizeAudioLevels(new Uint8Array([]), 3), [0, 0, 0]);
});
