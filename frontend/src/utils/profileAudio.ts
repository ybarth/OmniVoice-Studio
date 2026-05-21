export function profileAudioPath(profileId: string, cacheToken: string | number = Date.now()): string {
  return `/profiles/${encodeURIComponent(profileId)}/audio?t=${encodeURIComponent(String(cacheToken))}`;
}

export function profilePhotoPath(profileId: string, cacheToken: string | number = Date.now()): string {
  return `/profiles/${encodeURIComponent(profileId)}/photo?t=${encodeURIComponent(String(cacheToken))}`;
}
