import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const translatePath = new URL('../../frontend/src/api/translate.ts', import.meta.url).pathname;
const clientUrl = new URL('../../frontend/src/api/client.ts', import.meta.url).href;
const promptUtilsUrl = new URL('../../frontend/src/utils/promptTranslation.ts', import.meta.url).href;
const translateSrc = await readFile(translatePath, 'utf8');
const translateShimPath = join(tmpdir(), `omnivoice-translate-api-${process.pid}.ts`);
await writeFile(
  translateShimPath,
  translateSrc
    .replace("from './client';", `from '${clientUrl}';`)
    .replace("from '../utils/promptTranslation';", `from '${promptUtilsUrl}';`),
  'utf8',
);
const { translatePromptForSynthesis } = await import(pathToFileURL(translateShimPath).href);

test('translatePromptForSynthesis sends selected provider and Cantonese yue target', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = mock.fn(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      translated: [{ id: 'p0', text: '睇唔到' }],
      target_lang: 'yue',
      source_lang: 'en',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  try {
    const result = await translatePromptForSynthesis('Out of sight', 'Cantonese', 'hymt-1.8b');

    assert.equal(result.text, '睇唔到');
    assert.equal(result.translated, true);
    assert.equal(result.targetCode, 'yue');
    assert.equal(requestBody.provider, 'hymt-1.8b');
    assert.equal(requestBody.target_lang, 'yue');
    assert.equal(requestBody.quality, 'fast');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translatePromptForSynthesis sends English prompt to high-quality Cantonese engine', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = mock.fn(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      translated: [{ id: 'p0', text: '理查德約克徒勞咁出戰' }],
      target_lang: 'yue',
      source_lang: 'en',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  try {
    const result = await translatePromptForSynthesis(
      'Richard of York goes battling in vain',
      'Cantonese',
      'hymt-7b',
    );

    assert.equal(result.translated, true);
    assert.equal(result.skippedReason, undefined);
    assert.equal(requestBody.provider, 'hymt-7b');
    assert.equal(requestBody.target_lang, 'yue');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translatePromptForSynthesis realizes written Chinese when target is Cantonese', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = mock.fn(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      translated: [{ id: 'p0', text: '畀杯水我。', cantonese_realized: true }],
      target_lang: 'yue',
      source_lang: 'auto',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  try {
    const result = await translatePromptForSynthesis(
      '給我一杯水。',
      'Cantonese',
      'google',
    );

    assert.equal(result.text, '畀杯水我。');
    assert.equal(result.translated, true);
    assert.equal(requestBody.target_lang, 'yue');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translatePromptForSynthesis reports unsupported target languages without claiming same language', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => {
    throw new Error('fetch should not be called');
  });

  try {
    const result = await translatePromptForSynthesis('Hello world', 'Abadi', 'hymt-7b');

    assert.equal(result.translated, false);
    assert.equal(result.targetCode, null);
    assert.equal(result.skippedReason, 'unsupported-language');
    assert.equal(globalThis.fetch.mock.calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translatePromptForSynthesis reports bracket-only prompts as having no translatable text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => {
    throw new Error('fetch should not be called');
  });

  try {
    const result = await translatePromptForSynthesis('[laughter] [sigh]', 'Cantonese', 'hymt-7b');

    assert.equal(result.translated, false);
    assert.equal(result.targetCode, 'yue');
    assert.equal(result.skippedReason, 'no-translatable-text');
    assert.equal(globalThis.fetch.mock.calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translatePromptForSynthesis reports unchanged provider output without claiming same language', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = mock.fn(async () => new Response(JSON.stringify({
    translated: [{ id: 'p0', text: 'Richard of York goes battling in vain' }],
    target_lang: 'yue',
    source_lang: 'en',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  try {
    const result = await translatePromptForSynthesis(
      'Richard of York goes battling in vain',
      'Cantonese',
      'hymt-7b',
    );

    assert.equal(result.translated, false);
    assert.equal(result.targetCode, 'yue');
    assert.equal(result.skippedReason, 'unchanged-output');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
