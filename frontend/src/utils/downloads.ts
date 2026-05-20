const viteEnv = import.meta.env ?? {};
const apiRoot = viteEnv.VITE_API_URL || `http://127.0.0.1:${viteEnv.VITE_API_PORT || '3900'}`;

export function basename(value: unknown): string {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

export function safeDownloadName(sourceIdentifier: unknown, fallbackName: unknown): string {
  return basename(sourceIdentifier) || basename(fallbackName) || 'download.wav';
}

export function historyAudioDownloadUrl(sourceIdentifier: unknown): string {
  const name = safeDownloadName(sourceIdentifier, 'download.wav');
  return `${apiRoot}/audio/${encodeURIComponent(name)}`;
}
