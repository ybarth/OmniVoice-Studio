import { LANG_CODES } from './languages.js';

type PromptPart = {
  id?: string;
  type: 'text' | 'tag';
  value: string;
};

type SynthesisTranslationOptions = {
  mode: string;
  translateBeforeSynthesis?: boolean;
};

type PromptTranslateOnlyOptions = {
  mode: string;
  language: string;
  text: string;
  busy?: boolean;
};

type PromptTranslationResult = {
  text: string;
  translated: boolean;
  targetCode: string | null;
  skippedReason?: string;
};

export type PromptTranslationReceipt = {
  sourceText: string;
  translatedText: string;
  language: string;
  targetCode: string | null;
  createdAt: number;
};

export type PromptVariant = {
  text: string;
  language: string;
  targetCode: string | null;
  createdAt: number;
  kind: 'source' | 'translation';
};

const TAG_RE = /\[[^\]\r\n]{1,80}\]/g;
const ENGLISH_WORDS = new Set([
  'a', 'am', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do',
  'for', 'from', 'go', 'goes', 'had', 'has', 'have', 'he', 'her', 'his', 'i',
  'if', 'in', 'is', 'it', 'me', 'my', 'not', 'of', 'on', 'or', 'our', 'she',
  'that', 'the', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'with',
  'you', 'your',
]);

const EXTRA_LANGUAGE_CODES: Record<string, string> = {
  cantonese: 'yue',
  'cantonese chinese': 'yue',
  'hong kong cantonese': 'yue',
  chinese: 'zh',
  'chinese (simplified)': 'zh',
  'chinese (traditional)': 'zh',
  haitian: 'ht',
  panjabi: 'pa',
  pushto: 'ps',
  standardarabic: 'ar',
  'standard arabic': 'ar',
};

const TRANSFORM_CHARS = ['~', '/', '|', '\\', '-'];
const SCRIPT_RANGES: Record<string, Array<[number, number]>> = {
  ar: [[0x0600, 0x06ff]],
  hi: [[0x0900, 0x097f]],
  ja: [[0x3040, 0x30ff], [0x4e00, 0x9fff]],
  ko: [[0xac00, 0xd7af]],
  ru: [[0x0400, 0x04ff]],
  th: [[0x0e00, 0x0e7f]],
  uk: [[0x0400, 0x04ff]],
  yue: [[0x4e00, 0x9fff]],
  zh: [[0x4e00, 0x9fff]],
};
const CANTONESE_MARKERS = [
  '嘅', '咗', '喺', '係', '唔', '佢', '哋', '冇', '啲', '咁',
  '呢', '啦', '喎', '呀', '㗎', '咩', '吖', '嚟', '畀', '俾',
  '睇', '嗰', '晒', '啱', '攞', '搵', '返', '嘢', '噉', '講',
];

function normalizeLanguageLabel(label: string): string {
  return label.trim().toLowerCase();
}

export function languageLabelToCode(language: string): string | null {
  const normalized = normalizeLanguageLabel(language);
  if (!normalized || normalized === 'auto') return null;

  const direct = LANG_CODES.find(entry => normalizeLanguageLabel(entry.label) === normalized);
  if (direct?.code) return direct.code.split('-')[0];

  return EXTRA_LANGUAGE_CODES[normalized] || null;
}

function scriptRatio(text: string, ranges: Array<[number, number]>): number {
  const letters = [...text].filter(ch => /\p{L}/u.test(ch));
  if (letters.length === 0) return 0;
  const matches = letters.filter(ch => {
    const code = ch.codePointAt(0) || 0;
    return ranges.some(([lo, hi]) => lo <= code && code <= hi);
  });
  return matches.length / letters.length;
}

function looksEnglish(text: string): boolean {
  const letters = text.match(/[A-Za-z]+/g) || [];
  if (letters.length === 0) return false;
  const asciiLetters = letters.join('').length;
  const allLetters = [...text].filter(ch => /\p{L}/u.test(ch)).length || asciiLetters;
  if (asciiLetters / allLetters < 0.95) return false;
  const hits = letters.filter(word => ENGLISH_WORDS.has(word.toLowerCase())).length;
  return hits >= 1 || (letters.length <= 3 && /^[A-Za-z\s.,!?'"-]+$/.test(text));
}

function looksSpokenCantonese(text: string): boolean {
  const ranges = SCRIPT_RANGES.yue;
  if (!ranges || scriptRatio(text, ranges) < 0.5) return false;
  return CANTONESE_MARKERS.some(marker => text.includes(marker));
}

export function promptAlreadyLooksLikeLanguage(text: string, targetCode: string): boolean {
  const baseCode = targetCode.split('-')[0];
  if (baseCode === 'yue') return looksSpokenCantonese(text);
  const ranges = SCRIPT_RANGES[baseCode];
  if (ranges) return scriptRatio(text, ranges) >= 0.5;
  if (baseCode === 'en') return looksEnglish(text);
  return false;
}

export function shouldTranslateBeforeSynthesis({
  mode,
  translateBeforeSynthesis = false,
}: SynthesisTranslationOptions): boolean {
  return mode === 'clone' && translateBeforeSynthesis === true;
}

export function canTranslatePromptOnly({
  mode,
  language,
  text,
  busy = false,
}: PromptTranslateOnlyOptions): boolean {
  return (
    mode === 'clone'
    && language !== 'Auto'
    && languageLabelToCode(language) !== null
    && Boolean(text.trim())
    && !busy
  );
}

export function buildPromptTranslationReceipt(
  sourceText: string,
  language: string,
  result: PromptTranslationResult,
  createdAt = Date.now(),
): PromptTranslationReceipt | null {
  if (!result.translated || result.text.trim() === sourceText.trim()) return null;
  return {
    sourceText,
    translatedText: result.text,
    language,
    targetCode: result.targetCode,
    createdAt,
  };
}

export function translationReceiptMatchesPrompt(
  receipt: PromptTranslationReceipt | null | undefined,
  text: string,
  language: string,
): boolean {
  return Boolean(receipt && receipt.sourceText === text && receipt.language === language);
}

export function buildPromptTransformFrames(
  sourceText: string,
  targetText: string,
  frameCount = 12,
): string[] {
  const count = Math.max(2, Math.floor(frameCount));
  const sourceChars = Array.from(sourceText);
  const targetChars = Array.from(targetText);
  const maxLength = Math.max(sourceChars.length, targetChars.length);
  const frames: string[] = [];

  for (let frame = 1; frame <= count; frame += 1) {
    if (frame === count) {
      frames.push(targetText);
      continue;
    }

    const progress = frame / count;
    const revealCount = Math.floor(targetChars.length * progress);
    const sourceStart = Math.min(sourceChars.length, Math.ceil(sourceChars.length * progress));
    const suffix = sourceChars.slice(sourceStart).join('');
    const noiseLength = Math.max(0, Math.min(4, maxLength - revealCount - suffix.length));
    const noise = Array.from(
      { length: noiseLength },
      (_, index) => TRANSFORM_CHARS[(frame + index) % TRANSFORM_CHARS.length],
    ).join('');
    frames.push(`${targetChars.slice(0, revealCount).join('')}${noise}${suffix}`.trimEnd());
  }

  return frames;
}

export function appendPromptTranslationVariant(
  history: PromptVariant[],
  activeIndex: number,
  sourceText: string,
  language: string,
  result: PromptTranslationResult,
  createdAt = Date.now(),
): { history: PromptVariant[]; activeIndex: number } {
  if (!result.translated || result.text.trim() === sourceText.trim()) {
    return { history, activeIndex };
  }

  const sourceVariant: PromptVariant = {
    text: sourceText,
    language: 'Original',
    targetCode: null,
    createdAt,
    kind: 'source',
  };
  const translatedVariant: PromptVariant = {
    text: result.text,
    language,
    targetCode: result.targetCode,
    createdAt,
    kind: 'translation',
  };
  const activeMatchesSource = history[activeIndex]?.text === sourceText;
  const matchingIndex = history.findIndex(item => item.text === sourceText);

  let nextHistory: PromptVariant[];
  if (activeMatchesSource) {
    nextHistory = history.slice(0, activeIndex + 1);
  } else if (matchingIndex >= 0) {
    nextHistory = history.slice(0, matchingIndex + 1);
  } else {
    nextHistory = [sourceVariant];
  }

  nextHistory.push(translatedVariant);
  return { history: nextHistory, activeIndex: nextHistory.length - 1 };
}

export function appendPromptTranslationReceiptVariant(
  history: PromptVariant[],
  activeIndex: number,
  receipt: PromptTranslationReceipt | null | undefined,
): { history: PromptVariant[]; activeIndex: number } {
  if (!receipt) return { history, activeIndex };
  return appendPromptTranslationVariant(
    history,
    activeIndex,
    receipt.sourceText,
    receipt.language,
    {
      text: receipt.translatedText,
      translated: true,
      targetCode: receipt.targetCode,
    },
    receipt.createdAt,
  );
}

export function navigatePromptVariant(
  history: PromptVariant[],
  activeIndex: number,
  delta: number,
): number {
  if (!history.length) return -1;
  const safeActive = activeIndex < 0 ? 0 : activeIndex;
  return Math.max(0, Math.min(history.length - 1, safeActive + delta));
}

export function splitPromptForTranslation(text: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let lastIndex = 0;
  let textIndex = 0;

  for (const match of text.matchAll(TAG_RE)) {
    const index = match.index || 0;
    if (index > lastIndex) {
      parts.push({ id: `p${textIndex++}`, type: 'text', value: text.slice(lastIndex, index) });
    }
    parts.push({ type: 'tag', value: match[0] });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ id: `p${textIndex++}`, type: 'text', value: text.slice(lastIndex) });
  }

  return parts.length ? parts : [{ id: 'p0', type: 'text', value: text }];
}

export function restoreTranslatedPrompt(parts: PromptPart[], translations: Record<string, string>): string {
  return parts.map(part => {
    if (part.type === 'tag') return part.value;
    const translated = translations[part.id || ''];
    if (translated == null) return part.value;
    const leading = part.value.match(/^\s*/)?.[0] || '';
    const trailing = part.value.match(/\s*$/)?.[0] || '';
    return `${leading}${translated.trim()}${trailing}`;
  }).join('');
}
