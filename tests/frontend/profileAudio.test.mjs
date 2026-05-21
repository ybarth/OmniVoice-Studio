import { test } from 'node:test';
import assert from 'node:assert/strict';

const profileAudioPathModule = new URL('../../frontend/src/utils/profileAudio.ts', import.meta.url).pathname;
const { profileAudioPath, profilePhotoPath } = await import(profileAudioPathModule);

test('profileAudioPath points at the saved reference audio endpoint', () => {
  const url = profileAudioPath('voice 1', 'stamp value');

  assert.equal(url, '/profiles/voice%201/audio?t=stamp%20value');
});

test('profileAudioPath falls back to a cache-busting timestamp token', () => {
  const url = profileAudioPath('abc123');

  assert.match(url, /\/profiles\/abc123\/audio\?t=\d+$/);
});

test('profilePhotoPath points at the saved profile photo endpoint', () => {
  const url = profilePhotoPath('voice 1', 'photo stamp');

  assert.equal(url, '/profiles/voice%201/photo?t=photo%20stamp');
});
