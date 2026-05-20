import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const setupPath = new URL('../../frontend/src/api/setup.ts', import.meta.url).pathname;
const clientUrl = new URL('../../frontend/src/api/client.ts', import.meta.url).href;
const tmpDir = mkdtempSync(path.join(tmpdir(), 'omnivoice-setup-api-'));
const tmpSetup = path.join(tmpDir, 'setup.ts');
writeFileSync(
  tmpSetup,
  readFileSync(setupPath, 'utf8').replace("from './client';", `from '${clientUrl}';`),
);
const { modelScanStatus } = await import(pathToFileURL(tmpSetup).href);

test('modelScanStatus reads the scan status endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = mock.fn(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      status: 'scanning',
      progress_pct: 42,
      detail: 'Checking models',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  try {
    const status = await modelScanStatus();
    assert.equal(status.status, 'scanning');
    assert.equal(status.progress_pct, 42);
    assert.equal(status.detail, 'Checking models');
    assert.match(String(calls[0].url), /\/models\/scan-status$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
