import { apiPost } from './client';
import {
  languageLabelToCode,
  promptAlreadyLooksLikeLanguage,
  restoreTranslatedPrompt,
  splitPromptForTranslation,
} from '../utils/promptTranslation';

type TranslateResponse = {
  translated?: Array<{ id: string; text: string; error?: string }>;
  target_lang?: string;
  source_lang?: string;
};

export type TranslatePromptSkipReason =
  | 'unsupported-language'
  | 'already-target-language'
  | 'no-translatable-text'
  | 'unchanged-output';

export type TranslatePromptResult = {
  text: string;
  translated: boolean;
  targetCode: string | null;
  skippedReason?: TranslatePromptSkipReason;
};

export async function translatePromptForSynthesis(
  text: string,
  language: string,
  provider = 'google',
  {
    sourceLanguage = 'auto',
    quality = 'fast',
  }: {
    sourceLanguage?: string;
    quality?: 'fast' | 'cinematic' | string;
  } = {},
): Promise<TranslatePromptResult> {
  const targetCode = languageLabelToCode(language);
  if (!targetCode) {
    return { text, translated: false, targetCode, skippedReason: 'unsupported-language' };
  }
  if (promptAlreadyLooksLikeLanguage(text, targetCode)) {
    return { text, translated: false, targetCode, skippedReason: 'already-target-language' };
  }

  const parts = splitPromptForTranslation(text);
  const segments = parts
    .filter(part => part.type === 'text' && part.value.trim())
    .map(part => ({ id: part.id || '', text: part.value }));

  if (segments.length === 0) {
    return { text, translated: false, targetCode, skippedReason: 'no-translatable-text' };
  }

  const sourceCode = sourceLanguage === 'auto' ? null : languageLabelToCode(sourceLanguage);
  const result = await apiPost<TranslateResponse>('/dub/translate', {
    segments,
    target_lang: targetCode,
    source_lang: sourceCode || 'auto',
    provider,
    quality,
  });

  const failed = result.translated?.find(row => row.error);
  if (failed) {
    throw new Error(failed.error || 'Prompt translation failed');
  }

  const translations = Object.fromEntries(
    (result.translated || []).map(row => [row.id, row.text]),
  );
  const translatedText = restoreTranslatedPrompt(parts, translations);
  const translated = translatedText.trim() !== text.trim();
  return {
    text: translatedText,
    translated,
    targetCode,
    skippedReason: translated ? undefined : 'unchanged-output',
  };
}
