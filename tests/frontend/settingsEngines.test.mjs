import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Settings Engines exposes voice catalog preparation controls', () => {
  const settings = readFileSync(path.join(repoRoot, 'frontend/src/pages/Settings.jsx'), 'utf8');
  const styles = readFileSync(path.join(repoRoot, 'frontend/src/pages/Settings.css'), 'utf8');
  const api = readFileSync(path.join(repoRoot, 'frontend/src/api/engines.ts'), 'utf8');

  assert.match(settings, /Voice Catalog/);
  assert.match(settings, /Download \/ Verify/);
  assert.match(settings, /prepareTtsVoice/);
  assert.match(settings, /prepare_status/);
  assert.match(styles, /\.settings-voice-catalog/);
  assert.match(api, /prepareTtsVoice/);
  assert.match(api, /\/engines\/tts\/\$\{encodeURIComponent\(engineId\)\}\/voices\/\$\{encodeURIComponent\(voiceId\)\}\/prepare/);
});
