import { test } from 'node:test';
import assert from 'node:assert/strict';

const utilsPath = new URL('../../frontend/src/utils/translationEngineStatus.ts', import.meta.url).href;
const {
  translationEngineOptionLabel,
  translationEngineStatusTone,
  translationRuntimeLabel,
} = await import(utilsPath);

test('translationEngineOptionLabel distinguishes package and model installs', () => {
  assert.equal(
    translationEngineOptionLabel({
      display_name: 'OpenAI (API)',
      installed: false,
      pip_package: 'openai',
    }),
    'OpenAI (API) — needs package install',
  );

  assert.equal(
    translationEngineOptionLabel({
      display_name: 'HY-MT1.5 1.8B',
      installed: false,
      pip_package: null,
      model_repo_id: 'tencent/HY-MT1.5-1.8B',
      model_installed: false,
    }),
    'HY-MT1.5 1.8B — needs model install',
  );
});

test('translation runtime labels surface running and loading state', () => {
  assert.equal(translationRuntimeLabel({ runtime_status: 'loading' }), 'loading');
  assert.equal(translationRuntimeLabel({ runtime_status: 'generating' }), 'running');
  assert.equal(translationRuntimeLabel({ runtime_status: 'idle' }), 'idle');
  assert.equal(translationEngineStatusTone({ installed: true, runtime_status: 'generating' }), 'info');
  assert.equal(translationEngineStatusTone({ installed: false }), 'warn');
});
