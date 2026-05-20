type RuntimeStatusLike = {
  status?: string | null;
  phase?: string | null;
  detail?: string | null;
  progress_pct?: number | null;
  error?: string | null;
};

type TranslationEngineLike = {
  display_name?: string | null;
  runtime_detail?: string | null;
  runtime_progress_pct?: number | null;
};

type ClientPhase =
  | 'idle'
  | 'preparing'
  | 'translating'
  | 'requesting'
  | 'receiving'
  | 'finalizing'
  | 'done'
  | 'error';

type ProgressInput = {
  clientPhase?: ClientPhase | string | null;
  backendStatus?: RuntimeStatusLike | null;
  translationEngine?: TranslationEngineLike | null;
  streamProgressPct?: number | null;
  elapsedSeconds?: number | null;
};

export type SynthesisProgressView = {
  label: string;
  detail: string;
  progress: number | null;
  elapsedLabel: string;
  phase: string;
};

const PHASE_LABELS: Record<string, { label: string; detail: string; progress: number | null }> = {
  idle: { label: 'Ready', detail: '', progress: null },
  preparing: { label: 'Preparing synthesis', detail: 'Checking prompt and voice source', progress: 5 },
  validating: { label: 'Checking request', detail: 'Validating prompt and voice source', progress: 8 },
  loading_model: { label: 'Loading TTS model', detail: 'Preparing the voice model', progress: 24 },
  inferencing: { label: 'Synthesizing audio', detail: 'Synthesizing audio with the TTS model', progress: null },
  mastering: { label: 'Mastering audio', detail: 'Applying output processing', progress: 76 },
  saving: { label: 'Saving audio', detail: 'Writing generated audio to history', progress: 84 },
  recording_history: { label: 'Saving history', detail: 'Updating generated-audio history', progress: 88 },
  encoding: { label: 'Encoding WAV', detail: 'Encoding the audio response', progress: 92 },
  streaming: { label: 'Receiving audio', detail: 'Receiving generated WAV', progress: 96 },
  receiving: { label: 'Receiving audio', detail: 'Receiving generated WAV', progress: null },
  finalizing: { label: 'Finalizing audio', detail: 'Preparing playback and history', progress: 99 },
  done: { label: 'Audio ready', detail: 'Audio generated', progress: 100 },
  error: { label: 'Synthesis failed', detail: 'The synthesis request failed', progress: null },
  requesting: { label: 'Starting synthesis', detail: 'Sending request to the TTS backend', progress: 18 },
};

function clampPercent(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function elapsedLabel(seconds: number | null | undefined): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '0.0s';
  return `${value.toFixed(1)}s`;
}

export function selectSynthesisProgressView({
  clientPhase = null,
  backendStatus = null,
  translationEngine = null,
  streamProgressPct = null,
  elapsedSeconds = null,
}: ProgressInput): SynthesisProgressView {
  if (clientPhase === 'translating') {
    return {
      label: 'Translating prompt',
      detail: translationEngine?.runtime_detail
        || `Using ${translationEngine?.display_name || 'selected translation engine'}`,
      progress: clampPercent(translationEngine?.runtime_progress_pct),
      elapsedLabel: elapsedLabel(elapsedSeconds),
      phase: 'translating',
    };
  }

  const backendPhase = backendStatus?.phase && backendStatus.phase !== 'idle'
    ? backendStatus.phase
    : null;
  const clientPhaseOverride = clientPhase && ['receiving', 'finalizing', 'done', 'error'].includes(String(clientPhase))
    ? clientPhase
    : null;
  const rawPhase = clientPhaseOverride || backendPhase || clientPhase || backendStatus?.status || 'preparing';
  const phase = String(rawPhase || 'preparing');
  const preset = PHASE_LABELS[phase] || PHASE_LABELS.preparing;
  let progress = clientPhaseOverride ? null : clampPercent(backendStatus?.progress_pct);

  if (progress == null) {
    progress = preset.progress;
  }

  if ((phase === 'streaming' || clientPhase === 'receiving') && streamProgressPct != null) {
    progress = 90 + Math.round(Math.max(0, Math.min(100, streamProgressPct)) / 10);
  }

  return {
    label: preset.label,
    detail: backendStatus?.error || backendStatus?.detail || preset.detail,
    progress,
    elapsedLabel: elapsedLabel(elapsedSeconds),
    phase,
  };
}
