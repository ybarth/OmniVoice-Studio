import { test } from 'node:test';
import assert from 'node:assert/strict';

const utilsPath = new URL('../../frontend/src/utils/conversationSession.ts', import.meta.url).pathname;
const {
  addConversationSpeaker,
  buildConversationExportSelection,
  createConversationTurn,
  createDefaultSpeakers,
  orderConversationSpeakersByActive,
  speakerDefaultsForTurn,
  updateSpeakerMemory,
} = await import(utilsPath);

test('createDefaultSpeakers gives each side independent language and voice memory', () => {
  const profiles = [
    { id: 'p1', name: 'Yishai' },
    { id: 'p2', name: 'Guest' },
  ];

  const speakers = createDefaultSpeakers(profiles, 'openai');

  assert.equal(speakers.length, 2);
  assert.equal(speakers[0].name, 'Speaker 1');
  assert.equal(speakers[1].name, 'Speaker 2');
  assert.equal(speakers[0].sourceLanguage, 'English');
  assert.equal(speakers[0].targetLanguage, 'Cantonese');
  assert.equal(speakers[0].translationProvider, 'openai');
  assert.equal(speakers[0].voiceProfileId, 'p1');
  assert.equal(speakers[1].sourceLanguage, 'Cantonese');
  assert.equal(speakers[1].targetLanguage, 'English');
  assert.equal(speakers[1].voiceProfileId, 'p2');
});

test('updateSpeakerMemory only changes the selected speaker defaults', () => {
  const speakers = createDefaultSpeakers([], 'hymt-1.8b');
  const next = updateSpeakerMemory(speakers, 'speaker-b', {
    targetLanguage: 'Hebrew',
    translationProvider: 'openai',
    voiceProfileId: 'voice-2',
  });

  assert.equal(next[0].targetLanguage, 'Cantonese');
  assert.equal(next[0].translationProvider, 'hymt-1.8b');
  assert.equal(next[1].targetLanguage, 'Hebrew');
  assert.equal(next[1].translationProvider, 'openai');
  assert.equal(next[1].voiceProfileId, 'voice-2');
});

test('speakerDefaultsForTurn returns the remembered defaults for the active speaker', () => {
  const speakers = updateSpeakerMemory(createDefaultSpeakers([], 'google'), 'speaker-a', {
    sourceLanguage: 'English',
    targetLanguage: 'Cantonese',
    style: 'young adult',
    referenceTranscript: 'reference words',
  });

  const defaults = speakerDefaultsForTurn(speakers, 'speaker-a');

  assert.equal(defaults.sourceLanguage, 'English');
  assert.equal(defaults.targetLanguage, 'Cantonese');
  assert.equal(defaults.style, 'young adult');
  assert.equal(defaults.referenceTranscript, 'reference words');
});

test('createConversationTurn stores source, translation, audio, and engine metadata', () => {
  const speaker = updateSpeakerMemory(createDefaultSpeakers([], 'openai'), 'speaker-a', {
    targetLanguage: 'Cantonese',
    voiceProfileId: 'clone-1',
  })[0];

  const turn = createConversationTurn({
    speaker,
    sourceText: 'Out of sight.',
    translatedText: '睇唔到。',
    audioUrl: 'blob:turn-audio',
    audioId: 'abc123',
    audioPath: 'turn_abc123.wav',
    sourceAudioUrl: 'blob:source-turn',
    sourceAudioName: 'spoken-turn.webm',
    sourceAudioTranscriptEngine: 'nemo-parakeet',
    createdAt: 1234,
  });

  assert.equal(turn.speakerId, 'speaker-a');
  assert.equal(turn.speakerName, 'Speaker 1');
  assert.equal(turn.sourceText, 'Out of sight.');
  assert.equal(turn.translatedText, '睇唔到。');
  assert.equal(turn.targetLanguage, 'Cantonese');
  assert.equal(turn.voiceProfileId, 'clone-1');
  assert.equal(turn.translationProvider, 'openai');
  assert.equal(turn.audioUrl, 'blob:turn-audio');
  assert.equal(turn.audioId, 'abc123');
  assert.equal(turn.audioPath, 'turn_abc123.wav');
  assert.equal(turn.sourceAudioUrl, 'blob:source-turn');
  assert.equal(turn.sourceAudioName, 'spoken-turn.webm');
  assert.equal(turn.sourceAudioTranscriptEngine, 'nemo-parakeet');
  assert.equal(turn.createdAt, 1234);
});

test('addConversationSpeaker appends numbered speakers and mounts the next profile', () => {
  const profiles = [
    { id: 'p1', name: 'Voice 1' },
    { id: 'p2', name: 'Voice 2' },
    { id: 'p3', name: 'Voice 3' },
  ];
  const speakers = createDefaultSpeakers(profiles, 'openai');

  const next = addConversationSpeaker(speakers, profiles, 'google');
  const fourth = addConversationSpeaker(next, profiles, 'google');

  assert.equal(next.length, 3);
  assert.equal(next[2].id, 'speaker-3');
  assert.equal(next[2].name, 'Speaker 3');
  assert.equal(next[2].voiceProfileId, 'p3');
  assert.equal(next[2].translationProvider, 'google');
  assert.equal(fourth[3].id, 'speaker-4');
  assert.equal(fourth[3].name, 'Speaker 4');
  assert.equal(fourth[3].voiceProfileId, '');
});

test('orderConversationSpeakersByActive moves selected speaker first without mutating speaker memory', () => {
  const speakers = createDefaultSpeakers([], 'openai');
  const third = addConversationSpeaker(speakers, [], 'openai');

  const ordered = orderConversationSpeakersByActive(third, 'speaker-b');

  assert.deepEqual(
    ordered.map(speaker => speaker.id),
    ['speaker-b', 'speaker-a', 'speaker-3'],
  );
  assert.deepEqual(
    third.map(speaker => speaker.id),
    ['speaker-a', 'speaker-b', 'speaker-3'],
  );
  assert.notEqual(ordered, third);
});

test('buildConversationExportSelection supports all selected, range, and speaker combinations', () => {
  const speakers = createDefaultSpeakers([], 'openai');
  const turns = [
    createConversationTurn({ speaker: speakers[0], sourceText: 'one', translatedText: '一', createdAt: 1 }),
    createConversationTurn({ speaker: speakers[1], sourceText: 'two', translatedText: '二', createdAt: 2 }),
    createConversationTurn({ speaker: { ...speakers[0], id: 'speaker-3', name: 'Speaker 3' }, sourceText: 'three', translatedText: '三', createdAt: 3 }),
    createConversationTurn({ speaker: speakers[1], sourceText: 'four', translatedText: '四', createdAt: 4 }),
  ];

  assert.deepEqual(
    buildConversationExportSelection(turns, { scope: 'all' }).map(turn => turn.sourceText),
    ['one', 'two', 'three', 'four'],
  );
  assert.deepEqual(
    buildConversationExportSelection(turns, { scope: 'selected', selectedTurnIds: [turns[1].id, turns[3].id] }).map(turn => turn.sourceText),
    ['two', 'four'],
  );
  assert.deepEqual(
    buildConversationExportSelection(turns, { scope: 'range', rangeStart: 2, rangeEnd: 3 }).map(turn => turn.sourceText),
    ['two', 'three'],
  );
  assert.deepEqual(
    buildConversationExportSelection(turns, { scope: 'speakers', speakerIds: ['speaker-b', 'speaker-3'] }).map(turn => turn.sourceText),
    ['two', 'three', 'four'],
  );
});
