/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import { joinRequestBody, persistJoinSession } from './JoinC7';
import { hasSession, readSession, type SessionStorageLike } from './session';

/**
 * The request the join form sends.
 *
 * This exists because registration was impossible for EVERYBODY and nothing
 * caught it: the form collected a C7 username and posted only the email and
 * password, so `POST /accounts` answered "Choose a C7 username." to somebody
 * looking at the username they had just typed. Both halves were correct on
 * their own -- the field worked, the endpoint worked -- and the seam between
 * them had never been joined.
 *
 * Asserting the body shape is the cheapest guard against that reopening, and it
 * needs no DOM: the shape is a contract with the account service, not a detail
 * of how the form renders.
 */
describe('what the join form sends', () => {
  it('includes the C7 username when creating an account', () => {
    const body = joinRequestBody('create', 'a@example.com', 'pw', 'c7meakzoe');
    expect(body).toEqual({ email: 'a@example.com', password: 'pw', username: 'c7meakzoe' });
  });

  /* The field the server requires must never be silently dropped again. */
  it('never omits the username on create', () => {
    expect(Object.keys(joinRequestBody('create', 'a@example.com', 'pw', 'c7zoe'))).toContain(
      'username',
    );
  });

  /*
   * Sign-in is identified by address. A username here would be a second way to
   * name the same person, and the server does not read one.
   */
  it('does not send a username when signing in', () => {
    const body = joinRequestBody('signin', 'a@example.com', 'pw', 'c7meakzoe');
    expect(body).toEqual({ email: 'a@example.com', password: 'pw' });
    expect(Object.keys(body)).not.toContain('username');
  });
});

function memory(): SessionStorageLike & { keys(): string[] } {
  const map = new Map<string, string>();
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

/**
 * What the join form STORES.
 *
 * The other half of the same class of defect: the form used to write the two
 * session keys itself, in its own idea of the shape, and the operator console
 * read them in its own. The seam is pinned here by round-tripping the sign-in
 * answer through the one session module and reading it back the way every
 * other surface on this origin does.
 */
describe('what the join form stores', () => {
  it('writes the sign-in answer as the shared session, under both keys', () => {
    const storage = memory();

    expect(
      persistJoinSession({ accountId: 'acct_1', token: 'tok-1', voiceGender: 'female' }, storage),
    ).toBe(true);

    expect(storage.keys().sort()).toEqual(['c7.session', 'videofy-account:session']);
    expect(storage.getItem('c7.session')).toBe('tok-1');
    expect(readSession(storage)).toEqual({
      accountId: 'acct_1',
      token: 'tok-1',
      voiceGender: 'female',
    });
    expect(hasSession(storage)).toBe(true);
  });

  it('carries no voice when the service stated none', () => {
    const storage = memory();
    persistJoinSession({ accountId: 'acct_1', token: 'tok-1' }, storage);
    expect(readSession(storage)).toEqual({ accountId: 'acct_1', token: 'tok-1' });
  });

  /*
   * A half-session -- token but no account id -- is what made the site look
   * signed in while every product surface said otherwise. It is refused whole.
   */
  it('stores nothing when the answer is not a session', () => {
    for (const body of [{}, { token: 'tok-1' }, { accountId: 'acct_1' }, { accountId: '', token: 'tok-1' }, { accountId: 'acct_1', token: '' }]) {
      const storage = memory();
      expect(persistJoinSession(body, storage)).toBe(false);
      expect(storage.keys()).toEqual([]);
      expect(hasSession(storage)).toBe(false);
    }
  });

  it('is unchanged by storage that is unavailable', () => {
    expect(persistJoinSession({ accountId: 'acct_1', token: 'tok-1' }, null)).toBe(true);
  });
});
