import { test } from 'node:test';
import assert from 'node:assert/strict';

const utilsPath = new URL('../../frontend/src/utils/promptTranslation.ts', import.meta.url).pathname;
const {
  appendPromptTranslationVariant,
  appendPromptTranslationReceiptVariant,
  buildPromptTranslationReceipt,
  buildPromptTransformFrames,
  canTranslatePromptOnly,
  navigatePromptVariant,
  languageLabelToCode,
  promptAlreadyLooksLikeLanguage,
  restoreTranslatedPrompt,
  shouldTranslateBeforeSynthesis,
  translationReceiptMatchesPrompt,
  splitPromptForTranslation,
} = await import(utilsPath);

test('languageLabelToCode maps UI language labels to translation codes', () => {
  assert.equal(languageLabelToCode('Spanish'), 'es');
  assert.equal(languageLabelToCode('Chinese'), 'zh');
  assert.equal(languageLabelToCode('Cantonese'), 'yue');
  assert.equal(languageLabelToCode('Auto'), null);
});

test('promptAlreadyLooksLikeLanguage avoids obvious same-language English and Chinese', () => {
  assert.equal(promptAlreadyLooksLikeLanguage('Out of sight.', 'en'), true);
  assert.equal(promptAlreadyLooksLikeLanguage('你好，世界。', 'zh'), true);
  assert.equal(promptAlreadyLooksLikeLanguage('你好，世界。', 'yue'), false);
  assert.equal(promptAlreadyLooksLikeLanguage('我哋喺香港講嘢。', 'yue'), true);
  assert.equal(promptAlreadyLooksLikeLanguage('Hello world.', 'zh'), false);
  assert.equal(promptAlreadyLooksLikeLanguage('Richard of York goes battling in vain.', 'yue'), false);
});

test('splitPromptForTranslation preserves bracket speech tags', () => {
  const parts = splitPromptForTranslation('[laughter] Hello [sigh] world');
  const translations = Object.fromEntries(
    parts
      .filter(part => part.type === 'text')
      .map(part => [part.id, part.value.toUpperCase()]),
  );

  assert.equal(
    restoreTranslatedPrompt(parts, translations),
    '[laughter] HELLO [sigh] WORLD',
  );
});

test('restoreTranslatedPrompt keeps spacing around preserved tags', () => {
  const parts = splitPromptForTranslation('[laughter] Hello world');
  assert.equal(
    restoreTranslatedPrompt(parts, { p0: 'Hola Mundo' }),
    '[laughter] Hola Mundo',
  );
});

test('shouldTranslateBeforeSynthesis only translates for explicit clone action', () => {
  assert.equal(shouldTranslateBeforeSynthesis({ mode: 'clone' }), false);
  assert.equal(shouldTranslateBeforeSynthesis({ mode: 'clone', translateBeforeSynthesis: false }), false);
  assert.equal(shouldTranslateBeforeSynthesis({ mode: 'clone', translateBeforeSynthesis: true }), true);
  assert.equal(shouldTranslateBeforeSynthesis({ mode: 'design', translateBeforeSynthesis: true }), false);
});

test('canTranslatePromptOnly enables clone translation without synthesis', () => {
  assert.equal(canTranslatePromptOnly({ mode: 'clone', language: 'Cantonese', text: 'Hello world' }), true);
  assert.equal(canTranslatePromptOnly({ mode: 'clone', language: 'Auto', text: 'Hello world' }), false);
  assert.equal(canTranslatePromptOnly({ mode: 'clone', language: 'Abadi', text: 'Hello world' }), false);
  assert.equal(canTranslatePromptOnly({ mode: 'clone', language: 'Spanish', text: '' }), false);
  assert.equal(canTranslatePromptOnly({ mode: 'design', language: 'Spanish', text: 'Hello world' }), false);
  assert.equal(canTranslatePromptOnly({ mode: 'clone', language: 'Spanish', text: 'Hello world', busy: true }), false);
});

test('buildPromptTranslationReceipt stores only real current translations', () => {
  const receipt = buildPromptTranslationReceipt(
    'Hello world',
    'Cantonese',
    { text: '你好世界', translated: true, targetCode: 'yue' },
    123,
  );

  assert.deepEqual(receipt, {
    sourceText: 'Hello world',
    translatedText: '你好世界',
    language: 'Cantonese',
    targetCode: 'yue',
    createdAt: 123,
  });
  assert.equal(translationReceiptMatchesPrompt(receipt, 'Hello world', 'Cantonese'), true);
  assert.equal(translationReceiptMatchesPrompt(receipt, 'Different prompt', 'Cantonese'), false);
  assert.equal(translationReceiptMatchesPrompt(receipt, 'Hello world', 'Spanish'), false);
  assert.equal(
    buildPromptTranslationReceipt(
      'Hello world',
      'English',
      { text: 'Hello world', translated: false, targetCode: 'en' },
      123,
    ),
    null,
  );
});

test('buildPromptTransformFrames morphs from source into target', () => {
  const frames = buildPromptTransformFrames('Hello world', '你好世界', 5);

  assert.equal(frames.length, 5);
  assert.equal(frames.at(-1), '你好世界');
  assert.notEqual(frames[0], 'Hello world');
  assert.ok(frames.some(frame => frame.includes('你')));
});

test('appendPromptTranslationVariant builds and branches prompt history', () => {
  const first = appendPromptTranslationVariant([], -1, 'Hello world', 'Spanish', {
    text: 'Hola mundo',
    translated: true,
    targetCode: 'es',
  }, 100);

  assert.equal(first.activeIndex, 1);
  assert.deepEqual(first.history.map(item => item.text), ['Hello world', 'Hola mundo']);
  assert.deepEqual(first.history.map(item => item.language), ['Original', 'Spanish']);

  const second = appendPromptTranslationVariant(first.history, first.activeIndex, 'Hola mundo', 'Cantonese', {
    text: '你好世界',
    translated: true,
    targetCode: 'yue',
  }, 200);

  assert.equal(second.activeIndex, 2);
  assert.deepEqual(second.history.map(item => item.text), ['Hello world', 'Hola mundo', '你好世界']);

  const branch = appendPromptTranslationVariant(second.history, 0, 'Hello world', 'French', {
    text: 'Bonjour le monde',
    translated: true,
    targetCode: 'fr',
  }, 300);

  assert.equal(branch.activeIndex, 1);
  assert.deepEqual(branch.history.map(item => item.text), ['Hello world', 'Bonjour le monde']);
});

test('appendPromptTranslationReceiptVariant applies translate-and-synthesize receipt to history', () => {
  const receipt = {
    sourceText: 'Out of sight',
    translatedText: '眼不见為淨',
    language: 'Cantonese',
    targetCode: 'yue',
    createdAt: 500,
  };

  const next = appendPromptTranslationReceiptVariant([], -1, receipt);

  assert.equal(next.activeIndex, 1);
  assert.deepEqual(next.history.map(item => item.text), ['Out of sight', '眼不见為淨']);
  assert.deepEqual(next.history.map(item => item.language), ['Original', 'Cantonese']);
  assert.equal(next.history[1].targetCode, 'yue');
});

test('navigatePromptVariant clamps to available history entries', () => {
  const history = [
    { text: 'Hello world', language: 'Original', targetCode: null, createdAt: 100, kind: 'source' },
    { text: 'Hola mundo', language: 'Spanish', targetCode: 'es', createdAt: 200, kind: 'translation' },
  ];

  assert.equal(navigatePromptVariant(history, 1, -1), 0);
  assert.equal(navigatePromptVariant(history, 0, -1), 0);
  assert.equal(navigatePromptVariant(history, 0, 1), 1);
  assert.equal(navigatePromptVariant(history, 1, 1), 1);
  assert.equal(navigatePromptVariant([], -1, 1), -1);
});
