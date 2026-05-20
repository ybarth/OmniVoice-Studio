export type CredentialStatusLike = {
  key: string;
  configured?: boolean;
};

export function credentialConfigured(
  statuses: CredentialStatusLike[] | undefined,
  saved: Record<string, boolean>,
  key: string,
): boolean {
  return Boolean(saved[key] || statuses?.find(row => row.key === key)?.configured);
}

export function credentialBadgeLabel(configured: boolean): string {
  return configured ? 'Set' : 'Not set';
}
