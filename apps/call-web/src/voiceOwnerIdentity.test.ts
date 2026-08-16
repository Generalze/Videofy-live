import { describe, expect, it } from 'vitest';
import {
  clearVoiceOwnerId,
  existingVoiceOwnerId,
  resolveVoiceOwnerId,
  VOICE_OWNER_STORAGE_KEY,
  type OwnerStorageLike,
} from './voiceOwnerIdentity';

function storage(seed: Record<string, string> = {}): OwnerStorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('existingVoiceOwnerId', () => {
  it('never mints one, so joining a call cannot create an identity', () => {
    // Joining is not enrolling. Minting here would stamp a durable identifier
    // on every participant who never asked for a personal voice, and then send
    // it to the server on every join for the rest of that browser's life.
    const store = storage();

    expect(existingVoiceOwnerId(store)).toBeNull();
    expect(store.data.size).toBe(0);
  });

  it('returns the identity an enrolled owner already has', () => {
    const store = storage();
    const owner = resolveVoiceOwnerId(store, () => 'aabbccddeeff');

    expect(existingVoiceOwnerId(store)).toBe(owner);
  });

  it('refuses a stored value that did not come from here', () => {
    const store = storage({ [VOICE_OWNER_STORAGE_KEY]: 'participant_1' });

    expect(existingVoiceOwnerId(store)).toBeNull();
    // And leaves it alone: reading is not the moment to rewrite storage.
    expect(store.data.get(VOICE_OWNER_STORAGE_KEY)).toBe('participant_1');
  });

  it('survives storage being unavailable', () => {
    expect(existingVoiceOwnerId(null)).toBeNull();
  });
});

describe('resolveVoiceOwnerId', () => {
  it('mints an identity on first use and stores it', () => {
    const store = storage();

    const owner = resolveVoiceOwnerId(store, () => 'aabbccddeeff');

    expect(owner).toBe('devid_aabbccddeeff');
    expect(store.data.get(VOICE_OWNER_STORAGE_KEY)).toBe('devid_aabbccddeeff');
  });

  it('returns the SAME identity on a later visit', () => {
    // The whole reason this module exists: a personal voice has to be findable
    // after the tab closes, which per-call identifiers can never manage.
    const store = storage();
    const first = resolveVoiceOwnerId(store, () => 'aabbccddeeff');
    const second = resolveVoiceOwnerId(store, () => 'ffffffffffff');

    expect(second).toBe(first);
  });

  it('replaces a stored value that did not come from here', () => {
    // A participant id sitting under this key is not an identity, however
    // string-shaped it looks.
    const store = storage({ [VOICE_OWNER_STORAGE_KEY]: 'participant_1' });

    const owner = resolveVoiceOwnerId(store, () => 'aabbccddeeff');

    expect(owner).toBe('devid_aabbccddeeff');
  });

  it('returns null rather than inventing an identity it cannot persist', () => {
    // An unpersistable identity would enroll a voice nobody could find again.
    expect(resolveVoiceOwnerId(null)).toBeNull();
  });

  it('survives storage that throws instead of breaking the call', () => {
    const hostile: OwnerStorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    expect(resolveVoiceOwnerId(hostile)).toBeNull();
  });
});

describe('clearVoiceOwnerId', () => {
  it('forgets the identity so a later visit is unenrolled', () => {
    const store = storage();
    resolveVoiceOwnerId(store, () => 'aabbccddeeff');

    clearVoiceOwnerId(store);

    expect(store.data.has(VOICE_OWNER_STORAGE_KEY)).toBe(false);
  });

  it('does not throw when storage is unavailable', () => {
    expect(() => clearVoiceOwnerId(null)).not.toThrow();
  });
});
