import { apiFetch } from './client';

export async function exportConversationBundle(body: Record<string, unknown>): Promise<Response> {
  return apiFetch('/conversation/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
