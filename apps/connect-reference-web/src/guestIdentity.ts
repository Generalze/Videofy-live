// owner: masterzee001
/**
 * Guest identity. Connect Reference members need no account: the browser mints
 * a stable subject once ('guest_' + random) and reuses it forever, so
 * leaving and rejoining reads as the same person to the room service. The
 * display name is remembered purely as a lobby convenience.
 */
import type { KeyValueStore } from './hostKeys';

const SUBJECT_KEY = 'connect-reference.guestSubject';
const DISPLAY_NAME_KEY = 'connect-reference.displayName';
const SUBJECT_PREFIX = 'guest_';

function defaultRandomId(): string {
  let out = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function ensureGuestSubject(
  store: KeyValueStore,
  randomId: () => string = defaultRandomId,
): string {
  const existing = store.getItem(SUBJECT_KEY);
  if (
    existing !== null &&
    existing.startsWith(SUBJECT_PREFIX) &&
    existing.length > SUBJECT_PREFIX.length
  ) {
    return existing;
  }
  const minted = SUBJECT_PREFIX + randomId();
  store.setItem(SUBJECT_KEY, minted);
  return minted;
}

export function rememberDisplayName(store: KeyValueStore, displayName: string): void {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return;
  store.setItem(DISPLAY_NAME_KEY, trimmed);
}

export function recallDisplayName(store: KeyValueStore): string {
  return store.getItem(DISPLAY_NAME_KEY) ?? '';
}
