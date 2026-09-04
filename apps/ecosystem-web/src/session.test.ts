/** @author masterzee001 */
/**
 * The one session module, and the difference between STORED and VALID.
 *
 * THE DEFECT THIS PINS. The operator console said "not signed in" and
 * "gateway disconnected" while the site's nav said the founder was signed in.
 * Both were reading the same localStorage; the site checked that a key
 * EXISTED and the console checked that the server HONOURED it. A token past
 * its twelve-hour lifetime, or one minted on another origin, satisfies the
 * first and fails the second, and nothing on the site ever asked.
 */
import { describe, expect, it } from 'vitest';
import {
  clearSession,
  consumeSessionEndedNotice,
  expireSession,
  hasSession,
  readSession,
  readSessionToken,
  validateSession,
  writeSession,
  type SessionStorageLike,
} from './session';

const SHARED = 'videofy-account:session';
const BARE = 'c7.session';

function memory(seed: Record<string, string> = {}): SessionStorageLike & { keys(): string[] } {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()],
  };
}

interface Seen {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetch that answers every request the same way and remembers what it saw. */
function answering(status: number, body: unknown = {}): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const stub: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: stub, seen };
}

const failing: typeof fetch = async () => {
  throw new TypeError('network down');
};

describe('the session writer and readers', () => {
  it('writes both keys, and reads back the shared shape', () => {
    const storage = memory();
    writeSession({ accountId: 'acct_1', token: 'tok-1', voiceGender: 'female' }, storage);

    expect(storage.getItem(BARE)).toBe('tok-1');
    expect(JSON.parse(storage.getItem(SHARED) ?? '{}')).toEqual({
      accountId: 'acct_1',
      token: 'tok-1',
      voiceGender: 'female',
    });
    expect(readSession(storage)).toEqual({
      accountId: 'acct_1',
      token: 'tok-1',
      voiceGender: 'female',
    });
    expect(readSessionToken(storage)).toBe('tok-1');
    expect(hasSession(storage)).toBe(true);
  });

  /* exactOptionalPropertyTypes: absent means absent, never `undefined`. */
  it('omits the voice when none was stated', () => {
    const storage = memory();
    writeSession({ accountId: 'acct_1', token: 'tok-1' }, storage);
    expect(readSession(storage)).toEqual({ accountId: 'acct_1', token: 'tok-1' });
    expect(Object.keys(JSON.parse(storage.getItem(SHARED) ?? '{}'))).not.toContain('voiceGender');
  });

  it('clears both keys together', () => {
    const storage = memory();
    writeSession({ accountId: 'acct_1', token: 'tok-1' }, storage);
    clearSession(storage);
    expect(storage.keys()).toEqual([]);
    expect(hasSession(storage)).toBe(false);
  });

  it('treats a stored value that is not a session as absent', () => {
    expect(readSession(memory({ [SHARED]: 'not json' }))).toBeNull();
    expect(readSession(memory({ [SHARED]: '"a string"' }))).toBeNull();
    expect(readSession(memory({ [SHARED]: JSON.stringify({ token: 'tok-1' }) }))).toBeNull();
    expect(readSession(memory({ [SHARED]: JSON.stringify({ accountId: 'acct_1' }) }))).toBeNull();
    expect(
      readSession(memory({ [SHARED]: JSON.stringify({ accountId: 'acct_1', token: '' }) })),
    ).toBeNull();
  });

  it('drops a voice value it does not recognise', () => {
    const storage = memory({
      [SHARED]: JSON.stringify({ accountId: 'acct_1', token: 'tok-1', voiceGender: 'robot' }),
    });
    expect(readSession(storage)).toEqual({ accountId: 'acct_1', token: 'tok-1' });
  });

  /*
   * A browser that signed in before the shared key existed holds only the
   * bare token. It still counts as signed in HERE; it is not a session the
   * other surfaces can use until validateSession promotes it.
   */
  it('honours a legacy bare token for the site, but not as the shared shape', () => {
    const storage = memory({ [BARE]: 'tok-old' });
    expect(readSessionToken(storage)).toBe('tok-old');
    expect(hasSession(storage)).toBe(true);
    expect(readSession(storage)).toBeNull();
  });

  it('survives storage that is missing or throws', () => {
    const broken: SessionStorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(readSession(null)).toBeNull();
    expect(hasSession(null)).toBe(false);
    expect(readSession(broken)).toBeNull();
    expect(readSessionToken(broken)).toBeNull();
    expect(() => writeSession({ accountId: 'a', token: 't' }, broken)).not.toThrow();
    expect(() => clearSession(broken)).not.toThrow();
    expect(() => expireSession(broken, broken)).not.toThrow();
    expect(consumeSessionEndedNotice(broken)).toBe(false);
  });
});

describe('validateSession', () => {
  it('asks the account service with the stored bearer and keeps a session it honours', async () => {
    const storage = memory();
    writeSession({ accountId: 'acct_1', token: 'tok-1' }, storage);
    const server = answering(200, { accountId: 'acct_1', email: 'a@example.com' });

    await expect(
      validateSession('https://c7.example/account', { storage, fetch: server.fetch }),
    ).resolves.toBe('valid');

    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]?.url).toBe('https://c7.example/account/sessions/current');
    const headers = server.seen[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok-1');
    expect(readSession(storage)).toEqual({ accountId: 'acct_1', token: 'tok-1' });
  });

  /*
   * THE FOUNDER'S SCREENSHOT. A token the server refuses must not linger
   * looking signed in on the site while the console says otherwise: both keys
   * go, and the tab is told why.
   */
  it.each([401, 403])('clears both keys and leaves the notice when the server answers %d', async (status) => {
    const storage = memory();
    const tab = memory();
    writeSession({ accountId: 'acct_1', token: 'tok-stale' }, storage);

    await expect(
      validateSession('https://c7.example/account', {
        storage,
        tab,
        fetch: answering(status, { error: 'Sign in to continue.' }).fetch,
      }),
    ).resolves.toBe('expired');

    expect(storage.keys()).toEqual([]);
    expect(hasSession(storage)).toBe(false);
    expect(consumeSessionEndedNotice(tab)).toBe(true);
    // Once. The next signed-out render is an ordinary one.
    expect(consumeSessionEndedNotice(tab)).toBe(false);
  });

  /* An unreachable server is not a sign-out. Nothing is cleared, nothing noticed. */
  it('keeps the session when the service cannot be reached', async () => {
    const storage = memory();
    const tab = memory();
    writeSession({ accountId: 'acct_1', token: 'tok-1' }, storage);

    await expect(
      validateSession('https://c7.example/account', { storage, tab, fetch: failing }),
    ).resolves.toBe('offline');

    expect(readSession(storage)).toEqual({ accountId: 'acct_1', token: 'tok-1' });
    expect(consumeSessionEndedNotice(tab)).toBe(false);
  });

  it.each([500, 502, 503])('keeps the session on a %d from the service', async (status) => {
    const storage = memory();
    writeSession({ accountId: 'acct_1', token: 'tok-1' }, storage);

    await expect(
      validateSession('https://c7.example/account', { storage, fetch: answering(status).fetch }),
    ).resolves.toBe('offline');

    expect(hasSession(storage)).toBe(true);
  });

  it('asks nothing when nothing is stored', async () => {
    const server = answering(200);
    await expect(
      validateSession('https://c7.example/account', { storage: memory(), fetch: server.fetch }),
    ).resolves.toBe('absent');
    expect(server.seen).toHaveLength(0);
  });

  /*
   * The upgrade path: a bare legacy token the server confirms is promoted to
   * the shared shape, so call-web and operator-web can read it too.
   */
  it('promotes a confirmed legacy bare token to the shared shape', async () => {
    const storage = memory({ [BARE]: 'tok-old' });

    await expect(
      validateSession('https://c7.example/account', {
        storage,
        fetch: answering(200, { accountId: 'acct_9', email: 'a@example.com', voiceGender: 'male' })
          .fetch,
      }),
    ).resolves.toBe('valid');

    expect(readSession(storage)).toEqual({
      accountId: 'acct_9',
      token: 'tok-old',
      voiceGender: 'male',
    });
    expect(storage.getItem(BARE)).toBe('tok-old');
  });

  it('never invents a session when nothing is stored, whatever the server says', async () => {
    const storage = memory();
    await validateSession('https://c7.example/account', {
      storage,
      fetch: answering(200, { accountId: 'acct_9' }).fetch,
    });
    expect(storage.keys()).toEqual([]);
  });
});

describe('the one-time session-ended notice', () => {
  it('is set by an expiry and read once', () => {
    const storage = memory();
    const tab = memory();
    writeSession({ accountId: 'acct_1', token: 'tok-1' }, storage);

    expireSession(storage, tab);

    expect(storage.keys()).toEqual([]);
    expect(consumeSessionEndedNotice(tab)).toBe(true);
    expect(consumeSessionEndedNotice(tab)).toBe(false);
  });

  /* A chosen sign-out is not an expiry; it must not be announced as one. */
  it('is not left behind by a plain clear', () => {
    const storage = memory();
    const tab = memory();
    writeSession({ accountId: 'acct_1', token: 'tok-1' }, storage);
    clearSession(storage);
    expect(consumeSessionEndedNotice(tab)).toBe(false);
  });
});
