import { apiPost } from './client';

export interface ExtractedDocument {
  filename: string;
  kind: string;
  text: string;
  char_count: number;
}

export async function extractDocumentText(formData: FormData): Promise<ExtractedDocument> {
  return apiPost<ExtractedDocument>('/documents/extract', formData);
}
