import { useState, useRef, useCallback, useEffect } from 'react';
import { useAppStore } from '../store';
import { generateSpeech, generationStatus } from '../api/generate';
import { translatePromptForSynthesis } from '../api/translate';
import { buildPromptTranslationReceipt, shouldTranslateBeforeSynthesis } from '../utils/promptTranslation';
import { playBlobAudio, playPing } from '../utils/media';
import { probeAudioDuration } from '../utils/format';
import { CLONE_MAX_SECONDS, PRESETS } from '../utils/constants';
import { shouldOpenSamplePreview } from '../utils/audioTrim';
import { toast } from 'react-hot-toast';

/**
 * Encapsulates TTS generation logic, streaming response handling,
 * audio ingestion (with trim gate), and preset/tag helpers.
 */
export default function useTTS({ selectedProfile, setSelectedProfile, loadHistory }) {
  const text = useAppStore(s => s.text);
  const setText = useAppStore(s => s.setText);
  const language = useAppStore(s => s.language);
  const instruct = useAppStore(s => s.instruct);
  const refText = useAppStore(s => s.refText);
  const speed = useAppStore(s => s.speed);
  const steps = useAppStore(s => s.steps);
  const cfg = useAppStore(s => s.cfg);
  const denoise = useAppStore(s => s.denoise);
  const tShift = useAppStore(s => s.tShift);
  const posTemp = useAppStore(s => s.posTemp);
  const classTemp = useAppStore(s => s.classTemp);
  const layerPenalty = useAppStore(s => s.layerPenalty);
  const postprocess = useAppStore(s => s.postprocess);
  const duration = useAppStore(s => s.duration);
  const vdStates = useAppStore(s => s.vdStates);
  const mode = useAppStore(s => s.mode);
  const setSidebarTab = useAppStore(s => s.setSidebarTab);
  const cloneTranslateProvider = useAppStore(s => s.cloneTranslateProvider);

  const [refAudio, setRefAudio] = useState(null);
  const [pendingTrimFile, setPendingTrimFile] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationTime, setGenerationTime] = useState(0);
  const [synthesisProgress, setSynthesisProgress] = useState({
    clientPhase: 'idle',
    backendStatus: null,
    streamProgressPct: null,
    elapsedSeconds: 0,
  });
  const [lastPromptTranslation, setLastPromptTranslation] = useState(null);
  const timerRef = useRef(null);
  const statusPollRef = useRef(null);
  const textAreaRef = useRef(null);
  const ingestSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      clearInterval(timerRef.current);
      clearInterval(statusPollRef.current);
    };
  }, []);

  const ingestRefAudio = useCallback(async (file) => {
    const seq = ingestSeqRef.current + 1;
    ingestSeqRef.current = seq;
    if (!file) {
      setRefAudio(null);
      setPendingTrimFile(null);
      return;
    }
    setSelectedProfile(null);
    setRefAudio(null);
    if (shouldOpenSamplePreview(null, CLONE_MAX_SECONDS)) {
      setPendingTrimFile(file);
      let dur = null;
      try {
        dur = await probeAudioDuration(file);
      } catch {
        // Some recorded blobs do not expose usable metadata until decoded in the trimmer.
      }
      if (ingestSeqRef.current !== seq) return;
      if (dur && dur > CLONE_MAX_SECONDS) {
        toast(`Audio is ${dur.toFixed(1)}s — trim to ≤${CLONE_MAX_SECONDS}s for best cloning`);
      } else {
        toast('Preview the sample, then click Use trimmed to load it');
      }
      return;
    }
    setRefAudio(file);
  }, [setSelectedProfile]);

  const insertTag = useCallback((tag) => {
    if (!textAreaRef.current) return;
    const start = textAreaRef.current.selectionStart;
    const end = textAreaRef.current.selectionEnd;
    setText(text.substring(0, start) + tag + text.substring(end));
    setTimeout(() => { textAreaRef.current.focus(); textAreaRef.current.setSelectionRange(start + tag.length, start + tag.length); }, 0);
  }, [text, setText]);

  const applyPreset = useCallback((preset) => {
    useAppStore.getState().setVdStates(preset.attrs);
    if (preset.tags && !text.includes(preset.tags.trim())) insertTag(preset.tags);
  }, [text, insertTag]);

  const handleGenerate = useCallback(async ({ translateBeforeSynthesis = false } = {}) => {
    if (!text.trim()) return toast.error("Please enter text");
    if (mode === 'clone' && !refAudio && !selectedProfile) return toast.error("Upload an audio or select a voice profile");
    const effectiveRefText = refText.trim();
    if (mode === 'clone' && !effectiveRefText) {
      setSidebarTab('clone');
      return toast.error("Add what the reference sample says in Reference Transcript before synthesizing");
    }
    setIsGenerating(true);
    setGenerationTime(0);
    setSynthesisProgress({
      clientPhase: 'preparing',
      backendStatus: null,
      streamProgressPct: null,
      elapsedSeconds: 0,
    });
    let receivedAudio = false;
    const st = Date.now();
    timerRef.current = setInterval(() => {
      const elapsedSeconds = (Date.now() - st) / 1000;
      setGenerationTime(elapsedSeconds.toFixed(1));
      setSynthesisProgress(prev => ({ ...prev, elapsedSeconds }));
    }, 100);
    try {
      const shouldTranslatePrompt = shouldTranslateBeforeSynthesis({ mode, translateBeforeSynthesis });
      if (shouldTranslatePrompt) {
        setSynthesisProgress(prev => ({
          ...prev,
          clientPhase: 'translating',
          backendStatus: null,
          streamProgressPct: null,
        }));
      }
      const synthesisText = shouldTranslatePrompt
        ? await translatePromptForSynthesis(text, language, cloneTranslateProvider)
        : { text, translated: false, targetCode: null };
      if (synthesisText.translated) {
        toast.success(`Translated prompt to ${language} before synthesis`);
      } else if (shouldTranslatePrompt) {
        if (synthesisText.skippedReason === 'already-target-language') {
          toast(`Prompt already looks like ${language}; synthesizing as-is`);
        } else if (synthesisText.skippedReason === 'unsupported-language') {
          throw new Error(`I don't know how to translate to ${language} yet`);
        } else if (synthesisText.skippedReason === 'no-translatable-text') {
          throw new Error('Add words outside bracket tags before translating');
        } else if (synthesisText.skippedReason === 'unchanged-output') {
          throw new Error('The translation engine returned the original text unchanged');
        }
      }
      setSynthesisProgress(prev => ({
        ...prev,
        clientPhase: 'preparing',
        streamProgressPct: null,
      }));

      const formData = new FormData();
      const requestId = globalThis.crypto?.randomUUID?.() || `gen-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      formData.append("text", synthesisText.text);
      formData.append("request_id", requestId);
      if (language !== 'Auto') formData.append("language", language);
      formData.append("num_step", steps);
      formData.append("guidance_scale", cfg);
      formData.append("speed", speed);
      formData.append("denoise", denoise);
      formData.append("t_shift", tShift);
      formData.append("position_temperature", posTemp);
      formData.append("class_temperature", classTemp);
      formData.append("layer_penalty_factor", layerPenalty);
      formData.append("postprocess_output", postprocess);
      if (duration) formData.append("duration", parseFloat(duration));

      if (mode === 'clone') {
        if (selectedProfile) {
          formData.append("profile_id", selectedProfile);
          if (effectiveRefText) formData.append("ref_text", effectiveRefText);
        } else if (refAudio) {
          const arrBuf = await refAudio.arrayBuffer();
          const safeBlob = new Blob([arrBuf], { type: refAudio.type });
          formData.append("ref_audio", safeBlob, refAudio.name || "audio.wav");
          formData.append("ref_text", effectiveRefText);
        }
        if (instruct) formData.append("instruct", instruct);
      } else {
        const designSeed = Math.floor(Math.random() * 2147483647);
        formData.append("seed", designSeed);
        const parts = Object.values(vdStates).filter(v => v !== 'Auto');
        if (instruct.trim()) parts.push(instruct.trim());
        const finalInstruct = parts.join(', ');
        if (finalInstruct) formData.append("instruct", finalInstruct);
        if (selectedProfile) {
          formData.append("profile_id", selectedProfile);
        }
      }

      setSynthesisProgress(prev => ({
        ...prev,
        clientPhase: 'requesting',
        backendStatus: null,
        streamProgressPct: null,
      }));
      clearInterval(statusPollRef.current);
      const pollGenerationStatus = async () => {
        try {
          const status = await generationStatus(requestId);
          setSynthesisProgress(prev => ({
            ...prev,
            backendStatus: status,
          }));
        } catch {
          // The request may not have reached the backend yet; keep the local phase.
        }
      };
      pollGenerationStatus();
      statusPollRef.current = setInterval(pollGenerationStatus, 750);

      const response = await generateSpeech(formData);
      const reader = response.body.getReader();
      const chunks = [];
      let receivedLength = 0;
      const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
      setSynthesisProgress(prev => ({
        ...prev,
        clientPhase: 'receiving',
        streamProgressPct: contentLength > 0 ? 0 : null,
      }));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;
        if (contentLength > 0) {
          const pct = Math.round((receivedLength / contentLength) * 100);
          setSynthesisProgress(prev => ({
            ...prev,
            clientPhase: 'receiving',
            streamProgressPct: pct,
          }));
        }
      }

      const blob = new Blob(chunks, { type: 'audio/wav' });
      receivedAudio = true;
      setSynthesisProgress(prev => ({
        ...prev,
        clientPhase: 'finalizing',
        streamProgressPct: 100,
      }));
      const translationReceipt = buildPromptTranslationReceipt(text, language, synthesisText);
      if (translationReceipt) setLastPromptTranslation(translationReceipt);
      clearInterval(timerRef.current);
      clearInterval(statusPollRef.current);
      const elapsedSeconds = (Date.now() - st) / 1000;
      setGenerationTime(elapsedSeconds.toFixed(1));
      setSynthesisProgress(prev => ({
        ...prev,
        clientPhase: 'done',
        backendStatus: {
          ...(prev.backendStatus || {}),
          status: 'done',
          phase: 'done',
          detail: 'Audio ready',
          progress_pct: 100,
        },
        streamProgressPct: 100,
        elapsedSeconds,
      }));
      setIsGenerating(false);

      playBlobAudio(blob).catch(() => toast.error('Playback failed'));
      loadHistory()
        .then(() => setSidebarTab('history'))
        .catch(() => toast.error('Audio generated, but history refresh failed'));
      playPing();
    } catch (err) {
      setSynthesisProgress(prev => ({
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
      toast.error("Error: " + err.message);
    } finally {
      clearInterval(timerRef.current);
      clearInterval(statusPollRef.current);
      if (!receivedAudio) setIsGenerating(false);
    }
  }, [text, mode, selectedProfile, refAudio, refText, language, instruct, steps, cfg, speed, denoise, tShift, posTemp, classTemp, layerPenalty, postprocess, duration, vdStates, cloneTranslateProvider, loadHistory, setSidebarTab]);

  return {
    refAudio, setRefAudio,
    pendingTrimFile, setPendingTrimFile,
    isGenerating, generationTime, synthesisProgress,
    lastPromptTranslation,
    textAreaRef,
    ingestRefAudio,
    insertTag, applyPreset,
    handleGenerate,
  };
}
