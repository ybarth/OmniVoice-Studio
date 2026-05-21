import { test } from 'node:test';
import assert from 'node:assert/strict';

const utilsPath = new URL('../../frontend/src/utils/audioPlaybackState.ts', import.meta.url).pathname;
const {
  playbackControlFor,
} = await import(utilsPath);

test('playback control pauses the active playing item', () => {
  assert.deepEqual(playbackControlFor({
    activeKey: 'turn-1',
    key: 'turn-1',
    status: 'playing',
    hasAudio: true,
  }), {
    visible: true,
    disabled: false,
    label: 'Pause',
    title: 'Pause playback',
    action: 'pause',
    icon: 'pause',
  });
});

test('playback control resumes the active paused item', () => {
  assert.deepEqual(playbackControlFor({
    activeKey: 'prompt',
    key: 'prompt',
    status: 'paused',
    hasAudio: true,
  }), {
    visible: true,
    disabled: false,
    label: 'Resume',
    title: 'Resume playback',
    action: 'resume',
    icon: 'play',
  });
});

test('playback control replays ended audio and plays inactive turns', () => {
  assert.deepEqual(playbackControlFor({
    activeKey: 'turn-1',
    key: 'turn-1',
    status: 'ended',
    hasAudio: true,
  }), {
    visible: true,
    disabled: false,
    label: 'Replay',
    title: 'Replay audio',
    action: 'play',
    icon: 'play',
  });

  assert.equal(playbackControlFor({
    activeKey: 'turn-1',
    key: 'turn-2',
    status: 'playing',
    hasAudio: true,
  }).label, 'Play');
});

test('playback control hides when there is no audio', () => {
  assert.deepEqual(playbackControlFor({
    activeKey: '',
    key: 'turn-1',
    status: 'idle',
    hasAudio: false,
  }), {
    visible: false,
    disabled: true,
    label: 'Play',
    title: 'No audio available',
    action: 'none',
    icon: 'play',
  });
});
