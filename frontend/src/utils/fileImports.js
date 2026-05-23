const DUB_MEDIA_EXTENSION_RE = /\.(mp4|mov|mkv|webm|avi|mp3|wav|flac|m4a|ogg)$/i;

export function isDubMediaFile(file) {
  if (!file) return false;
  const name = file.name || '';
  const type = file.type || '';
  return DUB_MEDIA_EXTENSION_RE.test(name) || type.startsWith('video/') || type.startsWith('audio/');
}

export function getGlobalDubDropFile(event) {
  if (event?.defaultPrevented) return null;
  const file = event?.dataTransfer?.files?.[0];
  return isDubMediaFile(file) ? file : null;
}
