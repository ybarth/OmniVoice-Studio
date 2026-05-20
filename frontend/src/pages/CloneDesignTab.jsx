import React, { useState, useEffect, useRef } from 'react';
import {
  PanelLeftOpen, PanelLeftClose, Command, Globe, SlidersHorizontal, Volume2, User,
  UploadCloud, Square, Mic, Save, UserSquare2, Settings2, ChevronUp, ChevronDown,
  Sparkles, Play, Trash2, X, Languages, Undo2, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import SearchableSelect from '../components/SearchableSelect';
import ALL_LANGUAGES from '../languages.json';
import { POPULAR_LANGS, PRESETS, TAGS, CATEGORIES } from '../utils/constants';
import { translatePromptForSynthesis } from '../api/translate';
import { installTranslationEngine, listTranslationEngines } from '../api/engines';
import {
  appendPromptTranslationReceiptVariant,
  appendPromptTranslationVariant,
  buildPromptTransformFrames,
  canTranslatePromptOnly,
  navigatePromptVariant,
} from '../utils/promptTranslation';
import {
  translationEngineOptionLabel,
  translationEngineUnavailableHint,
} from '../utils/translationEngineStatus';
import { selectSynthesisProgressView } from '../utils/synthesisProgress';
import { useAppStore } from '../store';
import { Button, Input, Slider, Progress } from '../ui';
import { API } from '../api/client';
import './CloneDesignTab.css';

export default function CloneDesignTab(props) {
  const {
    mode,
    textAreaRef,
    text, setText,
    language, setLanguage,
    steps, setSteps,
    cfg, setCfg,
    speed, setSpeed,
    tShift, setTShift,
    posTemp, setPosTemp,
    classTemp, setClassTemp,
    layerPenalty, setLayerPenalty,
    duration, setDuration,
    denoise, setDenoise,
    postprocess, setPostprocess,
    showOverrides, setShowOverrides,
    isSidebarCollapsed, setIsSidebarCollapsed,
    profiles,
    selectedProfile, setSelectedProfile,
    refAudio,
    refText, setRefText,
    instruct, setInstruct,
    profileName, setProfileName,
    showSaveProfile, setShowSaveProfile,
    isSavingProfile,
    isRecording, isCleaning, recordingTime,
    vdStates, setVdStates,
    isGenerating, generationTime,
    synthesisProgress,
    lastPromptTranslation,
    applyPreset, insertTag,
    handleSelectProfile, handleDeleteProfile,
    handleSaveProfile, handleGenerate,
    startRecording, stopRecording,
    ingestRefAudio,
  } = props;

  const { t } = useTranslation();
  const cloneTranslateProvider = useAppStore(s => s.cloneTranslateProvider);
  const setCloneTranslateProvider = useAppStore(s => s.setCloneTranslateProvider);
  const [activePersonality, setActivePersonality] = useState('');
  const [isPromptTranslating, setIsPromptTranslating] = useState(false);
  const [isPromptTransforming, setIsPromptTransforming] = useState(false);
  const [engineInstalling, setEngineInstalling] = useState('');
  const [promptVariantHistory, setPromptVariantHistory] = useState([]);
  const [promptVariantIndex, setPromptVariantIndex] = useState(-1);
  const transformTimersRef = useRef([]);
  const appliedSynthesisTranslationRef = useRef('');
  const promptTranslationBusy = isPromptTranslating || isPromptTransforming;
  const currentPromptVariant = promptVariantHistory[promptVariantIndex] || null;
  const showPromptHistory = promptVariantHistory.length > 1;
  const canMovePromptBack = showPromptHistory && promptVariantIndex > 0 && !promptTranslationBusy;
  const canMovePromptForward = showPromptHistory && promptVariantIndex < promptVariantHistory.length - 1 && !promptTranslationBusy;
  const { data: translationEngineData, refetch: refetchTranslationEngines } = useQuery({
    queryKey: ['translation-engines'],
    queryFn: listTranslationEngines,
    staleTime: 30_000,
    refetchInterval: isPromptTranslating || synthesisProgress?.clientPhase === 'translating' ? 750 : false,
  });
  const translationEngines = translationEngineData?.engines || [
    { id: 'hymt-1.8b', display_name: 'HY-MT1.5 1.8B (Local Cantonese)', installed: true },
    { id: 'hymt-7b', display_name: 'HY-MT1.5 7B (Local, Higher Quality)', installed: true },
    { id: 'openai', display_name: 'OpenAI (API)', installed: true },
    { id: 'openai-compatible', display_name: 'OpenAI-compatible LLM', installed: true },
    { id: 'google', display_name: 'Google Translate (Online)', installed: true },
  ];
  const activeTranslationEngine = translationEngines.find(engine => engine.id === cloneTranslateProvider);
  const activeEngineUnavailable = Boolean(activeTranslationEngine && activeTranslationEngine.installed === false);
  const canUseTranslationEngine = !activeEngineUnavailable;
  const translationProgressDetail = activeTranslationEngine?.runtime_detail
    || (activeTranslationEngine?.runtime_status === 'loading'
      ? 'Loading translation model'
      : activeTranslationEngine?.runtime_status === 'generating'
        ? 'Translating prompt'
        : `Translating with ${activeTranslationEngine?.display_name || cloneTranslateProvider}`);
  const canTranslatePrompt = canTranslatePromptOnly({
    mode,
    language,
    text,
    busy: promptTranslationBusy || isGenerating,
  }) && canUseTranslationEngine;
  const synthesisProgressView = selectSynthesisProgressView({
    clientPhase: synthesisProgress?.clientPhase,
    backendStatus: synthesisProgress?.backendStatus,
    translationEngine: activeTranslationEngine,
    streamProgressPct: synthesisProgress?.streamProgressPct,
    elapsedSeconds: synthesisProgress?.elapsedSeconds ?? Number.parseFloat(String(generationTime)),
  });

  // Fetch personality presets from backend
  const { data: personalities = [] } = useQuery({
    queryKey: ['personalities'],
    queryFn: () => fetch(`${API}/personalities`).then(r => r.json()),
    staleTime: Infinity,
  });

  const applyPersonality = (p) => {
    if (activePersonality === p.id) {
      setActivePersonality('');
      return;
    }
    setActivePersonality(p.id);
    setInstruct(p.instruct);
  };

  useEffect(() => {
    return () => {
      transformTimersRef.current.forEach(clearTimeout);
      transformTimersRef.current = [];
    };
  }, []);

  const playPromptTransform = (sourceText, translatedText) => {
    transformTimersRef.current.forEach(clearTimeout);
    transformTimersRef.current = [];
    setIsPromptTransforming(true);

    const frames = buildPromptTransformFrames(sourceText, translatedText);

    frames.forEach((frame, index) => {
      const timer = setTimeout(() => {
        setText(frame);
        if (index === frames.length - 1) {
          setIsPromptTransforming(false);
          transformTimersRef.current = [];
          setTimeout(() => textAreaRef.current?.focus?.(), 0);
        }
      }, index * 42);
      transformTimersRef.current.push(timer);
    });
  };

  useEffect(() => {
    if (!lastPromptTranslation?.translatedText) return;
    const receiptKey = [
      lastPromptTranslation.createdAt,
      lastPromptTranslation.sourceText,
      lastPromptTranslation.translatedText,
      lastPromptTranslation.language,
    ].join('|');
    if (appliedSynthesisTranslationRef.current === receiptKey) return;
    appliedSynthesisTranslationRef.current = receiptKey;
    if (text !== lastPromptTranslation.sourceText) return;

    const nextHistory = appendPromptTranslationReceiptVariant(
      promptVariantHistory,
      promptVariantIndex,
      lastPromptTranslation,
    );
    setPromptVariantHistory(nextHistory.history);
    setPromptVariantIndex(nextHistory.activeIndex);
    playPromptTransform(lastPromptTranslation.sourceText, lastPromptTranslation.translatedText);
  }, [lastPromptTranslation, text, promptVariantHistory, promptVariantIndex]);

  const handleInstallTranslationEngine = async () => {
    if (!activeTranslationEngine || !activeTranslationEngine.pip_package) return;
    setEngineInstalling(activeTranslationEngine.id);
    try {
      await installTranslationEngine(activeTranslationEngine.id);
      await refetchTranslationEngines();
      toast.success(`${activeTranslationEngine.display_name} is ready`);
    } catch (err) {
      toast.error(`Engine install failed: ${err.message}`);
    } finally {
      setEngineInstalling('');
    }
  };

  const handleTranslatePrompt = async () => {
    if (!text.trim()) {
      toast.error('Please enter text');
      return;
    }
    if (language === 'Auto') {
      toast.error('Pick a target language first');
      return;
    }
    if (activeEngineUnavailable) {
      toast.error(translationEngineUnavailableHint(activeTranslationEngine));
      return;
    }
    if (promptTranslationBusy) return;

    const sourceText = text;
    setIsPromptTranslating(true);
    try {
      const result = await translatePromptForSynthesis(sourceText, language, cloneTranslateProvider);
      if (!result.translated) {
        if (result.skippedReason === 'unsupported-language') {
          toast.error(`I don't know how to translate to ${language} yet`);
        } else if (result.skippedReason === 'no-translatable-text') {
          toast.error('Add words outside bracket tags before translating');
        } else if (result.skippedReason === 'unchanged-output') {
          toast.error('The translation engine returned the original text unchanged');
        } else {
          toast(`Prompt already looks like ${language}`);
        }
        return;
      }
      const nextHistory = appendPromptTranslationVariant(
        promptVariantHistory,
        promptVariantIndex,
        sourceText,
        language,
        result,
      );
      setPromptVariantHistory(nextHistory.history);
      setPromptVariantIndex(nextHistory.activeIndex);
      playPromptTransform(sourceText, result.text);
      toast.success(`Translated prompt to ${language}`);
    } catch (err) {
      toast.error(`Translation failed: ${err.message}`);
    } finally {
      setIsPromptTranslating(false);
    }
  };

  const handleNavigatePromptVariant = (delta) => {
    const nextIndex = navigatePromptVariant(promptVariantHistory, promptVariantIndex, delta);
    if (nextIndex === promptVariantIndex || nextIndex < 0) return;
    const nextVariant = promptVariantHistory[nextIndex];
    if (!nextVariant) return;
    setPromptVariantIndex(nextIndex);
    if (nextVariant.kind === 'translation' && nextVariant.language !== language) {
      setLanguage(nextVariant.language);
    }
    playPromptTransform(text, nextVariant.text);
  };

  const handlePromptEdit = (nextText) => {
    setText(nextText);
    if (!isPromptTransforming) {
      setPromptVariantHistory([]);
      setPromptVariantIndex(-1);
    }
  };

  return (
    <div className="clone-split-grid">

      {/* ═══ LEFT COLUMN: prompt + language/steps ═══ */}
      <div className="studio-column">
        <div className="studio-panel">
          <div className="label-row label-row--center label-row--spread">
            <span className="clone-prompt-label-main">
              <Button
                variant="icon"
                iconSize="sm"
                active={isSidebarCollapsed}
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                title="Toggle Sidebar"
                className="label-row__kicker"
              >
                {isSidebarCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
              </Button>
              <Command className="label-icon" size={14} /> Prompt
            </span>
          </div>
          {mode === 'design' && (
            <div className="preset-grid">
              {PRESETS.map(p => (
                <button key={p.id} className="preset-btn" onClick={() => applyPreset(p)}>{p.name}</button>
              ))}
            </div>
          )}
          <textarea
            ref={textAreaRef}
            className={`input-base clone-text-area ${isPromptTransforming ? 'clone-text-area--transforming' : ''}`}
            placeholder={mode === 'clone' ? "What should this voice say? ✍️" : "Describe the voice, then type what it says…"}
            value={text}
            readOnly={isPromptTransforming}
            onChange={e => handlePromptEdit(e.target.value)}
          />
          {showPromptHistory && (
            <div className="clone-prompt-history" aria-label="Prompt translation history">
              <Button
                variant="icon"
                iconSize="sm"
                disabled={!canMovePromptBack}
                onClick={() => handleNavigatePromptVariant(-1)}
                title="Undo to previous prompt"
              >
                <Undo2 size={12} />
              </Button>
              <Button
                variant="icon"
                iconSize="sm"
                disabled={!canMovePromptBack}
                onClick={() => handleNavigatePromptVariant(-1)}
                title="Previous prompt version"
              >
                <ChevronLeft size={12} />
              </Button>
              <span className="clone-prompt-history__label">
                {promptVariantIndex + 1}/{promptVariantHistory.length}
                {' · '}
                {currentPromptVariant?.language || 'Original'}
              </span>
              <Button
                variant="icon"
                iconSize="sm"
                disabled={!canMovePromptForward}
                onClick={() => handleNavigatePromptVariant(1)}
                title="Next prompt version"
              >
                <ChevronRight size={12} />
              </Button>
            </div>
          )}
          <div className="tags-container">
            {TAGS.map(tag => <button key={tag} className="tag-btn" onClick={() => insertTag(tag)}>{tag}</button>)}
            <button
              className="tag-btn clone-auto-extract-btn"
              onClick={() => insertTag('[B EY1 S]')}
            >
              [CMU]
            </button>
          </div>
        </div>

        <div className="studio-panel clone-panel--overflow-visible">
          <div className="grid-2">
            <div>
              <div className="label-row"><Globe className="label-icon" size={14} /> Language ({ALL_LANGUAGES.length - 1})</div>
              <SearchableSelect
                value={language}
                options={ALL_LANGUAGES}
                popular={POPULAR_LANGS}
                recentsKey="omnivoice.recents.genLang"
                onChange={setLanguage}
              />
            </div>
            <div>
              <div className="label-row label-row--spread">
                <span className="label-row label-row--flush">
                  <SlidersHorizontal className="label-icon" size={14} /> Steps
                </span>
                <span className="val-bubble">{steps}</span>
              </div>
              <input type="range" min="8" max="64" value={steps} onChange={e => setSteps(Number(e.target.value))} />
            </div>
          </div>
        </div>
      </div>

      {/* ═══ RIGHT COLUMN: voice source + overrides/synth ═══ */}
      <div className="studio-column">
        <div className="studio-panel">
        {mode === 'clone' ? (
          <div>
            <div className="label-row"><Volume2 className="label-icon" size={14} /> Voice Source</div>

            {/* ── VOICE PROFILES ── */}
            {profiles.length > 0 && (
              <div className="clone-profile-block">
                <div className="label-row label-row--sm"><User size={12} /> Saved Profiles</div>
                <div className="preset-grid">
                  {profiles.map(p => (
                    <div
                      key={p.id}
                      className={`preset-btn clone-profile-card ${selectedProfile === p.id ? 'profile-active' : ''}`}
                      onClick={() => handleSelectProfile(p)}
                    >
                      <User size={10} /> {p.name}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleDeleteProfile(p.id); }}
                        className="clone-profile-delete"
                        aria-label="Delete profile"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedProfile && (
              <div className="clone-profile-banner">
                <span className="clone-profile-banner__label">
                  Using profile: {profiles.find(p => p.id === selectedProfile)?.name}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedProfile(null)}
                  leading={<X size={11} />}
                >
                  clear
                </Button>
              </div>
            )}

            <div className="clone-drop-row">
              <input
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
                onChange={e => { const f = e.target.files[0]; ingestRefAudio(f); e.target.value = ''; }}
                className="dub-hidden-file"
                id="audio-upload"
              />
              <label
                htmlFor="audio-upload"
                className="file-drag clone-drop-zone"
                onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('is-dragging'); }}
                onDragLeave={e => { e.currentTarget.classList.remove('is-dragging'); }}
                onDrop={e => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('is-dragging');
                  const file = e.dataTransfer.files[0];
                  const okType = file && (file.type.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac|webm)$/i.test(file.name));
                  if (okType) ingestRefAudio(file);
                }}
              >
                <UploadCloud color="#a89984" size={18} />
                <p>
                  {refAudio
                    ? <span className="clone-drop-filename">{refAudio.name}</span>
                    : selectedProfile
                      ? 'Drop or record a new sample to replace this profile.'
                      : 'Drop audio here — or click. WAV, MP3, M4A… 🎤'}
                </p>
              </label>

              <MicButton
                isCleaning={isCleaning}
                isRecording={isRecording}
                recordingTime={recordingTime}
                onStart={startRecording}
                onStop={stopRecording}
              />
            </div>

            <div className="grid-2 grid-2--indent">
              <div>
                <div className="label-row">Reference Transcript</div>
                <input type="text" className="input-base" value={refText} onChange={e => setRefText(e.target.value)} placeholder="Required: what the sample says" />
              </div>
              <div>
                <div className="label-row">Style</div>
                <input type="text" className="input-base" value={instruct} onChange={e => setInstruct(e.target.value)} placeholder="e.g. whisper" />
              </div>
            </div>

            {/* Save as profile */}
            {refAudio && !selectedProfile && (
              <div className="clone-save-profile">
                {!showSaveProfile ? (
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => setShowSaveProfile(true)}
                    leading={<Save size={12} />}
                  >
                    Save as Voice Profile
                  </Button>
                ) : (
                  <div className="clone-save-profile__row">
                    <Input
                      size="sm"
                      placeholder="Profile name…"
                      value={profileName}
                      onChange={e => setProfileName(e.target.value)}
                    />
                    <Button
                      variant="subtle"
                      size="sm"
                      onClick={handleSaveProfile}
                      loading={isSavingProfile}
                      disabled={isSavingProfile}
                    >
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowSaveProfile(false)}
                      disabled={isSavingProfile}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="label-row"><UserSquare2 className="label-icon" size={14} /> {t('voice.personality')}</div>

            {/* Personality presets */}
            {personalities.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div className="personality-label">{t('voice.pick_personality')}</div>
                <div className="personality-strip">
                  {personalities.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      className={`personality-chip ${activePersonality === p.id ? 'active' : ''}`}
                      onClick={() => applyPersonality(p)}
                    >
                      <span className="personality-chip__icon">{p.icon}</span>
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="clone-sliders-col">
              {Object.entries(CATEGORIES).map(([key, options]) => {
                const many = options.length > 6;
                return (
                  <div key={key}>
                    <div className="label-row label-row--sm">
                      {key.replace(/([A-Z])/g, ' $1').trim()}
                      <span className="clone-slider-kicker">
                        {vdStates[key] === 'Auto' ? '· auto' : `· ${vdStates[key]}`}
                      </span>
                    </div>
                    {many ? (
                      <select
                        className="input-base"
                        value={vdStates[key]}
                        onChange={e => setVdStates({ ...vdStates, [key]: e.target.value })}
                      >
                        {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <div className="chip-group">
                        {options.map(opt => (
                          <button
                            key={opt}
                            type="button"
                            className={`chip ${vdStates[key] === opt ? 'active' : ''}`}
                            onClick={() => setVdStates({ ...vdStates, [key]: opt })}
                          >
                            {opt === 'Auto' ? '✨ Auto' : opt}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        </div>

        <div className="studio-panel clone-panel--overflow-visible">
        <div className="override-toggle" onClick={() => setShowOverrides(!showOverrides)}>
          <span><Settings2 size={14} className="clone-icon-inline" /> Production Overrides</span>
          {showOverrides ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
        {showOverrides && (
          <div className="override-content">
            <div className="grid-4">
              <div>
                <div className="label-row label-row--spread"><span>CFG</span><span className="val-bubble">{cfg}</span></div>
                <input type="range" min="1.0" max="4.0" step="0.1" value={cfg} onChange={e => setCfg(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>Speed</span><span className="val-bubble">{speed}x</span></div>
                <input type="range" min="0.5" max="2.0" step="0.1" value={speed} onChange={e => setSpeed(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>t_shift</span><span className="val-bubble">{tShift}</span></div>
                <input type="range" min="0" max="1.0" step="0.05" value={tShift} onChange={e => setTShift(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>Pos Temp</span><span className="val-bubble">{posTemp}</span></div>
                <input type="range" min="0" max="10" step="0.5" value={posTemp} onChange={e => setPosTemp(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>Class Temp</span><span className="val-bubble">{classTemp}</span></div>
                <input type="range" min="0" max="2" step="0.1" value={classTemp} onChange={e => setClassTemp(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row label-row--spread"><span>Layer Pen</span><span className="val-bubble">{layerPenalty}</span></div>
                <input type="range" min="0" max="10" step="0.5" value={layerPenalty} onChange={e => setLayerPenalty(Number(e.target.value))} />
              </div>
              <div>
                <div className="label-row"><span>Duration</span></div>
                <input type="text" className="input-base clone-duration-input" value={duration} onChange={e => setDuration(e.target.value)} placeholder="Auto" />
              </div>
              <div className="clone-prod-col">
                <label className="clone-prod-check">
                  <input type="checkbox" checked={denoise} onChange={e => setDenoise(e.target.checked)} /> Denoise
                </label>
                <label className="clone-prod-check">
                  <input type="checkbox" checked={postprocess} onChange={e => setPostprocess(e.target.checked)} /> Postprocess
                </label>
              </div>
            </div>
          </div>
        )}

        {mode === 'clone' && (
          <div className="clone-translation-engine">
            <div className="label-row label-row--sm label-row--flush">
              <Languages className="label-icon" size={11} /> Translation Engine
            </div>
            <div className="clone-translation-engine__controls">
              <select
                className="input-base clone-translation-engine__select"
                value={cloneTranslateProvider}
                onChange={e => setCloneTranslateProvider(e.target.value)}
                title={activeTranslationEngine?.notes || 'Choose the translation engine for Clone prompt translation'}
              >
                {translationEngines.map(engine => (
                  <option key={engine.id} value={engine.id}>
                    {translationEngineOptionLabel(engine)}
                  </option>
                ))}
              </select>
              {activeEngineUnavailable && activeTranslationEngine?.pip_package && !translationEngineData?.sandboxed && (
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={handleInstallTranslationEngine}
                  loading={engineInstalling === activeTranslationEngine.id}
                  disabled={Boolean(engineInstalling)}
                  className="clone-translation-engine__install"
                >
                  Install
                </Button>
              )}
              {activeEngineUnavailable && activeTranslationEngine?.model_repo_id && activeTranslationEngine?.model_installed === false && (
                <span
                  className="clone-translation-engine__hint"
                  title="Download this translation model from Settings > Models."
                >
                  Install in Models
                </span>
              )}
            </div>
          </div>
        )}

        <div className={`clone-footer-actions ${mode === 'clone' ? 'clone-footer-actions--split' : ''}`}>
          <Button
            variant="primary"
            block
            loading={isGenerating}
            onClick={() => handleGenerate()}
            leading={!isGenerating && <Play size={14} />}
            className="clone-footer-cta"
          >
            {isGenerating ? `${synthesisProgressView.label}… (${synthesisProgressView.elapsedLabel})` : 'Synthesize Audio'}
          </Button>
          {mode === 'clone' && (
            <>
              <Button
                variant="subtle"
                block
                loading={isPromptTranslating}
                disabled={!canTranslatePrompt}
                onClick={handleTranslatePrompt}
                leading={<Languages size={14} />}
                className="clone-footer-cta"
                title={language === 'Auto' ? 'Pick a target language first' : `Translate prompt to ${language}`}
              >
                Translate
              </Button>
              <Button
                variant="subtle"
                block
                disabled={isGenerating || language === 'Auto' || !canUseTranslationEngine}
                onClick={() => handleGenerate({ translateBeforeSynthesis: true })}
                leading={<Globe size={14} />}
                className="clone-footer-cta"
                title={language === 'Auto' ? 'Pick a target language first' : `Translate prompt to ${language}, then synthesize`}
              >
                Translate and Synthesize
              </Button>
            </>
          )}
        </div>
        {isGenerating && (
          <div className="clone-translation-progress clone-synthesis-progress" role="status" aria-live="polite">
            <Progress
              value={synthesisProgressView.progress}
              tone="brand"
              size="sm"
              className="clone-footer-cta"
            />
            <span>
              {synthesisProgressView.detail || synthesisProgressView.label}
              {synthesisProgressView.progress !== null ? ` · ${synthesisProgressView.progress}%` : ' · working'}
            </span>
          </div>
        )}
        {isPromptTranslating && (
          <div className="clone-translation-progress" role="status" aria-live="polite">
            <Progress
              value={activeTranslationEngine?.runtime_progress_pct ?? null}
              tone="brand"
              size="sm"
            />
            <span>{translationProgressDetail}</span>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function MicButton({ isCleaning, isRecording, recordingTime, onStart, onStop }) {
  if (isCleaning) {
    return (
      <div className="mic-btn mic-btn--cleaning">
        <Sparkles size={18} className="spinner" />
        <span>Cleaning…</span>
      </div>
    );
  }
  if (isRecording) {
    return (
      <button type="button" onClick={onStop} className="mic-btn mic-btn--recording">
        <Square size={18} fill="currentColor" />
        <span>{recordingTime}s</span>
      </button>
    );
  }
  return (
    <button type="button" onClick={onStart} className="mic-btn mic-btn--idle" title="Record your voice for cloning">
      <Mic size={18} />
      <span>Record</span>
    </button>
  );
}
