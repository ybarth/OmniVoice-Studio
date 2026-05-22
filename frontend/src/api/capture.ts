import { apiFetch } from './client';

export async function transcribeAudio(formData: FormData): Promise<{
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  language: string;
  duration_s: number;
  transcription_time_s: number;
  engine: string;
}> {
  const res = await apiFetch('/transcribe', {
    method: 'POST',
    body: formData,
  });
  return res.json();
}
