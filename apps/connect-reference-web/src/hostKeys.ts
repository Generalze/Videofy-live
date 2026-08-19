// owner: masterzee001
/**
 * Host-key retention. The KC server shows a room's host key exactly once, at
 * creation; the creating browser keeps it in localStorage so the host panel
 * appears automatically on later visits. The key never travels anywhere but
 * to the KC server's host-only routes.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const HOST_KEY_PREFIX = 'connect-reference.hostKey.';

export function hostKeyStorageKey(roomId: string): string {
  return HOST_KEY_PREFIX + roomId;
}

function looksLikeHostKey(value: string): boolean {
  return value.startsWith('host_') && value.length > 'host_'.length;
}

export function rememberHostKey(store: KeyValueStore, roomId: string, hostKey: string): void {
  if (roomId.length === 0 || !looksLikeHostKey(hostKey)) return;
  store.setItem(hostKeyStorageKey(roomId), hostKey);
}

export function recallHostKey(store: KeyValueStore, roomId: string): string | null {
  const stored = store.getItem(hostKeyStorageKey(roomId));
  if (stored === null || !looksLikeHostKey(stored)) return null;
  return stored;
}

export function forgetHostKey(store: KeyValueStore, roomId: string): void {
  store.removeItem(hostKeyStorageKey(roomId));
}

export function holdsHostKey(store: KeyValueStore, roomId: string): boolean {
  return recallHostKey(store, roomId) !== null;
}
