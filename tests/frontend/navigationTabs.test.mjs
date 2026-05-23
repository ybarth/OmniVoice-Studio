import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Drive and Document Library are separate main nav tabs', () => {
  const navRail = readFileSync(path.join(repoRoot, 'frontend/src/components/NavRail.jsx'), 'utf8');

  assert.match(navRail, /\{\s*id:\s*'projects'[\s\S]*label:\s*'Drive'/);
  assert.match(navRail, /\{\s*id:\s*'document-library'[\s\S]*label:\s*'Document Library'/);
  assert.doesNotMatch(navRail, /label:\s*'OmniDrive'/);
});

test('Drive page keeps only the Drive catalog', () => {
  const projectsPage = readFileSync(path.join(repoRoot, 'frontend/src/pages/Projects.jsx'), 'utf8');

  assert.match(projectsPage, /<h1 className="projects__title">Drive<\/h1>/);
  assert.match(projectsPage, /label:\s*'Dub Projects'/);
  assert.match(projectsPage, /label:\s*'Voice Profiles'/);
  assert.match(projectsPage, /label:\s*'Exports'/);
  assert.doesNotMatch(projectsPage, /Drop documents/);
  assert.doesNotMatch(projectsPage, /Default engine voice/);
});

test('Document Library page owns document upload and read aloud', () => {
  const documentLibrary = readFileSync(path.join(repoRoot, 'frontend/src/pages/DocumentLibrary.jsx'), 'utf8');

  assert.match(documentLibrary, /<h1 className="projects__title">Document Library<\/h1>/);
  assert.match(documentLibrary, /Drop documents/);
  assert.match(documentLibrary, /buildDocumentVoiceOptions/);
  assert.match(documentLibrary, /engine_id/);
  assert.match(documentLibrary, /voice/);
  assert.match(documentLibrary, /Document playback position/);
});

test('Document Library centers the visible import button in the dropzone', () => {
  const documentLibrary = readFileSync(path.join(repoRoot, 'frontend/src/pages/DocumentLibrary.jsx'), 'utf8');
  const styles = readFileSync(path.join(repoRoot, 'frontend/src/pages/Projects.css'), 'utf8');

  assert.match(documentLibrary, /Drop documents/);
  assert.match(documentLibrary, /documents-reader__import-button/);
  assert.match(documentLibrary, />\s*Import\s*</);
  assert.match(styles, /\.documents-reader__dropzone\s*\{[\s\S]*align-items:\s*center/);
  assert.match(styles, /\.documents-reader__import-button\s*\{[\s\S]*justify-content:\s*center/);
});

test('Document Library has plain text and original synchronized viewer modes', () => {
  const documentLibrary = readFileSync(path.join(repoRoot, 'frontend/src/pages/DocumentLibrary.jsx'), 'utf8');
  const styles = readFileSync(path.join(repoRoot, 'frontend/src/pages/Projects.css'), 'utf8');

  assert.match(documentLibrary, /Plain text/);
  assert.match(documentLibrary, /Original/);
  assert.match(documentLibrary, /getPlaybackHighlightRange/);
  assert.match(documentLibrary, /documents-reader__highlight/);
  assert.match(styles, /\.documents-reader__viewer/);
  assert.match(styles, /\.documents-reader__page/);
});

test('Document Library includes library tree, filters, and playlist controls', () => {
  const documentLibrary = readFileSync(path.join(repoRoot, 'frontend/src/pages/DocumentLibrary.jsx'), 'utf8');
  const styles = readFileSync(path.join(repoRoot, 'frontend/src/pages/Projects.css'), 'utf8');

  assert.match(documentLibrary, /New Folder/);
  assert.match(documentLibrary, /Subfolder/);
  assert.match(documentLibrary, /Playlists/);
  assert.match(documentLibrary, /New Playlist/);
  assert.match(documentLibrary, /Add to playlist/);
  assert.match(documentLibrary, /Filter/);
  assert.match(styles, /\.documents-reader__tree/);
  assert.match(styles, /\.documents-reader__playlist/);
  assert.match(styles, /\.documents-reader__filters/);
});

test('Drive and Document Library header chrome are distinct', () => {
  const header = readFileSync(path.join(repoRoot, 'frontend/src/components/Header.jsx'), 'utf8');

  assert.match(header, /projects:\s*\{\s*label:\s*'Drive'/);
  assert.match(header, /document-library['"]?:\s*\{\s*label:\s*'Document Library'/);
  assert.doesNotMatch(header, /label:\s*'OmniDrive'/);
});

test('App routes the Document Library main nav mode separately', () => {
  const app = readFileSync(path.join(repoRoot, 'frontend/src/App.jsx'), 'utf8');

  assert.match(app, /const DocumentLibrary\s*=\s*lazy\(\(\)\s*=>\s*import\('\.\/pages\/DocumentLibrary'\)\)/);
  assert.match(app, /mode === 'document-library'/);
});
