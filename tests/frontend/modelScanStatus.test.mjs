import { test } from 'node:test';
import assert from 'node:assert/strict';

const utilsPath = new URL('../../frontend/src/utils/modelScanStatus.ts', import.meta.url).href;
const { selectModelScanView } = await import(utilsPath);

test('selectModelScanView prefers completed model response over stale live scan', () => {
  const complete = { status: 'complete', progress_pct: 100, detail: 'Scan complete' };
  const staleLive = { status: 'scanning', progress_pct: 8, detail: 'Scanning cache' };

  assert.equal(
    selectModelScanView({ dataScan: complete, liveScan: staleLive, isFetching: false }),
    complete,
  );
});

test('selectModelScanView keeps live scan while model query is fetching', () => {
  const complete = { status: 'complete', progress_pct: 100, detail: 'Scan complete' };
  const live = { status: 'scanning', progress_pct: 42, detail: 'Checking models' };

  assert.equal(
    selectModelScanView({ dataScan: complete, liveScan: live, isFetching: true }),
    live,
  );
});
