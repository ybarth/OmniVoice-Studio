const viteEnv = import.meta.env ?? {};

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname.endsWith('.localhost');
}

function defaultApiRoot(): string {
  if (viteEnv.VITE_API_URL) return viteEnv.VITE_API_URL;
  if (typeof window !== 'undefined') {
    const { hostname, origin, protocol } = window.location;
    if (protocol.startsWith('http') && !isLoopbackHost(hostname)) return `${origin}/api`;
  }
  return `http://127.0.0.1:${viteEnv.VITE_API_PORT || '3900'}`;
}

const apiRoot = defaultApiRoot();

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
