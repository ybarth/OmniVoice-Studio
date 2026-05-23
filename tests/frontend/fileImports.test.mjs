import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tauriConfigPath = path.join(repoRoot, 'frontend/src-tauri/tauri.conf.json');
const fileImportsModule = new URL('../../frontend/src/utils/fileImports.js', import.meta.url).pathname;
const { getGlobalDubDropFile } = await import(fileImportsModule);

function fileInputBlocks(source) {
  return source
    .match(/<input\b[\s\S]*?\/>/g)
    ?.filter((block) => /\btype=(?:"file"|'file')/.test(block)) ?? [];
}

test('Tauri main window lets HTML5 file import drop zones receive dropped files', () => {
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'));
  const mainWindow = tauriConfig.app.windows.find((window) => window.label !== 'widget');

  assert.equal(mainWindow.dragDropEnabled, false);
});

test('global dub drop ignores files already claimed by a local import control', () => {
  const file = { name: 'voice.wav', type: 'audio/wav' };
  const event = {
    defaultPrevented: true,
    dataTransfer: { files: [file] },
  };

  assert.equal(getGlobalDubDropFile(event), null);
});

test('global dub drop accepts top-level audio and video files', () => {
  const wav = { name: 'voice.wav', type: '' };
  const mov = { name: 'clip.mov', type: '' };

  assert.equal(getGlobalDubDropFile({ dataTransfer: { files: [wav] } }), wav);
  assert.equal(getGlobalDubDropFile({ dataTransfer: { files: [mov] } }), mov);
});

test('global dub drop ignores non-media imports', () => {
  const srt = { name: 'captions.srt', type: 'text/plain' };
  const png = { name: 'portrait.png', type: 'image/png' };

  assert.equal(getGlobalDubDropFile({ dataTransfer: { files: [srt] } }), null);
  assert.equal(getGlobalDubDropFile({ dataTransfer: { files: [png] } }), null);
});

test('clickable file import controls keep native file inputs picker-eligible', () => {
  const jsxPaths = [
    'frontend/src/pages/DubTab.jsx',
    'frontend/src/pages/CloneDesignTab.jsx',
    'frontend/src/pages/ConversationTab.jsx',
    'frontend/src/components/BatchAddDialog.jsx',
  ];

  for (const relPath of jsxPaths) {
    const source = readFileSync(path.join(repoRoot, relPath), 'utf8');
    for (const block of fileInputBlocks(source)) {
      assert.doesNotMatch(block, /\s+hidden(?:\s|>|=)/, `${relPath} hides a file input with the hidden attribute`);
    }
  }

  const dubCss = readFileSync(path.join(repoRoot, 'frontend/src/pages/DubTab.css'), 'utf8');
  const batchCss = readFileSync(path.join(repoRoot, 'frontend/src/components/BatchAddDialog.css'), 'utf8');

  assert.doesNotMatch(dubCss, /\.dub-hidden-file\s*\{[^}]*display\s*:\s*none/i);
  assert.doesNotMatch(batchCss, /\.batch-add__file-input\s*\{[^}]*display\s*:\s*none/i);
});
