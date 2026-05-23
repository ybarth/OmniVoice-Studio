import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignLeft, BookOpen, FastForward, FileText, FolderOpen, FolderPlus, ListFilter,
  ListMusic, Loader2, Pause, Play, Plus, RefreshCw, Rewind, Search, Trash2, Upload,
  Volume2,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { extractDocumentText } from '../api/documents';
import { listTtsBackends } from '../api/engines';
import { generateSpeech, generationStatus } from '../api/generate';
import { Badge, Button, Progress } from '../ui';
import {
  ALL_DOCUMENTS_FILTER,
  addDocumentToPlaylist,
  buildDocumentVoiceOptions,
  buildFolderTree,
  clampPlaybackPosition,
  createDocumentRecord,
  createDocumentTextBlocks,
  createFolderRecord,
  createPlaylistRecord,
  DOCUMENT_ACCEPT,
  documentKindForFile,
  filterDocumentsForLibrary,
  flattenFolderTree,
  getDocumentPlaybackPlan,
  formatReaderTime,
  getPlaybackHighlightRange,
  getReadableDocumentDropFile,
  isReadableDocumentFile,
  makeDocumentAudioCacheKey,
  normalizeDocumentText,
  removeDocumentFromPlaylist,
  ROOT_FOLDER_ID,
} from '../utils/documentReader';
import './Projects.css';

const STORAGE_KEY = 'omnivoice.documents.reader.v1';
const FOLDERS_STORAGE_KEY = 'omnivoice.documents.folders.v1';
const PLAYLISTS_STORAGE_KEY = 'omnivoice.documents.playlists.v1';
const SEEK_SECONDS = 15;
const AUDIO_PREFETCH_AHEAD = 2;
const AUDIO_CACHE_BEHIND = 1;
const AUDIO_CACHE_AHEAD = 3;
const DOCUMENT_KIND_FILTERS = [ALL_DOCUMENTS_FILTER, 'PDF', 'Word', 'RTF', 'Text', 'Markdown'];

function makeRequestId() {
  return globalThis.crypto?.randomUUID?.()
    || `doc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readStoredDocuments() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(doc => doc?.id && doc?.text)
      .map(doc => ({
        ...doc,
        text: normalizeDocumentText(doc.text),
        chunks: doc.chunks?.length ? doc.chunks : createDocumentRecord({ name: doc.title }, doc.text).chunks,
        currentChunkIndex: doc.currentChunkIndex || 0,
        currentProgress: doc.currentProgress || 0,
        folderId: doc.folderId || ROOT_FOLDER_ID,
      }));
  } catch {
    return [];
  }
}

function readStoredFolders() {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLDERS_STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(folder => folder?.id && folder.id !== ROOT_FOLDER_ID)
      .map((folder, index) => ({
        id: String(folder.id),
        name: String(folder.name || '').trim() || 'Untitled folder',
        parentId: folder.parentId && folder.parentId !== folder.id ? folder.parentId : ROOT_FOLDER_ID,
        createdAt: Number(folder.createdAt) || index + 1,
      }));
  } catch {
    return [];
  }
}

function readStoredPlaylists() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYLISTS_STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(playlist => playlist?.id)
      .map((playlist, index) => ({
        id: String(playlist.id),
        name: String(playlist.name || '').trim() || 'Untitled playlist',
        documentIds: [...new Set((playlist.documentIds || []).filter(Boolean))],
        createdAt: Number(playlist.createdAt) || index + 1,
      }));
  } catch {
    return [];
  }
}

function persistDocuments(documents) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
  } catch {
    // Documents are local-only convenience state; a full browser quota should
    // not break importing or listening in the current session.
  }
}

function persistFolders(folders) {
  try {
    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
  } catch {
    // Folder metadata is local convenience state and should not block reading.
  }
}

function persistPlaylists(playlists) {
  try {
    localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(playlists));
  } catch {
    // Playlist metadata is local convenience state and should not block reading.
  }
}

function VoiceOptionLabel({ option }) {
  if (!option) return <span><Volume2 size={12} /> Loading voices</span>;
  if (option.type === 'engine') {
    return <span><Volume2 size={12} /> {option.label} <span>{option.detail}</span></span>;
  }
  const kind = option.profile?.kind === 'design' || option.profile?.instruct ? 'design' : 'clone';
  return <span>{option.label} <span>{kind}</span></span>;
}

function paginateBlocks(blocks, maxChars = 2600) {
  const pages = [];
  let page = [];
  let count = 0;

  for (const block of blocks) {
    if (page.length && count + block.text.length > maxChars) {
      pages.push(page);
      page = [];
      count = 0;
    }
    page.push(block);
    count += block.text.length;
  }
  if (page.length) pages.push(page);
  return pages;
}

function HighlightedBlock({ block, highlightRange, as = 'p', className = '' }) {
  const Tag = as;
  const overlapStart = Math.max(block.startChar, highlightRange.startChar);
  const overlapEnd = Math.min(block.endChar, highlightRange.endChar);
  const isReading = overlapStart < overlapEnd;

  if (!isReading) {
    return (
      <Tag className={className} data-reader-block={block.index}>
        {block.text}
      </Tag>
    );
  }

  const localStart = overlapStart - block.startChar;
  const localEnd = overlapEnd - block.startChar;
  return (
    <Tag className={`${className} is-reading`.trim()} data-reader-block={block.index}>
      {block.text.slice(0, localStart)}
      <mark className="documents-reader__highlight">{block.text.slice(localStart, localEnd)}</mark>
      {block.text.slice(localEnd)}
    </Tag>
  );
}

export default function DocumentLibrary({ profiles = [], loadHistory }) {
  const [documents, setDocuments] = useState(readStoredDocuments);
  const [folders, setFolders] = useState(readStoredFolders);
  const [playlists, setPlaylists] = useState(readStoredPlaylists);
  const [selectedId, setSelectedId] = useState(() => readStoredDocuments()[0]?.id || '');
  const [readerQuery, setReaderQuery] = useState('');
  const [activeLibraryType, setActiveLibraryType] = useState('folder');
  const [activeFolderId, setActiveFolderId] = useState(ROOT_FOLDER_ID);
  const [activePlaylistId, setActivePlaylistId] = useState('');
  const [kindFilter, setKindFilter] = useState(ALL_DOCUMENTS_FILTER);
  const [documentViewMode, setDocumentViewMode] = useState('text');
  const [selectedVoiceId, setSelectedVoiceId] = useState('');
  const [engineData, setEngineData] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioState, setAudioState] = useState({ docId: '', chunkIndex: -1, url: '', requestId: '', startOffset: 0 });
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [synthesisStatus, setSynthesisStatus] = useState(null);
  const [prefetchState, setPrefetchState] = useState({ ready: 0, loading: 0 });
  const fileInputRef = useRef(null);
  const audioRef = useRef(null);
  const statusPollRef = useRef(null);
  const viewerRef = useRef(null);
  const audioCacheRef = useRef(new Map());
  const prefetchPromisesRef = useRef(new Map());
  const cacheEpochRef = useRef(0);

  const selectedDocument = documents.find(doc => doc.id === selectedId) || documents[0] || null;
  const activeEngine = engineData?.backends?.find(backend => backend.id === engineData.active);
  const voiceOptions = useMemo(
    () => buildDocumentVoiceOptions(profiles, engineData),
    [engineData, profiles],
  );
  const activeEngineVoiceOption = voiceOptions.find(option => (
    option.type === 'engine'
    && option.engineId === engineData?.active
    && (option.default || option.voiceId === 'default')
  )) || voiceOptions.find(option => option.type === 'engine') || null;
  const selectedVoiceOption = voiceOptions.find(option => option.value === selectedVoiceId)
    || activeEngineVoiceOption
    || voiceOptions[0]
    || null;
  const selectedVoiceCacheKey = selectedVoiceOption?.value || 'voice:none';
  const selectedProfile = selectedVoiceOption?.profile || null;
  const selectedEngine = selectedVoiceOption?.type === 'engine'
    ? engineData?.backends?.find(backend => backend.id === selectedVoiceOption.engineId) || activeEngine
    : null;
  const documentBlocks = useMemo(
    () => createDocumentTextBlocks(selectedDocument?.text || ''),
    [selectedDocument?.text],
  );
  const documentPages = useMemo(() => paginateBlocks(documentBlocks), [documentBlocks]);
  const folderTree = useMemo(() => buildFolderTree(folders, documents), [folders, documents]);
  const flatFolders = useMemo(() => flattenFolderTree(folderTree), [folderTree]);
  const activeFolder = flatFolders.find(folder => folder.id === activeFolderId) || folderTree;
  const activePlaylist = playlists.find(playlist => playlist.id === activePlaylistId) || null;
  const activeLibraryLabel = activeLibraryType === 'playlist'
    ? activePlaylist?.name || 'Playlist'
    : activeFolder?.name || 'Library';

  useEffect(() => {
    if (!selectedId && documents[0]) setSelectedId(documents[0].id);
    if (selectedId && !documents.some(doc => doc.id === selectedId)) {
      setSelectedId(documents[0]?.id || '');
    }
    persistDocuments(documents);
  }, [documents, selectedId]);

  useEffect(() => {
    persistFolders(folders);
  }, [folders]);

  useEffect(() => {
    persistPlaylists(playlists);
  }, [playlists]);

  useEffect(() => {
    if (activeFolderId !== ROOT_FOLDER_ID && !flatFolders.some(folder => folder.id === activeFolderId)) {
      setActiveFolderId(ROOT_FOLDER_ID);
    }
  }, [activeFolderId, flatFolders]);

  useEffect(() => {
    if (activePlaylistId && !playlists.some(playlist => playlist.id === activePlaylistId)) {
      setActivePlaylistId('');
      if (activeLibraryType === 'playlist') setActiveLibraryType('folder');
    }
  }, [activeLibraryType, activePlaylistId, playlists]);

  useEffect(() => {
    let cancelled = false;
    listTtsBackends()
      .then(data => { if (!cancelled) setEngineData(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    clearInterval(statusPollRef.current);
    audioRef.current?.pause?.();
    for (const entry of audioCacheRef.current.values()) {
      if (entry.url?.startsWith('blob:')) URL.revokeObjectURL(entry.url);
    }
    audioCacheRef.current.clear();
    prefetchPromisesRef.current.clear();
  }, []);

  const filteredDocuments = useMemo(() => filterDocumentsForLibrary(documents, {
    folders,
    playlists,
    folderId: activeLibraryType === 'folder' ? activeFolderId : ROOT_FOLDER_ID,
    playlistId: activeLibraryType === 'playlist' ? activePlaylistId : '',
    kind: kindFilter,
    query: readerQuery,
  }), [activeFolderId, activeLibraryType, activePlaylistId, documents, folders, kindFilter, playlists, readerQuery]);

  const displayedProgress = useMemo(() => {
    if (!selectedDocument) return 0;
    if (
      audioState.docId === selectedDocument.id
      && audioState.chunkIndex >= 0
      && audioDuration > 0
    ) {
      const chunk = selectedDocument.chunks[audioState.chunkIndex];
      if (chunk) {
        const ratio = Math.max(0, Math.min(audioTime / audioDuration, 1));
        const startOffset = Math.max(0, Number(audioState.startOffset) || 0);
        const remainingLength = Math.max(1, chunk.text.length - startOffset);
        return Math.round(chunk.startChar + startOffset + (remainingLength * ratio));
      }
    }
    return selectedDocument.currentProgress || 0;
  }, [audioDuration, audioState.chunkIndex, audioState.docId, audioState.startOffset, audioTime, selectedDocument]);

  const highlightRange = useMemo(() => getPlaybackHighlightRange(
    selectedDocument?.chunks || [],
    audioState,
    selectedDocument?.id || '',
    audioTime,
    audioDuration,
    displayedProgress,
  ), [audioDuration, audioState, audioTime, displayedProgress, selectedDocument?.chunks, selectedDocument?.id]);

  const activeBlockIndex = useMemo(() => (
    documentBlocks.find(block => highlightRange.startChar < block.endChar && highlightRange.endChar > block.startChar)?.index
    ?? documentBlocks.find(block => displayedProgress >= block.startChar && displayedProgress <= block.endChar)?.index
    ?? -1
  ), [displayedProgress, documentBlocks, highlightRange.endChar, highlightRange.startChar]);

  useEffect(() => {
    if (!isPlaying || activeBlockIndex < 0) return;
    const target = viewerRef.current?.querySelector(`[data-reader-block="${activeBlockIndex}"]`);
    target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [activeBlockIndex, documentViewMode, isPlaying]);

  const setDocumentPosition = useCallback((docId, chunkIndex, progress) => {
    setDocuments(prev => prev.map(doc => (
      doc.id === docId
        ? { ...doc, currentChunkIndex: chunkIndex, currentProgress: progress }
        : doc
    )));
  }, []);

  const resetAudio = useCallback(() => {
    audioRef.current?.pause?.();
    audioRef.current?.removeAttribute?.('src');
    audioRef.current?.load?.();
    setAudioState({ docId: '', chunkIndex: -1, url: '', requestId: '', startOffset: 0 });
    setAudioTime(0);
    setAudioDuration(0);
    setIsPlaying(false);
  }, []);

  const clearAudioCache = useCallback(() => {
    cacheEpochRef.current += 1;
    for (const entry of audioCacheRef.current.values()) {
      if (entry.url?.startsWith('blob:')) URL.revokeObjectURL(entry.url);
    }
    audioCacheRef.current.clear();
    prefetchPromisesRef.current.clear();
    setPrefetchState({ ready: 0, loading: 0 });
  }, []);

  useEffect(() => {
    resetAudio();
    clearAudioCache();
  }, [clearAudioCache, resetAudio, selectedDocument?.id, selectedVoiceCacheKey]);

  const createFolder = useCallback((parentId = ROOT_FOLDER_ID) => {
    const name = window.prompt('Folder name');
    if (name === null) return;
    const folder = createFolderRecord(name, parentId || ROOT_FOLDER_ID);
    setFolders(prev => [...prev, folder]);
    setActiveLibraryType('folder');
    setActiveFolderId(folder.id);
  }, []);

  const createPlaylist = useCallback(() => {
    const name = window.prompt('Playlist name');
    if (name === null) return;
    const playlist = createPlaylistRecord(
      name,
      selectedDocument ? [selectedDocument.id] : [],
    );
    setPlaylists(prev => [...prev, playlist]);
    setActiveLibraryType('playlist');
    setActivePlaylistId(playlist.id);
  }, [selectedDocument]);

  const moveSelectedToFolder = useCallback((folderId) => {
    if (!selectedDocument) return;
    const nextFolderId = folderId || ROOT_FOLDER_ID;
    setDocuments(prev => prev.map(doc => (
      doc.id === selectedDocument.id ? { ...doc, folderId: nextFolderId } : doc
    )));
    if (activeLibraryType === 'folder') setActiveFolderId(nextFolderId);
  }, [activeLibraryType, selectedDocument]);

  const addSelectedToPlaylist = useCallback((playlistId) => {
    if (!selectedDocument || !playlistId) return;
    setPlaylists(prev => prev.map(playlist => (
      playlist.id === playlistId
        ? addDocumentToPlaylist(playlist, selectedDocument.id)
        : playlist
    )));
  }, [selectedDocument]);

  const removeSelectedFromPlaylist = useCallback((playlistId = activePlaylistId) => {
    if (!selectedDocument || !playlistId) return;
    setPlaylists(prev => prev.map(playlist => (
      playlist.id === playlistId
        ? removeDocumentFromPlaylist(playlist, selectedDocument.id)
        : playlist
    )));
  }, [activePlaylistId, selectedDocument]);

  const importFile = useCallback(async (file) => {
    if (!file) return;
    if (!isReadableDocumentFile(file)) {
      toast.error('Upload PDF, Word, RTF, TXT, or Markdown');
      return;
    }
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append('file', file, file.name || 'document');
      const extracted = await extractDocumentText(formData);
      const record = createDocumentRecord(
        { name: extracted.filename || file.name, type: file.type, size: file.size },
        extracted.text,
      );
      const nextRecord = {
        ...record,
        kind: extracted.kind || documentKindForFile(file),
        folderId: activeLibraryType === 'folder' ? activeFolderId : ROOT_FOLDER_ID,
      };
      setDocuments(prev => [nextRecord, ...prev.filter(doc => doc.id !== nextRecord.id)]);
      if (activeLibraryType === 'playlist' && activePlaylistId) {
        setPlaylists(prev => prev.map(playlist => (
          playlist.id === activePlaylistId
            ? addDocumentToPlaylist(playlist, nextRecord.id)
            : playlist
        )));
      }
      setSelectedId(nextRecord.id);
      resetAudio();
      toast.success(`Imported ${nextRecord.title}`);
    } catch (err) {
      toast.error(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  }, [activeFolderId, activeLibraryType, activePlaylistId, resetAudio]);

  const handleFileInput = useCallback((event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    importFile(file);
  }, [importFile]);

  const handleDrop = useCallback((event) => {
    const file = getReadableDocumentDropFile(event);
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    importFile(file);
  }, [importFile]);

  const pollSynthesis = useCallback((requestId) => {
    clearInterval(statusPollRef.current);
    const poll = async () => {
      try {
        setSynthesisStatus(await generationStatus(requestId));
      } catch {
        // The status row appears after /generate receives the request.
      }
    };
    poll();
    statusPollRef.current = setInterval(poll, 750);
  }, []);

  const syncPrefetchState = useCallback((docId = selectedDocument?.id, voiceKey = selectedVoiceCacheKey) => {
    const ready = [...audioCacheRef.current.values()]
      .filter(entry => entry.docId === docId && entry.voiceKey === voiceKey).length;
    const loading = [...prefetchPromisesRef.current.values()]
      .filter(entry => entry.docId === docId && entry.voiceKey === voiceKey).length;
    setPrefetchState({ ready, loading });
  }, [selectedDocument?.id, selectedVoiceCacheKey]);

  const pruneAudioCache = useCallback((docId, voiceKey, currentIndex) => {
    const minIndex = Math.max(0, currentIndex - AUDIO_CACHE_BEHIND);
    const maxIndex = currentIndex + AUDIO_CACHE_AHEAD;
    for (const [key, entry] of audioCacheRef.current.entries()) {
      const keep = entry.docId === docId
        && entry.voiceKey === voiceKey
        && entry.chunkIndex >= minIndex
        && entry.chunkIndex <= maxIndex;
      if (!keep) {
        if (entry.url?.startsWith('blob:')) URL.revokeObjectURL(entry.url);
        audioCacheRef.current.delete(key);
      }
    }
  }, []);

  const buildSpeechFormData = useCallback((chunkText, requestId) => {
    const formData = new FormData();
    formData.append('text', chunkText);
    formData.append('request_id', requestId);
    formData.append('num_step', '16');
    formData.append('guidance_scale', '2');
    formData.append('speed', '1');
    formData.append('denoise', 'true');
    formData.append('postprocess_output', 'true');
    if (selectedProfile?.language && selectedProfile.language !== 'Auto') {
      formData.append('language', selectedProfile.language);
    }
    if (selectedVoiceOption?.type === 'profile' && selectedVoiceOption.profileId) {
      formData.append('profile_id', selectedVoiceOption.profileId);
    }
    if (selectedVoiceOption?.type === 'engine' && selectedVoiceOption.engineId) {
      formData.append('engine_id', selectedVoiceOption.engineId);
      if (selectedVoiceOption.parameter === 'speaker_id') {
        formData.append('speaker_id', selectedVoiceOption.voiceId);
      } else if (selectedVoiceOption.voiceId && selectedVoiceOption.voiceId !== 'default') {
        formData.append('voice', selectedVoiceOption.voiceId);
      }
    }
    if (selectedProfile?.ref_text) formData.append('ref_text', selectedProfile.ref_text);
    if (selectedProfile?.instruct) formData.append('instruct', selectedProfile.instruct);
    return formData;
  }, [selectedProfile, selectedVoiceOption]);

  const requestChunkAudio = useCallback(async (doc, chunkIndex, { offset = 0, foreground = false } = {}) => {
    const chunk = doc?.chunks?.[chunkIndex];
    if (!doc || !chunk) return null;

    const startOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const chunkText = chunk.text.slice(startOffset).trim();
    if (!chunkText) return null;

    const cacheKey = makeDocumentAudioCacheKey(doc.id, selectedVoiceCacheKey, chunkIndex, startOffset);
    const cached = audioCacheRef.current.get(cacheKey);
    if (cached) return cached;

    const pending = prefetchPromisesRef.current.get(cacheKey);
    if (pending) {
      if (!foreground) return pending.promise;
      setGenerating(true);
      setSynthesisStatus({ status: 'running', phase: 'requesting', detail: 'Preparing document audio', progress_pct: 4 });
      pollSynthesis(pending.requestId);
      try {
        return await pending.promise;
      } finally {
        clearInterval(statusPollRef.current);
        setGenerating(false);
        syncPrefetchState(doc.id, selectedVoiceCacheKey);
      }
    }

    const requestId = makeRequestId();
    const formData = buildSpeechFormData(chunkText, requestId);
    const epoch = cacheEpochRef.current;

    if (foreground) {
      setGenerating(true);
      setSynthesisStatus({ status: 'running', phase: 'requesting', detail: 'Preparing document audio', progress_pct: 4 });
      pollSynthesis(requestId);
    }

    const record = {
      docId: doc.id,
      voiceKey: selectedVoiceCacheKey,
      chunkIndex,
      requestId,
      promise: null,
    };
    const promise = (async () => {
      try {
        const response = await generateSpeech(formData);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        if (epoch !== cacheEpochRef.current) {
          URL.revokeObjectURL(url);
          return null;
        }
        const entry = {
          key: cacheKey,
          docId: doc.id,
          voiceKey: selectedVoiceCacheKey,
          chunkIndex,
          url,
          requestId,
          startOffset,
          startChar: chunk.startChar,
        };
        audioCacheRef.current.set(cacheKey, entry);
        return entry;
      } finally {
        prefetchPromisesRef.current.delete(cacheKey);
        if (foreground) {
          clearInterval(statusPollRef.current);
          setGenerating(false);
        }
        syncPrefetchState(doc.id, selectedVoiceCacheKey);
      }
    })();
    record.promise = promise;
    prefetchPromisesRef.current.set(cacheKey, record);
    syncPrefetchState(doc.id, selectedVoiceCacheKey);
    return promise;
  }, [buildSpeechFormData, pollSynthesis, selectedVoiceCacheKey, syncPrefetchState]);

  const activateAudioEntry = useCallback(async (entry, { autoplay = true } = {}) => {
    if (!entry) return;
    const audio = audioRef.current;
    if (audio) {
      audio.pause?.();
      audio.src = entry.url;
      audio.load?.();
    }
    setAudioState({
      docId: entry.docId,
      chunkIndex: entry.chunkIndex,
      url: entry.url,
      requestId: entry.requestId,
      startOffset: entry.startOffset,
    });
    setAudioTime(0);
    setAudioDuration(0);
    setIsPlaying(false);
    setDocumentPosition(entry.docId, entry.chunkIndex, entry.startChar + entry.startOffset);
    loadHistory?.().catch?.(() => {});
    if (autoplay && audio) {
      await new Promise(resolve => window.setTimeout(resolve, 0));
      audio.play?.().catch(() => toast.error('Audio is ready; press Play to start.'));
    }
  }, [loadHistory, setDocumentPosition]);

  const prefetchAround = useCallback((doc, chunkIndex) => {
    if (!doc?.chunks?.length) return;
    const plan = getDocumentPlaybackPlan(doc.chunks, chunkIndex, { prefetchAhead: AUDIO_PREFETCH_AHEAD });
    pruneAudioCache(doc.id, selectedVoiceCacheKey, plan.currentIndex);
    for (const index of plan.prefetchIndexes) {
      requestChunkAudio(doc, index, { offset: 0, foreground: false })
        .catch(() => syncPrefetchState(doc.id, selectedVoiceCacheKey));
    }
    syncPrefetchState(doc.id, selectedVoiceCacheKey);
  }, [pruneAudioCache, requestChunkAudio, selectedVoiceCacheKey, syncPrefetchState]);

  const synthesizeChunk = useCallback(async (doc, chunkIndex, { offset = 0, autoplay = true } = {}) => {
    try {
      const entry = await requestChunkAudio(doc, chunkIndex, { offset, foreground: true });
      if (!entry) return;
      await activateAudioEntry(entry, { autoplay });
      prefetchAround(doc, chunkIndex);
    } catch (err) {
      setSynthesisStatus({ status: 'error', phase: 'error', detail: err.message, error: err.message, progress_pct: null });
      toast.error(`Read aloud failed: ${err.message}`);
    }
  }, [activateAudioEntry, prefetchAround, requestChunkAudio]);

  const play = useCallback(() => {
    if (!selectedDocument || generating) return;
    const chunkIndex = selectedDocument.currentChunkIndex || 0;
    if (
      audioState.docId === selectedDocument.id
      && audioState.chunkIndex === chunkIndex
      && audioState.url
    ) {
      audioRef.current?.play?.().catch(() => toast.error('Audio is ready; press Play to start.'));
      prefetchAround(selectedDocument, chunkIndex);
      return;
    }
    const chunk = selectedDocument.chunks[chunkIndex];
    const offset = Math.max(0, (selectedDocument.currentProgress || 0) - (chunk?.startChar || 0));
    synthesizeChunk(selectedDocument, chunkIndex, { offset, autoplay: true });
  }, [audioState, generating, prefetchAround, selectedDocument, synthesizeChunk]);

  const pause = useCallback(() => {
    audioRef.current?.pause?.();
    setIsPlaying(false);
  }, []);

  const seekToDocumentProgress = useCallback((progress, { autoplay = false } = {}) => {
    if (!selectedDocument) return;
    const target = clampPlaybackPosition(selectedDocument.chunks, progress);
    setDocumentPosition(selectedDocument.id, target.chunkIndex, target.progress);
    const chunk = selectedDocument.chunks[target.chunkIndex];
    const startOffset = Math.max(0, Number(audioState.startOffset) || 0);
    if (
      audioState.docId === selectedDocument.id
      && audioState.chunkIndex === target.chunkIndex
      && audioRef.current
      && audioDuration > 0
      && target.charOffset >= startOffset
    ) {
      audioRef.current.currentTime = Math.max(0, Math.min(
        ((target.charOffset - startOffset) / Math.max(chunk.text.length - startOffset, 1)) * audioDuration,
        audioDuration,
      ));
      if (autoplay) audioRef.current.play?.().catch(() => toast.error('Audio is ready; press Play to start.'));
      prefetchAround(selectedDocument, target.chunkIndex);
    } else {
      resetAudio();
      if (autoplay) synthesizeChunk(selectedDocument, target.chunkIndex, { offset: target.charOffset, autoplay: true });
    }
  }, [audioDuration, audioState, prefetchAround, resetAudio, selectedDocument, setDocumentPosition, synthesizeChunk]);

  const seekRelative = useCallback((deltaSeconds) => {
    if (!selectedDocument) return;
    if (audioRef.current && audioDuration > 0) {
      const nextTime = audioRef.current.currentTime + deltaSeconds;
      if (nextTime >= 0 && nextTime <= audioDuration) {
        audioRef.current.currentTime = nextTime;
        return;
      }
    }
    const direction = deltaSeconds > 0 ? 1 : -1;
    const currentChunkIndex = Math.max(0, audioState.chunkIndex >= 0 ? audioState.chunkIndex : (selectedDocument.currentChunkIndex || 0));
    const nextChunkIndex = Math.max(0, Math.min(selectedDocument.chunks.length - 1, currentChunkIndex + direction));
    const nextChunk = selectedDocument.chunks[nextChunkIndex];
    seekToDocumentProgress(direction > 0 ? nextChunk.startChar : nextChunk.endChar - 1, { autoplay: isPlaying });
  }, [audioDuration, audioState.chunkIndex, isPlaying, seekToDocumentProgress, selectedDocument]);

  const handleAudioEnded = useCallback(() => {
    if (!selectedDocument) return;
    const nextIndex = (audioState.chunkIndex >= 0 ? audioState.chunkIndex : selectedDocument.currentChunkIndex || 0) + 1;
    if (nextIndex < selectedDocument.chunks.length) {
      const nextChunk = selectedDocument.chunks[nextIndex];
      setDocumentPosition(selectedDocument.id, nextIndex, nextChunk.startChar);
      const cacheKey = makeDocumentAudioCacheKey(selectedDocument.id, selectedVoiceCacheKey, nextIndex, 0);
      const cached = audioCacheRef.current.get(cacheKey);
      if (cached) {
        activateAudioEntry(cached, { autoplay: true });
        prefetchAround(selectedDocument, nextIndex);
      } else {
        synthesizeChunk(selectedDocument, nextIndex, { autoplay: true });
      }
    } else {
      setDocumentPosition(selectedDocument.id, selectedDocument.chunks.length - 1, selectedDocument.charCount);
      setIsPlaying(false);
    }
  }, [activateAudioEntry, audioState.chunkIndex, prefetchAround, selectedDocument, selectedVoiceCacheKey, setDocumentPosition, synthesizeChunk]);

  const removeDocument = useCallback((docId) => {
    setDocuments(prev => prev.filter(doc => doc.id !== docId));
    setPlaylists(prev => prev.map(playlist => removeDocumentFromPlaylist(playlist, docId)));
    if (docId === selectedDocument?.id) resetAudio();
  }, [resetAudio, selectedDocument?.id]);

  const currentChunk = selectedDocument?.chunks?.[selectedDocument.currentChunkIndex || 0] || null;
  const progressPct = selectedDocument?.charCount
    ? Math.round((displayedProgress / selectedDocument.charCount) * 100)
    : 0;
  const synthesisProgress = synthesisStatus?.progress_pct ?? (generating ? null : 0);

  return (
    <div
      className={`projects documents-reader ${isDragging ? 'is-dragging' : ''}`}
      onDragEnter={(event) => {
        if (getReadableDocumentDropFile(event)) setIsDragging(true);
      }}
      onDragOver={(event) => {
        if (getReadableDocumentDropFile(event)) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsDragging(false);
      }}
      onDrop={handleDrop}
    >
      <div className="projects__header">
        <h1 className="projects__title">Document Library</h1>
        <div className="projects__toolbar">
          <div className="projects__search">
            <Search size={12} />
            <input
              value={readerQuery}
              onChange={event => setReaderQuery(event.target.value)}
              placeholder="Search documents…"
              spellCheck={false}
            />
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={DOCUMENT_ACCEPT}
            className="native-file-input"
            onChange={handleFileInput}
          />
        </div>
      </div>

      <div className="documents-reader__body">
        <aside className="documents-reader__catalog">
          <div
            className={`documents-reader__dropzone ${importing ? 'is-busy' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            aria-busy={importing}
          >
            {importing ? <Loader2 size={18} className="documents-reader__spin" /> : <Upload size={18} />}
            <strong>{importing ? 'Reading document' : 'Drop documents'}</strong>
            <span>PDF · Word · RTF · TXT · Markdown</span>
            <button
              type="button"
              className="documents-reader__import-button"
              disabled={importing}
              aria-label="Import document"
              onClick={(event) => {
                event.stopPropagation();
                fileInputRef.current?.click();
              }}
            >
              <Upload size={13} />
              Import
            </button>
          </div>

          <div className="documents-reader__library-actions">
            <Button
              variant="ghost"
              size="sm"
              leading={<FolderPlus size={12} />}
              onClick={() => createFolder(ROOT_FOLDER_ID)}
            >
              New Folder
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leading={<Plus size={12} />}
              disabled={activeLibraryType !== 'folder'}
              onClick={() => createFolder(activeFolderId)}
            >
              Subfolder
            </Button>
          </div>

          <section className="documents-reader__library-section">
            <div className="documents-reader__section-title">
              <FolderOpen size={13} />
              <span>Folders</span>
            </div>
            <div className="documents-reader__tree">
              {flatFolders.map(folder => (
                <button
                  key={folder.id}
                  type="button"
                  className={`documents-reader__tree-item ${
                    activeLibraryType === 'folder' && activeFolderId === folder.id ? 'is-active' : ''
                  }`}
                  style={{ paddingLeft: 8 + (folder.depth * 12) }}
                  onClick={() => {
                    setActiveLibraryType('folder');
                    setActiveFolderId(folder.id);
                    setActivePlaylistId('');
                  }}
                >
                  <FolderOpen size={12} />
                  <span>{folder.name}</span>
                  <small>{folder.totalDocumentCount}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="documents-reader__library-section documents-reader__filters">
            <div className="documents-reader__section-title">
              <ListFilter size={13} />
              <span>Filter</span>
            </div>
            <div className="documents-reader__filter-grid">
              {DOCUMENT_KIND_FILTERS.map(kind => (
                <button
                  key={kind}
                  type="button"
                  className={`documents-reader__filter-chip ${kindFilter === kind ? 'is-active' : ''}`}
                  onClick={() => setKindFilter(kind)}
                >
                  {kind === ALL_DOCUMENTS_FILTER ? 'All' : kind}
                </button>
              ))}
            </div>
          </section>

          <section className="documents-reader__library-section">
            <div className="documents-reader__section-title documents-reader__section-title--split">
              <span><ListMusic size={13} /> Playlists</span>
              <Button variant="icon" iconSize="sm" title="New Playlist" onClick={createPlaylist}>
                <Plus size={12} />
              </Button>
            </div>
            <div className="documents-reader__playlists">
              {playlists.map(playlist => (
                <button
                  key={playlist.id}
                  type="button"
                  className={`documents-reader__playlist ${
                    activeLibraryType === 'playlist' && activePlaylistId === playlist.id ? 'is-active' : ''
                  }`}
                  onClick={() => {
                    setActiveLibraryType('playlist');
                    setActivePlaylistId(playlist.id);
                  }}
                >
                  <ListMusic size={12} />
                  <span>{playlist.name}</span>
                  <small>{playlist.documentIds.length}</small>
                </button>
              ))}
              {!playlists.length && (
                <button type="button" className="documents-reader__playlist is-empty" onClick={createPlaylist}>
                  <ListMusic size={12} />
                  <span>New Playlist</span>
                  <small>0</small>
                </button>
              )}
            </div>
          </section>

          <section className="documents-reader__library-section">
            <div className="documents-reader__section-title documents-reader__section-title--split">
              <span><FileText size={13} /> Documents</span>
              <small>{activeLibraryLabel}</small>
            </div>
            <div className="documents-reader__context">
              <span>{filteredDocuments.length} file{filteredDocuments.length === 1 ? '' : 's'}</span>
              {kindFilter !== ALL_DOCUMENTS_FILTER && <span>{kindFilter}</span>}
            </div>
          </section>

          <div className="documents-reader__list">
            {filteredDocuments.map(doc => (
              <button
                key={doc.id}
                type="button"
                className={`documents-reader__doc ${selectedDocument?.id === doc.id ? 'is-active' : ''}`}
                onClick={() => {
                  setSelectedId(doc.id);
                  resetAudio();
                }}
              >
                <FileText size={14} />
                <span>
                  <strong>{doc.title}</strong>
                  <small>{doc.kind} · {doc.chunks.length} part{doc.chunks.length === 1 ? '' : 's'}</small>
                </span>
              </button>
            ))}
            {!filteredDocuments.length && (
              <div className="documents-reader__empty-list">
                <FolderOpen size={22} />
                <span>{readerQuery || kindFilter !== ALL_DOCUMENTS_FILTER ? 'No matching documents' : 'No documents here'}</span>
              </div>
            )}
          </div>
        </aside>

        <main className="documents-reader__main">
          {!selectedDocument ? (
            <section className="documents-reader__empty-main">
              <FileText size={34} />
              <h2>Documents</h2>
              <p>PDF · Word · RTF · TXT · Markdown</p>
            </section>
          ) : (
            <>
              <section className="documents-reader__hero">
                <div>
                  <div className="documents-reader__eyebrow">
                    <Badge tone="info" size="xs">{selectedDocument.kind}</Badge>
                    <span>{selectedDocument.charCount.toLocaleString()} chars</span>
                    <span>{selectedDocument.chunks.length} part{selectedDocument.chunks.length === 1 ? '' : 's'}</span>
                  </div>
                  <h2>{selectedDocument.title}</h2>
                </div>
                <Button variant="icon" iconSize="sm" title="Remove document" onClick={() => removeDocument(selectedDocument.id)}>
                  <Trash2 size={13} />
                </Button>
              </section>

              <section className="documents-reader__document-actions">
                <label>
                  <span className="label-row label-row--sm">Folder</span>
                  <select
                    className="input-base input-base--xs"
                    value={selectedDocument.folderId || ROOT_FOLDER_ID}
                    onChange={event => moveSelectedToFolder(event.target.value)}
                  >
                    {flatFolders.map(folder => (
                      <option key={folder.id} value={folder.id}>
                        {folder.depth ? `${'--'.repeat(folder.depth)} ${folder.name}` : folder.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="label-row label-row--sm">Add to playlist</span>
                  <select
                    className="input-base input-base--xs"
                    value=""
                    disabled={!playlists.length}
                    onChange={event => addSelectedToPlaylist(event.target.value)}
                  >
                    <option value="">{playlists.length ? 'Choose playlist' : 'No playlists'}</option>
                    {playlists.map(playlist => (
                      <option key={playlist.id} value={playlist.id}>
                        {playlist.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  leading={<ListMusic size={12} />}
                  onClick={createPlaylist}
                >
                  New Playlist
                </Button>
                {activeLibraryType === 'playlist' && activePlaylist?.documentIds?.includes(selectedDocument.id) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeSelectedFromPlaylist(activePlaylist.id)}
                  >
                    Remove from playlist
                  </Button>
                )}
              </section>

              <section className="documents-reader__voicebar">
                <label>
                  <span className="label-row label-row--sm">Voice catalog</span>
                  <select
                    className="input-base input-base--xs"
                    value={selectedVoiceOption?.value || ''}
                    onChange={event => {
                      setSelectedVoiceId(event.target.value);
                      resetAudio();
                    }}
                  >
                    {!voiceOptions.length && <option value="">No voices detected</option>}
                    {voiceOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label} — {option.detail}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="documents-reader__voice-card">
                  <VoiceOptionLabel option={selectedVoiceOption} />
                  {selectedVoiceOption?.type === 'engine' && selectedEngine && (
                    <small>
                      {selectedEngine.display_name || selectedEngine.id}
                      {selectedEngine.available === false ? ' unavailable' : ''}
                    </small>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  leading={<RefreshCw size={12} />}
                  onClick={() => listTtsBackends().then(setEngineData).catch(err => toast.error(err.message))}
                >
                  Refresh
                </Button>
              </section>

              <section className="documents-reader__player">
                <audio
                  ref={audioRef}
                  src={audioState.url}
                  preload="metadata"
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={handleAudioEnded}
                  onLoadedMetadata={event => setAudioDuration(event.currentTarget.duration || 0)}
                  onTimeUpdate={event => setAudioTime(event.currentTarget.currentTime || 0)}
                />
                <div className="documents-reader__controls">
                  <Button
                    variant="icon"
                    iconSize="md"
                    title={`Rewind ${SEEK_SECONDS}s`}
                    disabled={generating}
                    onClick={() => seekRelative(-SEEK_SECONDS)}
                  >
                    <Rewind size={16} />
                  </Button>
                  <Button
                    variant="primary"
                    size="md"
                    leading={generating
                      ? <Loader2 size={15} className="documents-reader__spin" />
                      : isPlaying ? <Pause size={15} /> : <Play size={15} />}
                    disabled={generating}
                    onClick={isPlaying ? pause : play}
                  >
                    {generating ? 'Loading' : isPlaying ? 'Pause' : 'Play'}
                  </Button>
                  <Button
                    variant="icon"
                    iconSize="md"
                    title={`Fast forward ${SEEK_SECONDS}s`}
                    disabled={generating}
                    onClick={() => seekRelative(SEEK_SECONDS)}
                  >
                    <FastForward size={16} />
                  </Button>
                  <span className="documents-reader__time">
                    {formatReaderTime(audioTime)} / {formatReaderTime(audioDuration)}
                  </span>
                </div>
                <div className="documents-reader__scrubber-row">
                  <input
                    type="range"
                    min="0"
                    max={selectedDocument.charCount}
                    value={displayedProgress}
                    onChange={event => seekToDocumentProgress(Number(event.target.value), { autoplay: isPlaying })}
                    className="documents-reader__scrubber"
                    aria-label="Document playback position"
                  />
                  <span>{progressPct}%</span>
                </div>
                {generating && (
                  <div className="documents-reader__synthesis" role="status" aria-live="polite">
                    <Progress value={synthesisProgress} tone="brand" size="sm" />
                    <span>{synthesisStatus?.detail || 'Generating document audio'}</span>
                  </div>
                )}
              </section>

              <section className={`documents-reader__viewer documents-reader__viewer--${documentViewMode}`}>
                <div className="documents-reader__viewer-head">
                  <div className="documents-reader__viewer-status">
                    <span>Part {(selectedDocument.currentChunkIndex || 0) + 1} of {selectedDocument.chunks.length}</span>
                    <span>{displayedProgress.toLocaleString()} / {selectedDocument.charCount.toLocaleString()}</span>
                    {currentChunk && <span>{currentChunk.text.length.toLocaleString()} chars queued</span>}
                    {prefetchState.loading > 0 && <span>Loading next segment</span>}
                    {prefetchState.loading === 0 && prefetchState.ready > 0 && (
                      <span>{prefetchState.ready} segment{prefetchState.ready === 1 ? '' : 's'} ready</span>
                    )}
                  </div>
                  <div className="documents-reader__view-tabs" role="tablist" aria-label="Document view">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={documentViewMode === 'text'}
                      className={documentViewMode === 'text' ? 'is-active' : ''}
                      onMouseDown={() => setDocumentViewMode('text')}
                      onClick={() => setDocumentViewMode('text')}
                    >
                      <AlignLeft size={12} />
                      Plain text
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={documentViewMode === 'original'}
                      className={documentViewMode === 'original' ? 'is-active' : ''}
                      onMouseDown={() => setDocumentViewMode('original')}
                      onClick={() => setDocumentViewMode('original')}
                    >
                      <BookOpen size={12} />
                      Original
                    </button>
                  </div>
                </div>
                <div className="documents-reader__viewer-scroll" ref={viewerRef}>
                  {documentViewMode === 'text' ? (
                    <article className="documents-reader__plain" aria-label="Plain text view">
                      {documentBlocks.map(block => (
                        <HighlightedBlock
                          key={block.index}
                          block={block}
                          highlightRange={highlightRange}
                          className="documents-reader__plain-block"
                        />
                      ))}
                    </article>
                  ) : (
                    <article className="documents-reader__pages" aria-label="Original view">
                      {documentPages.map((pageBlocks, pageIndex) => (
                        <section className="documents-reader__page" key={`page-${pageIndex}`}>
                          <div className="documents-reader__page-meta">
                            <span>{selectedDocument.kind}</span>
                            <span>Page {pageIndex + 1}</span>
                          </div>
                          {pageBlocks.map(block => (
                            <HighlightedBlock
                              key={block.index}
                              as={pageIndex === 0 && block.index === 0 && block.text.length <= 120 ? 'h3' : 'p'}
                              block={block}
                              highlightRange={highlightRange}
                              className="documents-reader__page-block"
                            />
                          ))}
                        </section>
                      ))}
                    </article>
                  )}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
