import { API, apiUrl, apiFetch, apiJson } from './client';

export type GenerationStatus = {
  request_id: string;
  status: string;
  phase: string;
  detail?: string | null;
  progress_pct?: number | null;
  error?: string | null;
  started_at?: number | null;
  updated_at?: number | null;
};

export async function generateSpeech(
  formData: FormData,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Response> {
  // Returns the full Response so callers can stream the WAV blob + read headers.
  return apiFetch('/generate', { method: 'POST', body: formData, signal });
}

export async function generationStatus(requestId: string): Promise<GenerationStatus> {
  return apiJson<GenerationStatus>(`/generate/status/${encodeURIComponent(requestId)}`);
}

export async function listHistory(): Promise<unknown> {
  return apiJson('/history');
}

export async function clearHistory(): Promise<Response> {
  return apiFetch('/history', { method: 'DELETE' });
}

export function audioUrl(filename: string): string {
  return `${API}/audio/${filename}`;
}

export function audioUrlWithCacheBust(filename: string): string {
  return `${apiUrl('/audio/' + filename)}?t=${Date.now()}`;
}
