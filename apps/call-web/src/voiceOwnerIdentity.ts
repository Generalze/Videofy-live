// The prototype identity that owns a personal voice.
//
// Videofy has no production authentication yet, and a voice profile has to
// outlive a call. This module is the ONLY place the browser decides who owns
// one, and it deliberately derives that from nothing else: not the display
// name, not the participant id, not the socket id, not the call code. Every one
// of those is either minted per call or typeable by a second person, and any of
// them would produce a lookup that works in one demo and is wrong afterwards.
//
// It lives in localStorage rather than sessionStorage because the whole point
// is surviving the tab being closed.
//
// KNOWN LIMITATION, and the reason this must not outlive P6.3: localStorage is
// scoped to a BROWSER PROFILE, not to a human. Two people sharing one browser
// profile share one prototype owner identity, and would therefore share a
// personal voice. That is acceptable for a development prototype and
// unacceptable for anything real, so this mechanism must be replaced when
// account authentication lands rather than promoted on the grounds that it has
// been working fine. VoiceOwnerId is the seam that makes the replacement
// cheap: the account id takes its place and nothing in the voice-provider or
// call-routing contracts moves.
import { parseVoiceOwnerId } from '@videofy-live/participant-contracts';

export interface OwnerStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const VOICE_OWNER_STORAGE_KEY = 'videofy-voice:owner';

export function defaultOwnerStorage(): OwnerStorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage access itself throws in some privacy modes.
    return null;
  }
}

/** 12 hex characters, which is plenty to keep prototype identities apart. */
function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The owner identity for this browser, creating one on first use.
 *
 * Returns null only when storage is unavailable. A caller that gets null must
 * carry on without a personal voice rather than inventing an identity — an
 * identity that cannot be persisted would enroll a voice nobody could ever
 * find again, or worse, reuse.
 */
export function resolveVoiceOwnerId(
  storage: OwnerStorageLike | null,
  createSuffix: () => string = randomSuffix,
): string | null {
  if (!storage) return null;

  try {
    const existing = parseVoiceOwnerId(storage.getItem(VOICE_OWNER_STORAGE_KEY));
    if (existing) return existing;

    // Anything stored that is not a valid owner id is replaced rather than
    // trusted: it did not come from here.
    const minted = `devid_${createSuffix()}`;
    const validated = parseVoiceOwnerId(minted);
    if (!validated) return null;
    storage.setItem(VOICE_OWNER_STORAGE_KEY, validated);
    return validated;
  } catch {
    return null;
  }
}

/** Forget this browser's identity. Used when the owner deletes their voice. */
export function clearVoiceOwnerId(storage: OwnerStorageLike | null): void {
  try {
    storage?.removeItem(VOICE_OWNER_STORAGE_KEY);
  } catch {
    // Nothing to do: failing to forget is not worth breaking a call over.
  }
}
