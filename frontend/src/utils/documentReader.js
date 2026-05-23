const DOCUMENT_EXTENSION_RE = /\.(pdf|docx?|rtf|txt|text|md|markdown)$/i;

const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/rtf',
  'text/rtf',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const KIND_BY_EXTENSION = {
  pdf: 'PDF',
  doc: 'Word',
  docx: 'Word',
  rtf: 'RTF',
  txt: 'Text',
  text: 'Text',
  md: 'Markdown',
  markdown: 'Markdown',
};

export const ROOT_FOLDER_ID = 'root';
export const ALL_DOCUMENTS_FILTER = 'all';

export const DOCUMENT_ACCEPT = [
  '.pdf',
  '.doc',
  '.docx',
  '.rtf',
  '.txt',
  '.text',
  '.md',
  '.markdown',
  'application/pdf',
  'application/msword',
  'application/rtf',
  'text/rtf',
  'text/plain',
  'text/markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
].join(',');

export function isReadableDocumentFile(file) {
  if (!file) return false;
  const name = file.name || '';
  const type = file.type || '';
  return DOCUMENT_EXTENSION_RE.test(name) || DOCUMENT_MIME_TYPES.has(type);
}

export function getReadableDocumentDropFile(event) {
  if (event?.defaultPrevented) return null;
  const file = event?.dataTransfer?.files?.[0];
  return isReadableDocumentFile(file) ? file : null;
}

export function documentKindForFile(fileOrName) {
  const name = typeof fileOrName === 'string' ? fileOrName : fileOrName?.name || '';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return KIND_BY_EXTENSION[ext] || 'Document';
}

export function normalizeDocumentText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLongParagraph(paragraph, maxChars) {
  const sentences = paragraph
    .split(/(?<=[.!?。！？])\s+/)
    .map(item => item.trim())
    .filter(Boolean);
  const units = sentences.length > 1 ? sentences : paragraph.split(/\s+/);
  const chunks = [];
  let current = '';
  for (const unit of units) {
    const sep = current && sentences.length > 1 ? ' ' : (current ? ' ' : '');
    if (current && current.length + sep.length + unit.length > maxChars) {
      chunks.push(current);
      current = unit;
    } else {
      current = current ? `${current}${sep}${unit}` : unit;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitDocumentText(text, maxChars = 900) {
  const normalized = normalizeDocumentText(text);
  if (!normalized) return [];

  const pieces = normalized
    .split(/\n{2,}/)
    .flatMap(paragraph => (
      paragraph.length > maxChars
        ? splitLongParagraph(paragraph, maxChars)
        : [paragraph.trim()]
    ))
    .filter(Boolean);

  const chunks = [];
  let current = '';
  let cursor = 0;
  const flush = () => {
    const trimmed = current.trim();
    if (!trimmed) return;
    chunks.push({
      index: chunks.length,
      text: trimmed,
      startChar: cursor,
      endChar: cursor + trimmed.length,
    });
    cursor += trimmed.length;
    current = '';
  };

  for (const piece of pieces) {
    if (!current) {
      current = piece;
    } else if (current.length + 2 + piece.length <= maxChars) {
      current = `${current}\n\n${piece}`;
    } else {
      flush();
      current = piece;
    }
  }
  flush();
  return chunks;
}

export function createDocumentRecord(file, text, importedAt = Date.now()) {
  const normalized = normalizeDocumentText(text);
  return {
    id: globalThis.crypto?.randomUUID?.() || `doc-${importedAt}-${Math.random().toString(16).slice(2)}`,
    title: file?.name || 'Untitled document',
    kind: documentKindForFile(file),
    size: file?.size || 0,
    importedAt,
    text: normalized,
    charCount: normalized.length,
    chunks: splitDocumentText(normalized),
    currentChunkIndex: 0,
    currentProgress: 0,
    folderId: ROOT_FOLDER_ID,
  };
}

function makeLocalId(prefix, createdAt) {
  return `${prefix}-${createdAt}-${Math.random().toString(16).slice(2)}`;
}

export function createFolderRecord(name, parentId = ROOT_FOLDER_ID, createdAt = Date.now(), id = null) {
  const cleanName = String(name || '').trim() || 'Untitled folder';
  return {
    id: id || makeLocalId('folder', createdAt),
    name: cleanName,
    parentId: parentId || ROOT_FOLDER_ID,
    createdAt,
  };
}

export function createPlaylistRecord(name, documentIds = [], createdAt = Date.now(), id = null) {
  const cleanName = String(name || '').trim() || 'Untitled playlist';
  return {
    id: id || makeLocalId('playlist', createdAt),
    name: cleanName,
    documentIds: [...new Set((documentIds || []).filter(Boolean))],
    createdAt,
  };
}

export function addDocumentToPlaylist(playlist, documentId) {
  if (!playlist || !documentId || playlist.documentIds?.includes(documentId)) return playlist;
  return {
    ...playlist,
    documentIds: [...(playlist.documentIds || []), documentId],
  };
}

export function removeDocumentFromPlaylist(playlist, documentId) {
  if (!playlist) return playlist;
  return {
    ...playlist,
    documentIds: (playlist.documentIds || []).filter(id => id !== documentId),
  };
}

function sortLibraryItems(a, b) {
  const aCreated = Number(a.createdAt) || 0;
  const bCreated = Number(b.createdAt) || 0;
  if (aCreated !== bCreated) return aCreated - bCreated;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

export function buildFolderTree(folders = [], documents = []) {
  const root = {
    id: ROOT_FOLDER_ID,
    name: 'Library',
    parentId: '',
    createdAt: 0,
    children: [],
    documentCount: 0,
    totalDocumentCount: 0,
    depth: 0,
  };
  const nodes = new Map([[ROOT_FOLDER_ID, root]]);

  folders
    .filter(folder => folder?.id && folder.id !== ROOT_FOLDER_ID)
    .forEach((folder, index) => {
      nodes.set(folder.id, {
        id: folder.id,
        name: String(folder.name || '').trim() || 'Untitled folder',
        parentId: folder.parentId || ROOT_FOLDER_ID,
        createdAt: folder.createdAt || index + 1,
        children: [],
        documentCount: 0,
        totalDocumentCount: 0,
        depth: 0,
      });
    });

  for (const node of nodes.values()) {
    if (node.id === ROOT_FOLDER_ID) continue;
    const parent = node.parentId !== node.id && nodes.get(node.parentId)
      ? nodes.get(node.parentId)
      : root;
    node.parentId = parent.id;
    parent.children.push(node);
  }

  for (const doc of documents) {
    const folderId = nodes.has(doc?.folderId) ? doc.folderId : ROOT_FOLDER_ID;
    nodes.get(folderId).documentCount += 1;
  }

  const finalize = (node, depth = 0, seen = new Set()) => {
    node.depth = depth;
    node.children.sort(sortLibraryItems);
    if (seen.has(node.id)) {
      node.children = [];
      node.totalDocumentCount = node.documentCount;
      return node.totalDocumentCount;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(node.id);
    node.totalDocumentCount = node.documentCount + node.children.reduce(
      (sum, child) => sum + finalize(child, depth + 1, nextSeen),
      0,
    );
    return node.totalDocumentCount;
  };

  finalize(root);
  return root;
}

export function flattenFolderTree(tree) {
  if (!tree) return [];
  const flat = [];
  const visit = (node) => {
    flat.push(node);
    node.children?.forEach(visit);
  };
  visit(tree);
  return flat;
}

export function getDescendantFolderIds(folders = [], folderId = ROOT_FOLDER_ID) {
  const tree = buildFolderTree(folders, []);
  const start = flattenFolderTree(tree).find(node => node.id === folderId) || tree;
  return flattenFolderTree(start).map(node => node.id);
}

export function filterDocumentsForLibrary(documents = [], options = {}) {
  const {
    folders = [],
    playlists = [],
    folderId = ROOT_FOLDER_ID,
    playlistId = '',
    kind = ALL_DOCUMENTS_FILTER,
    query = '',
  } = options;
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const normalizedKind = kind || ALL_DOCUMENTS_FILTER;
  const playlist = playlistId ? playlists.find(item => item.id === playlistId) : null;
  const allowedPlaylistIds = playlist ? new Set(playlist.documentIds || []) : null;
  const allowedFolderIds = allowedPlaylistIds
    ? null
    : new Set(getDescendantFolderIds(folders, folderId || ROOT_FOLDER_ID));

  return documents.filter((doc) => {
    if (allowedPlaylistIds && !allowedPlaylistIds.has(doc.id)) return false;
    if (allowedFolderIds && !allowedFolderIds.has(doc.folderId || ROOT_FOLDER_ID)) return false;
    if (normalizedKind !== ALL_DOCUMENTS_FILTER && doc.kind !== normalizedKind) return false;
    if (!normalizedQuery) return true;
    return `${doc.title || ''} ${doc.kind || ''} ${doc.text || ''}`.toLowerCase().includes(normalizedQuery);
  });
}

export function buildDocumentVoiceOptions(profiles = [], engineData = null) {
  const backends = Array.isArray(engineData?.backends) ? engineData.backends : [];
  const engineOptions = backends
    .filter(backend => backend?.available !== false)
    .flatMap((backend) => {
      const voices = Array.isArray(backend.voices) && backend.voices.length
        ? backend.voices
        : [{
          id: 'default',
          name: 'Default voice',
          engine_id: backend.id,
          kind: 'default',
          parameter: null,
        }];
      return voices.map((voice) => {
        const voiceId = String(voice.id || 'default');
        return {
          value: `engine:${backend.id}:${voiceId}`,
          type: 'engine',
          label: voice.name || voiceId,
          detail: backend.display_name || backend.id,
          engineId: backend.id,
          voiceId,
          parameter: voice.parameter || null,
          language: voice.language || '',
          default: Boolean(voice.default || (engineData?.active === backend.id && voiceId === 'default')),
        };
      });
    });

  const profileOptions = (profiles || []).map(profile => ({
    value: `profile:${profile.id}`,
    type: 'profile',
    label: profile.name || profile.id,
    detail: profile.kind === 'design' || profile.instruct ? 'design profile' : 'voice profile',
    profileId: profile.id,
    profile,
    language: profile.language || profile.language_code || '',
  }));

  return [...engineOptions, ...profileOptions];
}

export function clampPlaybackPosition(chunks, requestedProgress) {
  if (!chunks?.length) return { chunkIndex: 0, charOffset: 0, progress: 0 };
  const total = chunks[chunks.length - 1].endChar || 0;
  const progress = Math.max(0, Math.min(Number(requestedProgress) || 0, total));
  const chunk = chunks.find(item => progress < item.endChar) || chunks[chunks.length - 1];
  return {
    chunkIndex: chunk.index,
    charOffset: Math.max(0, progress - chunk.startChar),
    progress,
  };
}

export function getDocumentPlaybackPlan(chunks = [], startIndex = 0, options = {}) {
  if (!chunks.length) return { currentIndex: 0, prefetchIndexes: [] };
  const prefetchAhead = Math.max(0, Math.floor(Number(options.prefetchAhead) || 0));
  const currentIndex = Math.max(0, Math.min(Math.floor(Number(startIndex) || 0), chunks.length - 1));
  const prefetchIndexes = [];
  for (
    let index = currentIndex + 1;
    index < chunks.length && prefetchIndexes.length < prefetchAhead;
    index += 1
  ) {
    prefetchIndexes.push(index);
  }
  return { currentIndex, prefetchIndexes };
}

export function makeDocumentAudioCacheKey(documentId, voiceValue, chunkIndex, offset = 0) {
  return [
    String(documentId || ''),
    String(voiceValue || ''),
    String(Math.max(0, Math.floor(Number(chunkIndex) || 0))),
    String(Math.max(0, Math.floor(Number(offset) || 0))),
  ].join('::');
}

export function createDocumentTextBlocks(text) {
  const normalized = normalizeDocumentText(text);
  if (!normalized) return [];

  let cursor = 0;
  return normalized
    .split(/\n{2,}/)
    .map(blockText => blockText.trim())
    .filter(Boolean)
    .map((blockText, index) => {
      const startChar = cursor;
      const endChar = startChar + blockText.length;
      cursor = endChar;
      return {
        index,
        text: blockText,
        startChar,
        endChar,
      };
    });
}

export function getPlaybackHighlightRange(
  chunks,
  audioState,
  documentId,
  audioTime = 0,
  audioDuration = 0,
  fallbackProgress = 0,
  highlightWindow = 180,
) {
  if (!chunks?.length) return { startChar: 0, endChar: 0, chunkIndex: 0 };

  const isCurrentAudio = audioState?.docId === documentId && audioState.chunkIndex >= 0;
  const fallback = clampPlaybackPosition(chunks, fallbackProgress);
  const chunkIndex = isCurrentAudio ? audioState.chunkIndex : fallback.chunkIndex;
  const chunk = chunks[chunkIndex] || chunks[0];
  const startOffset = isCurrentAudio ? Math.max(0, Number(audioState.startOffset) || 0) : 0;

  if (!isCurrentAudio || !(audioDuration > 0)) {
    return {
      startChar: chunk.startChar + Math.max(0, fallback.charOffset || startOffset),
      endChar: chunk.endChar,
      chunkIndex: chunk.index,
    };
  }

  const ratio = Math.max(0, Math.min(Number(audioTime) / audioDuration, 1));
  const remainingLength = Math.max(1, chunk.text.length - startOffset);
  const currentChar = Math.round(chunk.startChar + startOffset + (remainingLength * ratio));
  return {
    startChar: Math.max(chunk.startChar, Math.min(currentChar, chunk.endChar)),
    endChar: Math.max(
      Math.min(chunk.endChar, currentChar + highlightWindow),
      Math.min(chunk.endChar, currentChar + 1),
    ),
    chunkIndex: chunk.index,
  };
}

export function formatReaderTime(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(n / 60);
  const rest = n % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
