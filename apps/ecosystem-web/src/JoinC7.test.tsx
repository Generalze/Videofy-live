import { describe, expect, it } from 'vitest';
import { joinRequestBody } from './JoinC7';

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
