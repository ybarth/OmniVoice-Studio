import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, Download, FileText, Languages, MessageSquareText, Mic, Plus, Play, Sparkles,
  Square, Trash2, Upload, UserRound, Volume2, Wand2,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import SearchableSelect from '../components/SearchableSelect';
import ALL_LANGUAGES from '../languages.json';
import { POPULAR_LANGS } from '../utils/constants';
import { translatePromptForSynthesis } from '../api/translate';
import { generateSpeech, generationStatus, audioUrlWithCacheBust } from '../api/generate';
import { listTranslationEngines } from '../api/engines';
import { exportConversationBundle } from '../api/conversation';
import { transcribeAudio } from '../api/capture';
import { API } from '../api/client';
import { playBlobAudio } from '../utils/media';
import { profilePhotoPath } from '../utils/profileAudio';
import { useAppStore } from '../store';
import {
  addConversationSpeaker,
  buildConversationExportSelection,
  createConversationTurn,
  createDefaultSpeakers,
  speakerDefaultsForTurn,
  updateSpeakerMemory,
} from '../utils/conversationSession';
import {
  buildDictationFormData,
  normalizeAudioLevels,
  readDictationSettings,
} from '../utils/dictationSettings';
import { translationEngineOptionLabel, translationEngineUnavailableHint } from '../utils/translationEngineStatus';
import { selectSynthesisProgressView } from '../utils/synthesisProgress';
import { Badge, Button, Progress } from '../ui';
import './ConversationTab.css';

const FALLBACK_TRANSLATION_ENGINES = [
  { id: 'hymt-1.8b', display_name: 'HY-MT1.5 1.8B (Local Cantonese)', installed: true },
  { id: 'hymt-7b', display_name: 'HY-MT1.5 7B (Local, Higher Quality)', installed: true },
  { id: 'openai', display_name: 'OpenAI (API)', installed: true },
  { id: 'openai-compatible', display_name: 'OpenAI-compatible LLM', installed: true },
  { id: 'google', display_name: 'Google Translate (Online)', installed: true },
];

function makeRequestId() {
  return globalThis.crypto?.randomUUID?.()
    || `conv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function responseFilename(response, fallback) {
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match?.[1] || fallback;
}

async function downloadResponseBlob(response, fallbackName) {
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = responseFilename(response, fallbackName);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const EMPTY_AUDIO_LEVELS = Array.from({ length: 16 }, () => 0);

function profilePhotoUrl(profile) {
  if (!profile?.photo_path) return '';
  const token = profile.photo_path || profile.updated_at || profile.created_at || profile.id;
  return `${API}${profilePhotoPath(profile.id, token)}`;
}

function ProfileAvatar({ profile }) {
  const url = profilePhotoUrl(profile);
  return (
    <span className="conversation-profile-avatar" aria-hidden="true">
      {url ? <img src={url} alt="" /> : <UserRound size={13} />}
    </span>
  );
}

function ProfilePicker({ profiles, value, onChange }) {
  const selectedProfile = profiles.find(profile => profile.id === value);
  const closeAfterSelect = (event, nextValue) => {
    onChange(nextValue);
    const details = event.currentTarget.closest('details');
    if (details) details.open = false;
  };

  return (
    <details className="conversation-profile-picker">
      <summary className="input-base input-base--xs conversation-profile-picker__summary">
        <ProfileAvatar profile={selectedProfile} />
        <span>{selectedProfile?.name || 'Default'}</span>
      </summary>
      <div className="conversation-profile-picker__menu">
        <button
          type="button"
          className={`conversation-profile-picker__option ${!value ? 'active' : ''}`}
          onClick={event => closeAfterSelect(event, '')}
        >
          <ProfileAvatar profile={null} />
          <span>Default</span>
        </button>
        {profiles.map(profile => (
          <button
            key={profile.id}
            type="button"
            className={`conversation-profile-picker__option ${value === profile.id ? 'active' : ''}`}
            onClick={event => closeAfterSelect(event, profile.id)}
          >
            <ProfileAvatar profile={profile} />
            <span>{profile.name}</span>
          </button>
        ))}
      </div>
    </details>
  );
}

function formatRecordingTime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest}s`;
}

export default function ConversationTab({ profiles = [], loadHistory }) {
  const cloneTranslateProvider = useAppStore(s => s.cloneTranslateProvider);
  const activeConversationId = useAppStore(s => s.activeConversationId);
  const conversationArchive = useAppStore(s => s.conversationArchive);
  const conversationSpeakers = useAppStore(s => s.conversationSpeakers);
  const conversationTurns = useAppStore(s => s.conversationTurns);
  const startNewConversation = useAppStore(s => s.startNewConversation);
  const openConversation = useAppStore(s => s.openConversation);
  const renameConversation = useAppStore(s => s.renameConversation);
  const deleteConversation = useAppStore(s => s.deleteConversation);
  const setConversationSpeakers = useAppStore(s => s.setConversationSpeakers);
  const addConversationTurn = useAppStore(s => s.addConversationTurn);
  const [activeSpeakerId, setActiveSpeakerId] = useState(conversationSpeakers[0]?.id || 'speaker-a');
  const [draftText, setDraftText] = useState('');
  const turns = conversationTurns;
  const [isWorking, setIsWorking] = useState(false);
  const [turnAudio, setTurnAudio] = useState(null);
  const [isTurnRecording, setIsTurnRecording] = useState(false);
  const [isTurnTranscribing, setIsTurnTranscribing] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [audioLevels, setAudioLevels] = useState(EMPTY_AUDIO_LEVELS);
  const [selectedTurnIds, setSelectedTurnIds] = useState([]);
  const [exportScope, setExportScope] = useState('all');
  const [exportRangeStart, setExportRangeStart] = useState(1);
  const [exportRangeEnd, setExportRangeEnd] = useState(1);
  const [exportSpeakerIds, setExportSpeakerIds] = useState([]);
  const [audioFormat, setAudioFormat] = useState('wav');
  const [audioLayout, setAudioLayout] = useState('folder');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [textFormats, setTextFormats] = useState({ txt: true, json: true, csv: false, pdf: true });
  const [isExporting, setIsExporting] = useState(false);
  const [workState, setWorkState] = useState({
    clientPhase: 'idle',
    backendStatus: null,
    elapsedSeconds: 0,
    detail: '',
  });
  const timerRef = useRef(null);
  const statusPollRef = useRef(null);
  const startedAtRef = useRef(0);
  const turnsRef = useRef([]);
  const turnAudioRef = useRef(null);
  const fileInputRef = useRef(null);
  const turnRecorderRef = useRef(null);
  const turnRecordingChunksRef = useRef([]);
  const turnRecordingStreamRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const audioFrameRef = useRef(null);
  const audioContextRef = useRef(null);

  const { data: translationEngineData } = useQuery({
    queryKey: ['translation-engines'],
    queryFn: listTranslationEngines,
    staleTime: 30_000,
    refetchInterval: isWorking ? 750 : false,
  });
  const translationEngines = translationEngineData?.engines || FALLBACK_TRANSLATION_ENGINES;
  const activeConversation = useMemo(
    () => conversationArchive.find(conversation => conversation.id === activeConversationId) || conversationArchive[0],
    [activeConversationId, conversationArchive],
  );

  useEffect(() => {
    if (conversationSpeakers?.length >= 2) return;
    setConversationSpeakers(createDefaultSpeakers(profiles, cloneTranslateProvider));
  }, [cloneTranslateProvider, conversationSpeakers?.length, profiles, setConversationSpeakers]);

  useEffect(() => {
    if (conversationSpeakers.some(speaker => speaker.id === activeSpeakerId)) return;
    setActiveSpeakerId(conversationSpeakers[0]?.id || 'speaker-a');
  }, [activeSpeakerId, conversationSpeakers]);

  useEffect(() => {
    const nextSpeakers = conversationSpeakers.map((speaker, index) => {
      const legacyName = `Speaker ${String.fromCharCode(65 + index)}`;
      return speaker.name === legacyName ? { ...speaker, name: `Speaker ${index + 1}` } : speaker;
    });
    if (nextSpeakers.some((speaker, index) => speaker.name !== conversationSpeakers[index]?.name)) {
      setConversationSpeakers(nextSpeakers);
    }
  }, [conversationSpeakers, setConversationSpeakers]);

  useEffect(() => {
    setExportRangeEnd(Math.max(turns.length, 1));
  }, [turns.length]);

  useEffect(() => {
    const turnIds = new Set(turns.map(turn => turn.id));
    setSelectedTurnIds(prev => prev.filter(turnId => turnIds.has(turnId)));
  }, [turns]);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    turnAudioRef.current = turnAudio;
  }, [turnAudio]);

  useEffect(() => () => {
    clearInterval(timerRef.current);
    clearInterval(statusPollRef.current);
    clearInterval(recordingTimerRef.current);
    if (audioFrameRef.current) cancelAnimationFrame(audioFrameRef.current);
    audioContextRef.current?.close?.().catch?.(() => {});
    turnRecordingStreamRef.current?.getTracks?.().forEach(track => track.stop());
    if (turnAudioRef.current?.url?.startsWith('blob:')) URL.revokeObjectURL(turnAudioRef.current.url);
    turnsRef.current.forEach(turn => {
      if (turn.audioUrl?.startsWith('blob:')) URL.revokeObjectURL(turn.audioUrl);
      if (turn.sourceAudioUrl?.startsWith('blob:')) URL.revokeObjectURL(turn.sourceAudioUrl);
    });
  }, []);

  const activeSpeaker = useMemo(
    () => speakerDefaultsForTurn(conversationSpeakers, activeSpeakerId),
    [activeSpeakerId, conversationSpeakers],
  );
  const activeEngine = translationEngines.find(engine => engine.id === activeSpeaker.translationProvider);
  const activeEngineUnavailable = Boolean(activeEngine && activeEngine.installed === false);
  const selectedExportTurns = useMemo(() => buildConversationExportSelection(turns, {
    scope: exportScope,
    selectedTurnIds,
    rangeStart: exportRangeStart,
    rangeEnd: exportRangeEnd,
    speakerIds: exportSpeakerIds,
  }), [exportRangeEnd, exportRangeStart, exportScope, exportSpeakerIds, selectedTurnIds, turns]);
  const progressView = selectSynthesisProgressView({
    clientPhase: workState.clientPhase,
    backendStatus: workState.backendStatus,
    translationEngine: activeEngine,
    elapsedSeconds: workState.elapsedSeconds,
  });

  const updateSpeaker = useCallback((speakerId, patch) => {
    setConversationSpeakers(updateSpeakerMemory(conversationSpeakers, speakerId, patch));
  }, [conversationSpeakers, setConversationSpeakers]);

  const stopLiveRecordingFeedback = useCallback(() => {
    clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
    if (audioFrameRef.current) cancelAnimationFrame(audioFrameRef.current);
    audioFrameRef.current = null;
    audioContextRef.current?.close?.().catch?.(() => {});
    audioContextRef.current = null;
    turnRecordingStreamRef.current?.getTracks?.().forEach(track => track.stop());
    turnRecordingStreamRef.current = null;
    setAudioLevels(EMPTY_AUDIO_LEVELS);
  }, []);

  const setCapturedTurnAudio = useCallback((blob, name) => {
    setTurnAudio(prev => {
      if (prev?.url?.startsWith('blob:')) URL.revokeObjectURL(prev.url);
      return {
        blob,
        name,
        size: blob.size,
        type: blob.type || 'audio/webm',
        url: URL.createObjectURL(blob),
        transcript: '',
        engine: '',
      };
    });
  }, []);

  const startTurnRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });
      turnRecordingStreamRef.current = stream;
      turnRecordingChunksRef.current = [];
      setRecordingMs(0);
      setAudioLevels(EMPTY_AUDIO_LEVELS);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      turnRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) turnRecordingChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopLiveRecordingFeedback();
        setIsTurnRecording(false);
        const blob = new Blob(turnRecordingChunksRef.current, { type: mimeType });
        turnRecordingChunksRef.current = [];
        if (blob.size < 1000) {
          toast.error('Recording too short');
          return;
        }
        setCapturedTurnAudio(blob, `conversation-turn-${Date.now()}.webm`);
      };

      const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
      if (AudioContextImpl) {
        const audioContext = new AudioContextImpl();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 64;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const draw = () => {
          analyser.getByteFrequencyData(data);
          setAudioLevels(normalizeAudioLevels(data, 16));
          audioFrameRef.current = requestAnimationFrame(draw);
        };
        audioContextRef.current = audioContext;
        draw();
      }

      const startedAt = Date.now();
      recordingTimerRef.current = setInterval(() => {
        setRecordingMs(Date.now() - startedAt);
      }, 100);
      recorder.start(250);
      setIsTurnRecording(true);
    } catch (err) {
      stopLiveRecordingFeedback();
      setIsTurnRecording(false);
      toast.error(`Microphone unavailable: ${err.message}`);
    }
  }, [setCapturedTurnAudio, stopLiveRecordingFeedback]);

  const stopTurnRecording = useCallback(() => {
    const recorder = turnRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      stopLiveRecordingFeedback();
      setIsTurnRecording(false);
    }
  }, [stopLiveRecordingFeedback]);

  const handleTurnAudioUpload = useCallback((event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setCapturedTurnAudio(file, file.name || `uploaded-turn-${Date.now()}`);
    event.target.value = '';
  }, [setCapturedTurnAudio]);

  const clearCapturedTurnAudio = useCallback(() => {
    setTurnAudio(prev => {
      if (prev?.url?.startsWith('blob:')) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);

  const transcribeTurnAudio = useCallback(async () => {
    if (!turnAudio?.blob) {
      toast.error('Record or upload turn audio first');
      return;
    }
    setIsTurnTranscribing(true);
    try {
      const settings = readDictationSettings();
      const formData = buildDictationFormData(turnAudio.blob, {
        filename: turnAudio.name || 'conversation-turn.webm',
        language: activeSpeaker.sourceLanguage,
        mode: settings.mode,
        backend: settings.backend,
      });
      const result = await transcribeAudio(formData);
      const text = (result.text || '').trim();
      if (!text) throw new Error('No speech detected');
      setDraftText(prev => (prev.trim() ? `${prev.trim()}\n${text}` : text));
      setTurnAudio(prev => prev ? {
        ...prev,
        transcript: text,
        engine: result.engine || '',
      } : prev);
      toast.success(`Dictated with ${result.engine || 'ASR'}`);
    } catch (err) {
      toast.error(`Dictation failed: ${err.message}`);
    } finally {
      setIsTurnTranscribing(false);
    }
  }, [activeSpeaker.sourceLanguage, turnAudio]);

  const handleAddSpeaker = useCallback(() => {
    const nextSpeakers = addConversationSpeaker(conversationSpeakers, profiles, cloneTranslateProvider);
    const added = nextSpeakers[nextSpeakers.length - 1];
    setConversationSpeakers(nextSpeakers);
    setActiveSpeakerId(added.id);
  }, [cloneTranslateProvider, conversationSpeakers, profiles, setConversationSpeakers]);

  const handleNewConversation = useCallback(() => {
    startNewConversation('', createDefaultSpeakers(profiles, cloneTranslateProvider));
    setDraftText('');
    setSelectedTurnIds([]);
    setExportScope('all');
  }, [cloneTranslateProvider, profiles, startNewConversation]);

  const handleOpenConversation = useCallback((conversationId) => {
    openConversation(conversationId);
    setSelectedTurnIds([]);
    setDraftText('');
    setExportScope('all');
  }, [openConversation]);

  const handleDeleteConversation = useCallback(() => {
    if (!activeConversationId) return;
    const shouldDelete = turns.length === 0
      || globalThis.confirm?.('Delete this conversation from the archive?') === true;
    if (!shouldDelete) return;
    deleteConversation(activeConversationId);
    setSelectedTurnIds([]);
    setDraftText('');
  }, [activeConversationId, deleteConversation, turns.length]);

  const toggleSelectedTurn = useCallback((turnId) => {
    setSelectedTurnIds(prev => (
      prev.includes(turnId)
        ? prev.filter(id => id !== turnId)
        : [...prev, turnId]
    ));
  }, []);

  const toggleExportSpeaker = useCallback((speakerId) => {
    setExportSpeakerIds(prev => (
      prev.includes(speakerId)
        ? prev.filter(id => id !== speakerId)
        : [...prev, speakerId]
    ));
  }, []);

  const toggleTextFormat = useCallback((format) => {
    setTextFormats(prev => ({ ...prev, [format]: !prev[format] }));
  }, []);

  const exportTurns = useCallback(async (turnsToExport = selectedExportTurns) => {
    if (!turnsToExport.length) {
      toast.error('No turns match the export rules');
      return;
    }
    const enabledTextFormats = Object.entries(textFormats)
      .filter(([, enabled]) => enabled)
      .map(([format]) => format);
    if (!enabledTextFormats.length && !includeAudio) {
      toast.error('Choose at least one text or audio export format');
      return;
    }

    setIsExporting(true);
    try {
      const conversationTitle = activeConversation?.title || 'Conversation';
      const indexedTurns = turnsToExport.map(turn => ({
        id: turn.id,
        index: Math.max(turns.findIndex(item => item.id === turn.id) + 1, 1),
        speakerName: turn.speakerName,
        sourceText: turn.sourceText,
        translatedText: turn.translatedText,
        sourceLanguage: turn.sourceLanguage,
        targetLanguage: turn.targetLanguage,
        audioPath: turn.audioPath || '',
        audioId: turn.audioId || '',
      }));
      const response = await exportConversationBundle({
        conversation: {
          id: activeConversation?.id || activeConversationId,
          title: conversationTitle,
        },
        turns: indexedTurns,
        textFormats: enabledTextFormats,
        audioFormat,
        audioLayout,
        includeAudio,
      });
      await downloadResponseBlob(response, `${conversationTitle.replace(/\s+/g, '_')}_export.zip`);
      toast.success('Export ready');
    } catch (err) {
      toast.error(`Export failed: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  }, [
    activeConversation,
    activeConversationId,
    audioFormat,
    audioLayout,
    includeAudio,
    selectedExportTurns,
    textFormats,
    turns,
  ]);

  const startWorkClock = useCallback(() => {
    clearInterval(timerRef.current);
    startedAtRef.current = Date.now();
    setWorkState(prev => ({ ...prev, elapsedSeconds: 0 }));
    timerRef.current = setInterval(() => {
      setWorkState(prev => ({
        ...prev,
        elapsedSeconds: (Date.now() - startedAtRef.current) / 1000,
      }));
    }, 100);
  }, []);

  const pollGeneration = useCallback((requestId) => {
    clearInterval(statusPollRef.current);
    const poll = async () => {
      try {
        const status = await generationStatus(requestId);
        setWorkState(prev => ({ ...prev, backendStatus: status }));
      } catch {
        // The backend status row appears after the request reaches /generate.
      }
    };
    poll();
    statusPollRef.current = setInterval(poll, 750);
  }, []);

  const synthesizeTurnAudio = useCallback(async (speaker, translatedText) => {
    const requestId = makeRequestId();
    const formData = new FormData();
    formData.append('text', translatedText);
    formData.append('request_id', requestId);
    if (speaker.targetLanguage !== 'Auto') formData.append('language', speaker.targetLanguage);
    formData.append('num_step', '16');
    formData.append('guidance_scale', '2');
    formData.append('speed', '1');
    formData.append('denoise', 'true');
    formData.append('postprocess_output', 'true');
    if (speaker.voiceProfileId) formData.append('profile_id', speaker.voiceProfileId);
    if (speaker.referenceTranscript.trim()) formData.append('ref_text', speaker.referenceTranscript.trim());
    if (speaker.style.trim()) formData.append('instruct', speaker.style.trim());

    setWorkState(prev => ({
      ...prev,
      clientPhase: 'requesting',
      backendStatus: null,
      detail: 'Starting synthesis',
    }));
    pollGeneration(requestId);
    const response = await generateSpeech(formData);
    setWorkState(prev => ({ ...prev, clientPhase: 'receiving' }));
    const blob = await response.blob();
    const audioPath = response.headers.get('X-Audio-Path') || '';
    const audioId = response.headers.get('X-Audio-Id') || '';
    const audioUrl = audioPath ? audioUrlWithCacheBust(audioPath) : URL.createObjectURL(blob);
    setWorkState(prev => ({
      ...prev,
      clientPhase: 'done',
      backendStatus: {
        ...(prev.backendStatus || {}),
        status: 'done',
        phase: 'done',
        detail: 'Audio ready',
        progress_pct: 100,
      },
    }));
    playBlobAudio(blob).catch(() => toast.error('Playback failed'));
    loadHistory?.().catch(() => {});
    return { audioUrl, audioId, audioPath };
  }, [loadHistory, pollGeneration]);

  const handleTurn = useCallback(async ({ speak = false } = {}) => {
    const sourceText = draftText.trim();
    if (!sourceText) {
      toast.error('Enter a turn first');
      return;
    }
    if (activeEngineUnavailable) {
      toast.error(translationEngineUnavailableHint(activeEngine));
      return;
    }

    setIsWorking(true);
    startWorkClock();
    setWorkState({
      clientPhase: 'translating',
      backendStatus: null,
      elapsedSeconds: 0,
      detail: 'Translating turn',
    });

    try {
      const result = await translatePromptForSynthesis(
        sourceText,
        activeSpeaker.targetLanguage,
        activeSpeaker.translationProvider,
        { sourceLanguage: activeSpeaker.sourceLanguage },
      );
      if (result.skippedReason === 'unsupported-language') {
        throw new Error(`I don't know how to translate to ${activeSpeaker.targetLanguage} yet`);
      }
      if (result.skippedReason === 'no-translatable-text') {
        throw new Error('Add words outside bracket tags before translating');
      }
      if (result.skippedReason === 'unchanged-output' && activeSpeaker.sourceLanguage !== activeSpeaker.targetLanguage) {
        throw new Error('The translation engine returned the original text unchanged');
      }

      const translatedText = result.text;
      let audio = { audioUrl: '', audioId: '', audioPath: '' };
      if (speak) {
        audio = await synthesizeTurnAudio(activeSpeaker, translatedText);
      }

      const turn = createConversationTurn({
        speaker: activeSpeaker,
        sourceText,
        translatedText,
        audioUrl: audio.audioUrl,
        audioId: audio.audioId,
        audioPath: audio.audioPath,
        sourceAudioUrl: turnAudio?.url || '',
        sourceAudioName: turnAudio?.name || '',
        sourceAudioTranscriptEngine: turnAudio?.engine || '',
      });
      addConversationTurn(turn);
      setTurnAudio(null);
      setDraftText('');
      toast.success(speak ? 'Turn translated and spoken' : 'Turn translated');
    } catch (err) {
      setWorkState(prev => ({
        ...prev,
        clientPhase: 'error',
        backendStatus: {
          ...(prev.backendStatus || {}),
          status: 'error',
          phase: 'error',
          detail: err.message,
          error: err.message,
          progress_pct: null,
        },
      }));
      toast.error(`Conversation turn failed: ${err.message}`);
    } finally {
      clearInterval(timerRef.current);
      clearInterval(statusPollRef.current);
      setIsWorking(false);
    }
  }, [
    activeEngine,
    activeEngineUnavailable,
    activeSpeaker,
    addConversationTurn,
    draftText,
    startWorkClock,
    synthesizeTurnAudio,
    turnAudio,
  ]);

  const handleProfileChange = (speaker, profileId) => {
    const profile = profiles.find(item => item.id === profileId);
    updateSpeaker(speaker.id, {
      voiceProfileId: profileId,
      referenceTranscript: speaker.referenceTranscript || profile?.ref_text || '',
    });
  };

  const selectAllTurns = () => {
    setSelectedTurnIds(turns.map(turn => turn.id));
    setExportScope('selected');
  };

  const clearSelectedTurns = () => {
    setSelectedTurnIds([]);
    if (exportScope === 'selected') setExportScope('all');
  };

  return (
    <div className="conversation-tab">
      <div className="conversation-head">
        <div className="conversation-title">
          <MessageSquareText size={16} />
          <input
            className="input-base conversation-title-input"
            value={activeConversation?.title || 'Conversation'}
            onChange={e => renameConversation(activeConversationId, e.target.value || 'Untitled conversation')}
            aria-label="Conversation title"
          />
        </div>
        <div className="conversation-archive-controls">
          <select
            className="input-base input-base--xs conversation-archive-select"
            value={activeConversationId}
            onChange={e => handleOpenConversation(e.target.value)}
            aria-label="Conversation archive"
          >
            {conversationArchive.map(conversation => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title}
              </option>
            ))}
          </select>
          <Button variant="subtle" size="sm" leading={<Archive size={13} />} onClick={handleNewConversation}>
            New
          </Button>
          <Button variant="icon" iconSize="sm" title="Delete conversation" onClick={handleDeleteConversation}>
            <Trash2 size={12} />
          </Button>
        </div>
        <div className="conversation-speaker-switch" role="tablist" aria-label="Active speaker">
          {conversationSpeakers.map(speaker => (
            <button
              key={speaker.id}
              type="button"
              className={`conversation-speaker-pill ${activeSpeakerId === speaker.id ? 'active' : ''}`}
              style={{ '--speaker-color': speaker.color }}
              onClick={() => setActiveSpeakerId(speaker.id)}
            >
              <UserRound size={12} />
              <span>{speaker.name}</span>
            </button>
          ))}
          <Button variant="icon" iconSize="sm" title="Add speaker" onClick={handleAddSpeaker}>
            <Plus size={13} />
          </Button>
        </div>
      </div>

      <div className="conversation-grid">
        <section className="conversation-panel conversation-panel--speakers">
          <div className="conversation-section-head">
            <span>Speakers</span>
            <Button variant="subtle" size="sm" leading={<Plus size={13} />} onClick={handleAddSpeaker}>
              Add Speaker
            </Button>
          </div>
          <div className="conversation-speakers">
            {conversationSpeakers.map(speaker => (
              <article
                key={speaker.id}
                className={`conversation-speaker-card ${activeSpeakerId === speaker.id ? 'active' : ''}`}
                style={{ '--speaker-color': speaker.color }}
              >
                <div
                  className="conversation-speaker-card__select"
                  onClick={() => setActiveSpeakerId(speaker.id)}
                >
                  <span className="conversation-speaker-card__dot" />
                  <input
                    className="input-base conversation-speaker-card__name"
                    value={speaker.name}
                    onChange={e => updateSpeaker(speaker.id, { name: e.target.value })}
                    onClick={e => e.stopPropagation()}
                    aria-label={`${speaker.name} name`}
                  />
                </div>

                <div className="conversation-card-grid">
                  <div>
                    <div className="label-row label-row--sm">Source</div>
                    <SearchableSelect
                      value={speaker.sourceLanguage}
                      options={ALL_LANGUAGES}
                      popular={POPULAR_LANGS}
                      recentsKey={`omnivoice.recents.conversationSource.${speaker.id}`}
                      onChange={value => updateSpeaker(speaker.id, { sourceLanguage: value })}
                      size="sm"
                    />
                  </div>
                  <div>
                    <div className="label-row label-row--sm">Target</div>
                    <SearchableSelect
                      value={speaker.targetLanguage}
                      options={ALL_LANGUAGES}
                      popular={POPULAR_LANGS}
                      recentsKey={`omnivoice.recents.conversationTarget.${speaker.id}`}
                      onChange={value => updateSpeaker(speaker.id, { targetLanguage: value })}
                      size="sm"
                    />
                  </div>
                </div>

                <div className="conversation-card-grid">
                  <div>
                    <div className="label-row label-row--sm">Mounted Profile</div>
                    <ProfilePicker
                      profiles={profiles}
                      value={speaker.voiceProfileId}
                      onChange={profileId => handleProfileChange(speaker, profileId)}
                    />
                  </div>
                  <div>
                    <div className="label-row label-row--sm">Engine</div>
                    <select
                      className="input-base input-base--xs"
                      value={speaker.translationProvider}
                      onChange={e => updateSpeaker(speaker.id, { translationProvider: e.target.value })}
                    >
                      {translationEngines.map(engine => (
                        <option key={engine.id} value={engine.id}>
                          {translationEngineOptionLabel(engine)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="conversation-card-grid">
                  <div>
                    <div className="label-row label-row--sm">Style</div>
                    <input
                      className="input-base input-base--xs"
                      value={speaker.style}
                      onChange={e => updateSpeaker(speaker.id, { style: e.target.value })}
                      placeholder="optional"
                    />
                  </div>
                  <div>
                    <div className="label-row label-row--sm">Reference</div>
                    <input
                      className="input-base input-base--xs"
                      value={speaker.referenceTranscript}
                      onChange={e => updateSpeaker(speaker.id, { referenceTranscript: e.target.value })}
                      placeholder="profile transcript"
                    />
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="conversation-panel conversation-panel--turn">
          <div className="conversation-turn-head">
            <div className="conversation-turn-head__speaker" style={{ '--speaker-color': activeSpeaker.color }}>
              <span className="conversation-speaker-card__dot" />
              <span>{activeSpeaker.name}</span>
              <span className="conversation-turn-head__route">
                {activeSpeaker.sourceLanguage}{' -> '}{activeSpeaker.targetLanguage}
              </span>
            </div>
          </div>

          <textarea
            className="input-base conversation-textarea"
            value={draftText}
            onChange={e => setDraftText(e.target.value)}
            placeholder="Type the next turn"
            disabled={isWorking}
          />

          <div className="conversation-audio-input">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              hidden
              onChange={handleTurnAudioUpload}
            />
            <div className="conversation-audio-input__actions">
              <Button
                variant={isTurnRecording ? 'danger' : 'subtle'}
                disabled={isWorking || isTurnTranscribing}
                onClick={isTurnRecording ? stopTurnRecording : startTurnRecording}
                leading={isTurnRecording ? <Square size={13} /> : <Mic size={13} />}
              >
                {isTurnRecording ? 'Stop' : 'Record Turn'}
              </Button>
              <Button
                variant="subtle"
                disabled={isWorking || isTurnRecording || isTurnTranscribing}
                onClick={() => fileInputRef.current?.click()}
                leading={<Upload size={13} />}
              >
                Upload Audio
              </Button>
              <Button
                variant="subtle"
                disabled={isWorking || isTurnRecording || !turnAudio?.blob}
                loading={isTurnTranscribing}
                onClick={transcribeTurnAudio}
                leading={!isTurnTranscribing && <Wand2 size={13} />}
              >
                Dictate Text
              </Button>
            </div>

            {isTurnRecording && (
              <div className="conversation-recorder" role="status" aria-live="polite">
                <span>{formatRecordingTime(recordingMs)}</span>
                <div className="conversation-recorder__bars" aria-hidden="true">
                  {audioLevels.map((level, index) => (
                    <i
                      key={index}
                      style={{ transform: `scaleY(${Math.max(0.08, level)})` }}
                    />
                  ))}
                </div>
              </div>
            )}

            {turnAudio && !isTurnRecording && (
              <div className="conversation-source-audio">
                <audio controls src={turnAudio.url} />
                <span title={turnAudio.name}>{turnAudio.name}</span>
                {turnAudio.engine && <Badge tone="info" size="xs">{turnAudio.engine}</Badge>}
                <Button variant="icon" iconSize="sm" title="Clear turn audio" onClick={clearCapturedTurnAudio}>
                  <Trash2 size={12} />
                </Button>
              </div>
            )}
          </div>

          <div className="conversation-actions">
            <Button
              variant="subtle"
              disabled={isWorking || !draftText.trim()}
              loading={isWorking && workState.clientPhase === 'translating'}
              onClick={() => handleTurn({ speak: false })}
              leading={<Languages size={14} />}
            >
              Translate
            </Button>
            <Button
              variant="primary"
              disabled={isWorking || !draftText.trim()}
              loading={isWorking}
              onClick={() => handleTurn({ speak: true })}
              leading={!isWorking && <Sparkles size={14} />}
            >
              Translate + Speak
            </Button>
          </div>

          {isWorking && (
            <div className="conversation-progress" role="status" aria-live="polite">
              <Progress value={progressView.progress} tone="brand" size="sm" />
              <span>
                {progressView.detail || workState.detail || progressView.label}
                {progressView.progress !== null ? ` · ${progressView.progress}%` : ' · working'}
              </span>
            </div>
          )}
        </section>
      </div>

      <section className="conversation-panel conversation-panel--timeline">
        <div className="conversation-timeline-head">
          <span>Turns</span>
          <div className="conversation-timeline-head__actions">
            <span>{turns.length}</span>
            <Button variant="ghost" size="sm" disabled={!turns.length} onClick={selectAllTurns}>
              Select All
            </Button>
            <Button variant="ghost" size="sm" disabled={!selectedTurnIds.length} onClick={clearSelectedTurns}>
              Clear
            </Button>
          </div>
        </div>

        <div className="conversation-export-panel">
          <div className="conversation-export-grid">
            <label>
              <span className="label-row label-row--sm">Scope</span>
              <select
                className="input-base input-base--xs"
                value={exportScope}
                onChange={e => setExportScope(e.target.value)}
              >
                <option value="all">Whole conversation</option>
                <option value="selected">Selected turns</option>
                <option value="range">Range of turns</option>
                <option value="speakers">Speaker combination</option>
              </select>
            </label>

            <label>
              <span className="label-row label-row--sm">Audio</span>
              <select
                className="input-base input-base--xs"
                value={audioFormat}
                onChange={e => setAudioFormat(e.target.value)}
                disabled={!includeAudio}
              >
                <option value="wav">WAV</option>
                <option value="mp3">MP3</option>
                <option value="flac">FLAC</option>
              </select>
            </label>

            <label>
              <span className="label-row label-row--sm">Audio Layout</span>
              <select
                className="input-base input-base--xs"
                value={audioLayout}
                onChange={e => setAudioLayout(e.target.value)}
                disabled={!includeAudio}
              >
                <option value="folder">Folder of files</option>
                <option value="single">Single joined file</option>
              </select>
            </label>

            <div className="conversation-export-count">
              <span>{selectedExportTurns.length}</span>
              <small>turns</small>
            </div>
          </div>

          {exportScope === 'range' && (
            <div className="conversation-export-row">
              <label>
                <span className="label-row label-row--sm">Start</span>
                <input
                  className="input-base input-base--xs"
                  type="number"
                  min="1"
                  max={Math.max(turns.length, 1)}
                  value={exportRangeStart}
                  onChange={e => setExportRangeStart(Number(e.target.value))}
                />
              </label>
              <label>
                <span className="label-row label-row--sm">End</span>
                <input
                  className="input-base input-base--xs"
                  type="number"
                  min="1"
                  max={Math.max(turns.length, 1)}
                  value={exportRangeEnd}
                  onChange={e => setExportRangeEnd(Number(e.target.value))}
                />
              </label>
            </div>
          )}

          {exportScope === 'speakers' && (
            <div className="conversation-export-checks">
              {conversationSpeakers.map(speaker => (
                <label key={speaker.id} className="conversation-check" style={{ '--speaker-color': speaker.color }}>
                  <input
                    type="checkbox"
                    checked={exportSpeakerIds.includes(speaker.id)}
                    onChange={() => toggleExportSpeaker(speaker.id)}
                  />
                  <span className="conversation-speaker-card__dot" />
                  <span>{speaker.name}</span>
                </label>
              ))}
            </div>
          )}

          <div className="conversation-export-row conversation-export-row--wrap">
            <label className="conversation-check">
              <input
                type="checkbox"
                checked={includeAudio}
                onChange={e => setIncludeAudio(e.target.checked)}
              />
              <span>Audio</span>
            </label>
            {['txt', 'json', 'csv', 'pdf'].map(format => (
              <label key={format} className="conversation-check">
                <input
                  type="checkbox"
                  checked={textFormats[format]}
                  onChange={() => toggleTextFormat(format)}
                />
                <span>{format.toUpperCase()}</span>
              </label>
            ))}
            <Button
              variant="primary"
              size="sm"
              loading={isExporting}
              disabled={!turns.length}
              leading={!isExporting && <Download size={13} />}
              onClick={() => exportTurns()}
            >
              Export
            </Button>
          </div>
        </div>
        <div className="conversation-timeline">
          {turns.length === 0 ? (
            <div className="conversation-empty">No turns yet</div>
          ) : turns.map((turn, index) => (
            <article key={turn.id} className="conversation-turn" style={{ '--speaker-color': conversationSpeakers.find(s => s.id === turn.speakerId)?.color || '#d3869b' }}>
              <div className="conversation-turn__meta">
                <label className="conversation-turn__select">
                  <input
                    type="checkbox"
                    checked={selectedTurnIds.includes(turn.id)}
                    onChange={() => toggleSelectedTurn(turn.id)}
                    aria-label={`Select turn ${index + 1}`}
                  />
                  <span>{index + 1}</span>
                </label>
                <span className="conversation-speaker-card__dot" />
                <strong>{turn.speakerName}</strong>
                <span>{turn.sourceLanguage}{' -> '}{turn.targetLanguage}</span>
                <span>{new Date(turn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <Button
                  variant="icon"
                  iconSize="sm"
                  title="Export turn"
                  loading={isExporting}
                  onClick={() => exportTurns([turn])}
                >
                  <FileText size={12} />
                </Button>
              </div>
              <div className="conversation-turn__body">
                <p>{turn.sourceText}</p>
                <p>{turn.translatedText}</p>
              </div>
              {turn.sourceAudioUrl && (
                <div className="conversation-turn__audio conversation-turn__audio--source">
                  <audio controls src={turn.sourceAudioUrl} />
                  <span><Mic size={11} /> {turn.sourceAudioName || 'source audio'}</span>
                  {turn.sourceAudioTranscriptEngine && (
                    <Badge tone="info" size="xs">{turn.sourceAudioTranscriptEngine}</Badge>
                  )}
                </div>
              )}
              {turn.audioUrl && (
                <div className="conversation-turn__audio">
                  <Button
                    variant="icon"
                    iconSize="sm"
                    title="Replay"
                    onClick={() => {
                      const audio = new Audio(turn.audioUrl);
                      audio.play().catch(() => toast.error('Replay failed'));
                    }}
                  >
                    <Play size={12} />
                  </Button>
                  <audio controls src={turn.audioUrl} />
                  <span><Volume2 size={11} /> {turn.audioId || 'audio'}</span>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
