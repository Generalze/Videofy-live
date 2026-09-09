/** @author masterzee001 */
/**
 * Process-wide avatar invalidation.
 *
 * AvatarView fetches through the authenticated API and caches by account and
 * version. Updating the profile picture in one screen must make every mounted
 * AvatarView for that account move to a new cache key, including contact rows,
 * chat headers and call tiles that do not receive ProfileScreen's local state.
 */

type Listener = () => void;

const versions = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();

function clean(accountId: string): string {
  return accountId.trim();
}

export function avatarInvalidationVersion(accountId: string): number {
  return versions.get(clean(accountId)) ?? 0;
}

export function avatarCacheVersion(accountId: string, version: number): number {
  return Math.max(0, Math.floor(version)) + avatarInvalidationVersion(accountId);
}

export function subscribeAvatarInvalidation(accountId: string, listener: Listener): () => void {
  const key = clean(accountId);
  if (key.length === 0) return () => {};
  const set = listeners.get(key) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

export function invalidateAvatar(accountId: string): void {
  const key = clean(accountId);
  if (key.length === 0) return;
  versions.set(key, avatarInvalidationVersion(key) + 1);
  for (const listener of listeners.get(key) ?? []) listener();
}

export function resetAvatarInvalidationForTests(): void {
  versions.clear();
  listeners.clear();
}
