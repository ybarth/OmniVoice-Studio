export const LS_CAPTURE_MODE = 'omni_capture_mode';
export const LS_CAPTURE_ASR_BACKEND = 'omni_capture_asr_backend';
export const DEFAULT_DICTATION_BACKEND = 'capture-auto';

export type DictationMode = 'fast' | 'accurate';

export type DictationSettings = {
  mode: DictationMode;
  backend: string;
};

export type ConversationDictationAction = 'start-recording' | 'stop-recording' | 'transcribe-audio';

export type ConversationDictationControlState = {
  disabled: boolean;
  label: string;
  action: ConversationDictationAction;
};

type StorageLike = {
  getItem: (key: string) => string | null;
};

export function readDictationSettings(storage: StorageLike | null = globalThis.localStorage): DictationSettings {
  const mode = storage?.getItem(LS_CAPTURE_MODE) === 'accurate' ? 'accurate' : 'fast';
  const backend = storage?.getItem(LS_CAPTURE_ASR_BACKEND) || DEFAULT_DICTATION_BACKEND;
  return { mode, backend };
}

export function writeDictationSettings(
  settings: Partial<DictationSettings>,
  storage: Storage | null = globalThis.localStorage,
): void {
  if (!storage) return;
  if (settings.mode) storage.setItem(LS_CAPTURE_MODE, settings.mode);
  if (settings.backend) storage.setItem(LS_CAPTURE_ASR_BACKEND, settings.backend);
}

export function buildDictationFormData(
  audio: Blob,
  {
    filename = 'dictation.webm',
    language = '',
    mode = 'fast',
    backend = DEFAULT_DICTATION_BACKEND,
  }: {
    filename?: string;
    language?: string;
    mode?: DictationMode;
    backend?: string;
  } = {},
): FormData {
  const formData = new FormData();
  formData.append('audio', audio, filename);
  formData.append('mode', mode);
  if (backend && backend !== DEFAULT_DICTATION_BACKEND) formData.append('backend', backend);
  if (language && language !== 'Auto') formData.append('language', language);
  return formData;
}

export function conversationDictationControlState({
  isWorking,
  isTurnRecording,
  isDictatingText,
  isTurnTranscribing,
  hasTurnAudio,
}: {
  isWorking: boolean;
  isTurnRecording: boolean;
  isDictatingText: boolean;
  isTurnTranscribing: boolean;
  hasTurnAudio: boolean;
}): ConversationDictationControlState {
  if (isTurnRecording && isDictatingText) {
    return {
      disabled: false,
      label: 'Stop Dictation',
      action: 'stop-recording',
    };
  }

  return {
    disabled: isWorking || isTurnRecording || isTurnTranscribing,
    label: 'Dictate Text',
    action: hasTurnAudio ? 'transcribe-audio' : 'start-recording',
  };
}

export function normalizeAudioLevels(bytes: Uint8Array, bins = 16): number[] {
  if (!bytes.length || bins <= 0) return Array.from({ length: Math.max(0, bins) }, () => 0);
  const levels: number[] = [];
  const bucketSize = Math.max(1, Math.ceil(bytes.length / bins));
  for (let i = 0; i < bins; i += 1) {
    const start = i * bucketSize;
    const end = Math.min(bytes.length, start + bucketSize);
    if (start >= bytes.length) {
      levels.push(0);
      continue;
    }
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += bytes[j];
    const average = sum / Math.max(1, end - start);
    levels.push(Math.round((average / 255) * 100) / 100);
  }
  return levels;
}
