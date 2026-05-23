import { test } from 'node:test';
import assert from 'node:assert/strict';

const modulePath = new URL('../../frontend/src/utils/documentReader.js', import.meta.url).pathname;
const {
  ROOT_FOLDER_ID,
  addDocumentToPlaylist,
  buildFolderTree,
  clampPlaybackPosition,
  createFolderRecord,
  createDocumentRecord,
  createDocumentTextBlocks,
  createPlaylistRecord,
  buildDocumentVoiceOptions,
  filterDocumentsForLibrary,
  flattenFolderTree,
  getDocumentPlaybackPlan,
  getPlaybackHighlightRange,
  getReadableDocumentDropFile,
  isReadableDocumentFile,
  makeDocumentAudioCacheKey,
  removeDocumentFromPlaylist,
  splitDocumentText,
} = await import(modulePath);

test('document reader accepts PDFs, Word, RTF, text, and Markdown files', () => {
  const accepted = [
    { name: 'chapter.pdf', type: 'application/pdf' },
    { name: 'brief.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { name: 'legacy.doc', type: 'application/msword' },
    { name: 'notes.rtf', type: 'application/rtf' },
    { name: 'plain.txt', type: 'text/plain' },
    { name: 'draft.md', type: 'text/markdown' },
  ];

  for (const file of accepted) {
    assert.equal(isReadableDocumentFile(file), true, `${file.name} should be accepted`);
  }

  assert.equal(isReadableDocumentFile({ name: 'voice.wav', type: 'audio/wav' }), false);
  assert.equal(isReadableDocumentFile({ name: 'clip.mp4', type: 'video/mp4' }), false);
});

test('document reader drop helper ignores locally handled drops and rejects media', () => {
  const pdf = { name: 'book.pdf', type: 'application/pdf' };
  const wav = { name: 'voice.wav', type: 'audio/wav' };

  assert.equal(getReadableDocumentDropFile({ defaultPrevented: true, dataTransfer: { files: [pdf] } }), null);
  assert.equal(getReadableDocumentDropFile({ dataTransfer: { files: [wav] } }), null);
  assert.equal(getReadableDocumentDropFile({ dataTransfer: { files: [pdf] } }), pdf);
});

test('document text is normalized and split into speakable chunks', () => {
  const text = [
    'First paragraph has a sentence. It has another sentence.',
    '',
    'Second paragraph is deliberately longer so it needs to stand on its own.',
  ].join('\n');

  const chunks = splitDocumentText(text, 72);

  assert.deepEqual(chunks.map(chunk => chunk.index), [0, 1]);
  assert.equal(chunks[0].text, 'First paragraph has a sentence. It has another sentence.');
  assert.equal(chunks[1].text, 'Second paragraph is deliberately longer so it needs to stand on its own.');
  assert.equal(chunks[1].startChar, chunks[0].endChar);
});

test('document records keep import metadata and chunks together', () => {
  const file = { name: 'Read Me.md', type: 'text/markdown', size: 42 };
  const record = createDocumentRecord(file, '# Title\n\nHello document.', 2000);

  assert.equal(record.title, 'Read Me.md');
  assert.equal(record.kind, 'Markdown');
  assert.equal(record.importedAt, 2000);
  assert.equal(record.charCount, 24);
  assert.equal(record.chunks.length, 1);
});

test('playback position clamps to document bounds', () => {
  const chunks = [
    { index: 0, startChar: 0, endChar: 100 },
    { index: 1, startChar: 100, endChar: 250 },
    { index: 2, startChar: 250, endChar: 300 },
  ];

  assert.deepEqual(clampPlaybackPosition(chunks, -10), { chunkIndex: 0, charOffset: 0, progress: 0 });
  assert.deepEqual(clampPlaybackPosition(chunks, 125), { chunkIndex: 1, charOffset: 25, progress: 125 });
  assert.deepEqual(clampPlaybackPosition(chunks, 999), { chunkIndex: 2, charOffset: 50, progress: 300 });
});

test('document playback plan preloads nearby segments without queueing the whole document', () => {
  const chunks = Array.from({ length: 8 }, (_, index) => ({
    index,
    text: `Part ${index}`,
    startChar: index * 100,
    endChar: (index + 1) * 100,
  }));

  assert.deepEqual(
    getDocumentPlaybackPlan(chunks, 2, { prefetchAhead: 2 }),
    { currentIndex: 2, prefetchIndexes: [3, 4] },
  );
  assert.deepEqual(
    getDocumentPlaybackPlan(chunks, 7, { prefetchAhead: 3 }),
    { currentIndex: 7, prefetchIndexes: [] },
  );
  assert.deepEqual(
    getDocumentPlaybackPlan(chunks, -4, { prefetchAhead: 3 }),
    { currentIndex: 0, prefetchIndexes: [1, 2, 3] },
  );
});

test('document audio cache keys isolate document voice chunk and offset', () => {
  assert.equal(
    makeDocumentAudioCacheKey('doc-a', 'engine:kittentts:expr-voice-2-f', 3, 12),
    'doc-a::engine:kittentts:expr-voice-2-f::3::12',
  );
});

test('document text blocks keep full-document character ranges for highlighting', () => {
  const blocks = createDocumentTextBlocks('Title\n\nFirst paragraph.\n\nSecond paragraph.');

  assert.deepEqual(blocks.map(block => block.text), ['Title', 'First paragraph.', 'Second paragraph.']);
  assert.deepEqual(blocks.map(block => [block.startChar, block.endChar]), [[0, 5], [5, 21], [21, 38]]);
});

test('playback highlight range follows audio progress inside the active chunk', () => {
  const chunks = [
    { index: 0, text: 'First sentence. Second sentence.', startChar: 0, endChar: 31 },
    { index: 1, text: 'Another paragraph follows.', startChar: 31, endChar: 57 },
  ];

  assert.deepEqual(
    getPlaybackHighlightRange(chunks, { docId: 'doc-1', chunkIndex: 0 }, 'doc-1', 0, 20, 0),
    { startChar: 0, endChar: 31, chunkIndex: 0 },
  );
  assert.deepEqual(
    getPlaybackHighlightRange(chunks, { docId: 'doc-1', chunkIndex: 1 }, 'doc-1', 10, 20, 31),
    { startChar: 44, endChar: 57, chunkIndex: 1 },
  );
  assert.deepEqual(
    getPlaybackHighlightRange(chunks, { docId: 'other', chunkIndex: 1 }, 'doc-1', 10, 20, 31),
    { startChar: 31, endChar: 57, chunkIndex: 1 },
  );
});

test('folder tree counts documents in folders and subfolders', () => {
  const folders = [
    createFolderRecord('Research', ROOT_FOLDER_ID, 1000, 'research'),
    createFolderRecord('Methods', 'research', 1001, 'methods'),
  ];
  const documents = [
    { id: 'a', folderId: 'research' },
    { id: 'b', folderId: 'methods' },
    { id: 'c' },
  ];

  const tree = buildFolderTree(folders, documents);
  const flat = flattenFolderTree(tree);

  assert.equal(tree.totalDocumentCount, 3);
  assert.equal(flat.find(item => item.id === 'research').totalDocumentCount, 2);
  assert.equal(flat.find(item => item.id === 'methods').documentCount, 1);
  assert.deepEqual(flat.map(item => item.id), [ROOT_FOLDER_ID, 'research', 'methods']);
});

test('library filters combine folder descendants, document type, query, and playlists', () => {
  const folders = [
    { id: 'research', parentId: ROOT_FOLDER_ID, name: 'Research' },
    { id: 'methods', parentId: 'research', name: 'Methods' },
  ];
  const documents = [
    { id: 'alpha', title: 'Alpha paper.pdf', text: 'study', kind: 'PDF', folderId: 'research' },
    { id: 'beta', title: 'Beta methods.docx', text: 'alpha protocol', kind: 'Word', folderId: 'methods' },
    { id: 'gamma', title: 'Gamma notes.md', text: 'alpha', kind: 'Markdown', folderId: ROOT_FOLDER_ID },
  ];
  const playlists = [createPlaylistRecord('Morning', ['alpha', 'gamma'], 1200, 'morning')];

  assert.deepEqual(
    filterDocumentsForLibrary(documents, { folders, folderId: 'research', kind: 'Word', query: 'alpha' }).map(doc => doc.id),
    ['beta'],
  );
  assert.deepEqual(
    filterDocumentsForLibrary(documents, { playlists, playlistId: 'morning', query: 'alpha' }).map(doc => doc.id),
    ['alpha', 'gamma'],
  );
});

test('playlist helpers keep document ids unique and removable', () => {
  const playlist = createPlaylistRecord('Commute', ['a', 'a'], 1300, 'commute');

  assert.deepEqual(playlist.documentIds, ['a']);
  assert.deepEqual(addDocumentToPlaylist(playlist, 'b').documentIds, ['a', 'b']);
  assert.deepEqual(addDocumentToPlaylist(playlist, 'a').documentIds, ['a']);
  assert.deepEqual(removeDocumentFromPlaylist({ ...playlist, documentIds: ['a', 'b'] }, 'a').documentIds, ['b']);
});

test('document voice options include profile voices and installed engine voices', () => {
  const profiles = [{ id: 'clone-1', name: 'Saved Clone', kind: 'clone', language: 'English' }];
  const engineData = {
    active: 'kittentts',
    backends: [
      {
        id: 'kittentts',
        display_name: 'KittenTTS',
        available: true,
        voices: [
          { id: 'expr-voice-2-f', name: 'Kitten Female 2', engine_id: 'kittentts', kind: 'preset', parameter: 'voice' },
        ],
      },
      {
        id: 'cosyvoice',
        display_name: 'CosyVoice',
        available: false,
        voices: [
          { id: '中文女', name: 'Chinese Female', engine_id: 'cosyvoice', kind: 'preset', parameter: 'voice' },
        ],
      },
    ],
  };

  const options = buildDocumentVoiceOptions(profiles, engineData);

  assert.deepEqual(options.map(option => option.value), [
    'engine:kittentts:expr-voice-2-f',
    'profile:clone-1',
  ]);
  assert.equal(options[0].engineId, 'kittentts');
  assert.equal(options[0].voiceId, 'expr-voice-2-f');
  assert.equal(options[0].parameter, 'voice');
  assert.equal(options[1].profileId, 'clone-1');
});
