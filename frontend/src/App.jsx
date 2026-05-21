import React, { useCallback, useEffect, lazy, Suspense, useState } from 'react';
import './index.css';

import { Toaster, toast } from 'react-hot-toast';

import { useAppStore } from './store';
import Header from './components/Header';
import NavRail from './components/NavRail';
import ErrorBoundary from './components/ErrorBoundary';
import FloatingPill from './components/FloatingPill';
import useAppData from './hooks/useAppData';
import useProfiles from './hooks/useProfiles';
import useTTS from './hooks/useTTS';
import useRecording from './hooks/useRecording';
import { BootstrapSplash, useBootstrapStage } from './components/BootstrapSplash';
import { CLONE_MAX_SECONDS } from './utils/constants';
import { doubleClickMaximize } from './utils/media';
import { flushMemory as apiFlushMemory } from './api/system';
import { exportReveal } from './api/exports';
import {
  deviceClassNames,
  getDeviceProfile,
  writeDeviceDataset,
} from './utils/deviceProfile';

const AudioTrimmer = lazy(() => import('./components/AudioTrimmer'));
const ConversationTab = lazy(() => import('./pages/ConversationTab'));
const CloneDesignTab = lazy(() => import('./pages/CloneDesignTab'));
const Settings = lazy(() => import('./pages/Settings'));
const Drive = lazy(() => import('./pages/Projects'));
const LogsFooter = lazy(() => import('./components/LogsFooter'));

const LazyFallback = () => <div className="app-lazy-fallback">Loading...</div>;

const SUPPORTED_MODES = new Set(['conversation', 'clone', 'design', 'projects', 'settings']);

function normalizeMode(mode) {
  return SUPPORTED_MODES.has(mode) ? mode : 'conversation';
}

function App() {
  const { stage: bootstrapStage, message: bootstrapMessage } = useBootstrapStage();
  const [device, setDevice] = useState(() => getDeviceProfile());

  const uiScale = useAppStore(s => s.uiScale);
  const theme = useAppStore(s => s.theme);
  const mode = useAppStore(s => s.mode);
  const setModeRaw = useAppStore(s => s.setMode);
  const setMode = useCallback((nextMode) => setModeRaw(normalizeMode(nextMode)), [setModeRaw]);

  useEffect(() => {
    if (theme && theme !== 'gruvbox') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  useEffect(() => {
    if (!SUPPORTED_MODES.has(mode)) setModeRaw('conversation');
  }, [mode, setModeRaw]);

  useEffect(() => {
    const updateDevice = () => setDevice(getDeviceProfile());
    updateDevice();
    window.addEventListener('resize', updateDevice);
    window.addEventListener('orientationchange', updateDevice);
    return () => {
      window.removeEventListener('resize', updateDevice);
      window.removeEventListener('orientationchange', updateDevice);
    };
  }, []);

  useEffect(() => {
    writeDeviceDataset(document.documentElement, device);
  }, [device]);

  const effectiveMode = normalizeMode(mode);
  const effectiveScale = device.kind === 'phone' ? 1 : uiScale;

  const text = useAppStore(s => s.text);
  const setText = useAppStore(s => s.setText);
  const refText = useAppStore(s => s.refText);
  const setRefText = useAppStore(s => s.setRefText);
  const instruct = useAppStore(s => s.instruct);
  const setInstruct = useAppStore(s => s.setInstruct);
  const language = useAppStore(s => s.language);
  const setLanguage = useAppStore(s => s.setLanguage);
  const speed = useAppStore(s => s.speed);
  const setSpeed = useAppStore(s => s.setSpeed);
  const steps = useAppStore(s => s.steps);
  const setSteps = useAppStore(s => s.setSteps);
  const cfg = useAppStore(s => s.cfg);
  const setCfg = useAppStore(s => s.setCfg);
  const denoise = useAppStore(s => s.denoise);
  const setDenoise = useAppStore(s => s.setDenoise);
  const tShift = useAppStore(s => s.tShift);
  const setTShift = useAppStore(s => s.setTShift);
  const posTemp = useAppStore(s => s.posTemp);
  const setPosTemp = useAppStore(s => s.setPosTemp);
  const classTemp = useAppStore(s => s.classTemp);
  const setClassTemp = useAppStore(s => s.setClassTemp);
  const layerPenalty = useAppStore(s => s.layerPenalty);
  const setLayerPenalty = useAppStore(s => s.setLayerPenalty);
  const postprocess = useAppStore(s => s.postprocess);
  const setPostprocess = useAppStore(s => s.setPostprocess);
  const duration = useAppStore(s => s.duration);
  const setDuration = useAppStore(s => s.setDuration);
  const vdStates = useAppStore(s => s.vdStates);
  const setVdStates = useAppStore(s => s.setVdStates);
  const isSidebarCollapsed = useAppStore(s => s.isSidebarCollapsed);
  const setIsSidebarCollapsed = useAppStore(s => s.setIsSidebarCollapsed);

  const {
    profiles,
    history,
    studioProjects,
    exportHistory,
    showOverrides,
    setShowOverrides,
    sysStats,
    modelStatus,
    loadProfiles,
    loadHistory,
    loadExportHistory,
  } = useAppData();

  const {
    selectedProfile,
    setSelectedProfile,
    showSaveProfile,
    setShowSaveProfile,
    profileName,
    setProfileName,
    isSavingProfile,
    previewLoading,
    segmentPreviewLoading,
    handleSaveProfile: _handleSaveProfile,
    handleDeleteProfile,
    handleSelectProfile,
    handleRenameProfile,
    handleUploadProfilePhoto,
  } = useProfiles({ loadHistory, loadProfiles });

  const {
    refAudio,
    setRefAudio,
    pendingTrimFile,
    setPendingTrimFile,
    isGenerating,
    generationTime,
    synthesisProgress,
    lastPromptTranslation,
    textAreaRef,
    ingestRefAudio,
    insertTag,
    applyPreset,
    handleGenerate,
  } = useTTS({ selectedProfile, setSelectedProfile, loadHistory });

  const {
    isRecording,
    isCleaning,
    recordingTime,
    startRecording,
    stopRecording,
  } = useRecording(async (file) => {
    await ingestRefAudio(file);
    if (file) {
      setShowSaveProfile(true);
      setProfileName(prev => prev || `Voice ${new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}`);
    }
  });

  const handleIngestRefAudio = useCallback(async (file) => {
    await ingestRefAudio(file);
    if (file) {
      setShowSaveProfile(true);
      setProfileName(prev => prev || `Voice ${new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}`);
    }
  }, [ingestRefAudio, setShowSaveProfile, setProfileName]);

  const handleSaveProfile = useCallback(async () => {
    const saved = await _handleSaveProfile(refAudio, refText, instruct, language);
    if (saved) setRefAudio(null);
  }, [_handleSaveProfile, refAudio, refText, instruct, language, setRefAudio]);

  useEffect(() => {
    const handler = (event) => {
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const key = event.key.toLowerCase();

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        if (!isGenerating) handleGenerate();
        return;
      }

      if (event.altKey && ['1', '2', '3', '4'].includes(event.key)) {
        event.preventDefault();
        setMode(['conversation', 'clone', 'design', 'projects'][Number(event.key) - 1]);
        return;
      }

      if (event.altKey && event.key === '5') {
        event.preventDefault();
        setMode('settings');
        return;
      }

      if ((event.metaKey || event.ctrlKey) && ['r', 'p', '=', '-', '+'].includes(key)) {
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleGenerate, isGenerating, setMode]);

  useEffect(() => {
    const handleDrop = (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|ogg|aac|webm)$/i.test(file.name);
      if (!isAudio) return;
      setMode('clone');
      handleIngestRefAudio(file);
    };
    const handleDragOver = (event) => event.preventDefault();

    window.addEventListener('drop', handleDrop);
    window.addEventListener('dragover', handleDragOver);
    return () => {
      window.removeEventListener('drop', handleDrop);
      window.removeEventListener('dragover', handleDragOver);
    };
  }, [handleIngestRefAudio, setMode]);

  if (bootstrapStage !== 'ready') {
    return (
      <div className="vox-bootstrap-shell">
        <BootstrapSplash stage={bootstrapStage} message={bootstrapMessage} />
      </div>
    );
  }

  return (
    <div
      className={[
        'app-container',
        'vox-shell',
        `vox-mode-${effectiveMode}`,
        ...deviceClassNames(device),
      ].join(' ')}
      style={{ zoom: effectiveScale }}
    >
      {pendingTrimFile && (
        <ErrorBoundary name="audio-trimmer">
          <Suspense fallback={<LazyFallback />}>
            <AudioTrimmer
              file={pendingTrimFile}
              maxSeconds={CLONE_MAX_SECONDS}
              onCancel={() => setPendingTrimFile(null)}
              onConfirm={(trimmed) => {
                setPendingTrimFile(null);
                setRefAudio(trimmed);
                setSelectedProfile(null);
                toast.success('Trimmed audio loaded');
              }}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      <Toaster position={device.kind === 'phone' ? 'bottom-center' : 'top-center'} toastOptions={{
        style: {
          background: 'rgba(13, 18, 31, 0.92)',
          backdropFilter: 'blur(16px)',
          color: '#f5efe2',
          border: '1px solid rgba(245, 239, 226, 0.14)',
          borderRadius: 8,
          fontSize: '0.82rem',
          padding: '8px 12px',
        },
      }} />

      <FloatingPill />

      <Header
        mode={effectiveMode}
        setMode={setMode}
        sysStats={sysStats}
        modelStatus={modelStatus}
        doubleClickMaximize={doubleClickMaximize}
        device={device}
        onFlushMemory={async (unloadModel) => {
          try {
            const result = await apiFlushMemory(unloadModel);
            toast.success(`Flushed: RAM ${result.ram_after}G · VRAM ${result.vram_after}G${result.unloaded_model ? ' · model unloaded' : ''}`);
          } catch (error) {
            toast.error(`Flush failed: ${error.message}`);
          }
        }}
      />

      <NavRail mode={effectiveMode} setMode={setMode} device={device} />

      <main className="main-content vox-main">
        {effectiveMode === 'conversation' ? (
          <ErrorBoundary name="conversation">
            <Suspense fallback={<LazyFallback />}>
              <ConversationTab
                profiles={profiles}
                loadHistory={loadHistory}
              />
            </Suspense>
          </ErrorBoundary>
        ) : effectiveMode === 'settings' ? (
          <ErrorBoundary name="settings">
            <Suspense fallback={<LazyFallback />}>
              <Settings />
            </Suspense>
          </ErrorBoundary>
        ) : effectiveMode === 'projects' ? (
          <ErrorBoundary name="drive">
            <Suspense fallback={<LazyFallback />}>
              <Drive
                studioProjects={studioProjects}
                profiles={profiles}
                history={history}
                exportHistory={exportHistory}
                onOpenProfile={(id) => {
                  const profile = profiles.find(item => item.id === id);
                  if (profile) handleSelectProfile(profile);
                  setMode('clone');
                }}
                onRevealExport={(path) => { exportReveal({ path }).catch(() => {}); loadExportHistory(); }}
              />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <ErrorBoundary name="clone-design">
            <Suspense fallback={<LazyFallback />}>
              <CloneDesignTab
                mode={effectiveMode}
                textAreaRef={textAreaRef}
                text={text} setText={setText}
                language={language} setLanguage={setLanguage}
                steps={steps} setSteps={setSteps}
                cfg={cfg} setCfg={setCfg}
                speed={speed} setSpeed={setSpeed}
                tShift={tShift} setTShift={setTShift}
                posTemp={posTemp} setPosTemp={setPosTemp}
                classTemp={classTemp} setClassTemp={setClassTemp}
                layerPenalty={layerPenalty} setLayerPenalty={setLayerPenalty}
                duration={duration} setDuration={setDuration}
                denoise={denoise} setDenoise={setDenoise}
                postprocess={postprocess} setPostprocess={setPostprocess}
                showOverrides={showOverrides} setShowOverrides={setShowOverrides}
                isSidebarCollapsed={isSidebarCollapsed} setIsSidebarCollapsed={setIsSidebarCollapsed}
                profiles={profiles}
                selectedProfile={selectedProfile} setSelectedProfile={setSelectedProfile}
                refAudio={refAudio}
                refText={refText} setRefText={setRefText}
                instruct={instruct} setInstruct={setInstruct}
                profileName={profileName} setProfileName={setProfileName}
                showSaveProfile={showSaveProfile} setShowSaveProfile={setShowSaveProfile}
                isSavingProfile={isSavingProfile}
                isRecording={isRecording} isCleaning={isCleaning} recordingTime={recordingTime}
                vdStates={vdStates} setVdStates={setVdStates}
                isGenerating={isGenerating} generationTime={generationTime} synthesisProgress={synthesisProgress}
                lastPromptTranslation={lastPromptTranslation}
                applyPreset={applyPreset} insertTag={insertTag}
                handleSelectProfile={handleSelectProfile}
                handleDeleteProfile={handleDeleteProfile}
                handleRenameProfile={handleRenameProfile}
                handleUploadProfilePhoto={handleUploadProfilePhoto}
                handleSaveProfile={handleSaveProfile}
                handleGenerate={handleGenerate}
                startRecording={startRecording} stopRecording={stopRecording}
                ingestRefAudio={handleIngestRefAudio}
                previewLoading={previewLoading}
                segmentPreviewLoading={segmentPreviewLoading}
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>

      <Suspense fallback={null}>
        <LogsFooter />
      </Suspense>
    </div>
  );
}

export default App;
