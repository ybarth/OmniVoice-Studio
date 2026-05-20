import { test } from 'node:test';
import assert from 'node:assert/strict';

const utilsPath = new URL('../../frontend/src/utils/credentialStatus.ts', import.meta.url).pathname;
const { credentialBadgeLabel, credentialConfigured } = await import(utilsPath);

test('credentialConfigured merges backend status with just-saved local state', () => {
  const statuses = [
    { key: 'TRANSLATE_API_KEY', configured: false },
    { key: 'DEEPL_API_KEY', configured: true },
  ];

  assert.equal(credentialConfigured(statuses, {}, 'TRANSLATE_API_KEY'), false);
  assert.equal(credentialConfigured(statuses, {}, 'DEEPL_API_KEY'), true);
  assert.equal(credentialConfigured(statuses, { TRANSLATE_API_KEY: true }, 'TRANSLATE_API_KEY'), true);
});

test('credentialBadgeLabel stays non-secret', () => {
  assert.equal(credentialBadgeLabel(true), 'Set');
  assert.equal(credentialBadgeLabel(false), 'Not set');
});
