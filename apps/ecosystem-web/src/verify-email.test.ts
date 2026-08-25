/**
 * The email verification landing.
 *
 * THE DEFECT THIS PINS. The verification email has always linked to
 * /app/verify-email/, and nothing served it: every /app/* path fell through to
 * the registered shell, the token in the query string was ignored, and the
 * account stayed unverified permanently. The only existing test asserted how
 * the link was SPELT, which is exactly why the gap survived -- a URL nobody
 * serves passes a test that only checks its shape.
 */
import { describe, expect, it } from 'vitest';
import { routeFromPath } from './router';
import { isVerifyEmailPath } from './pages/VerifyEmail';
import { verificationLink } from '@videofy-live/account-trust';

describe('the verification landing path', () => {
  it('matches with and without a trailing slash', () => {
    expect(isVerifyEmailPath('/app/verify-email')).toBe(true);
    expect(isVerifyEmailPath('/app/verify-email/')).toBe(true);
  });

  it('does not swallow the rest of the registered shell', () => {
    expect(isVerifyEmailPath('/app/')).toBe(false);
    expect(isVerifyEmailPath('/app/organizations/')).toBe(false);
    expect(isVerifyEmailPath('/app/verify-email-address/')).toBe(false);
    expect(isVerifyEmailPath('/verify-email/')).toBe(false);
  });

  /*
   * The shell owns every path beneath /app/, and it must keep doing so: a deep
   * link has to reach the application rather than a not-found page.
   */
  it('still resolves to the app route so the shell is reachable', () => {
    expect(routeFromPath('/app/verify-email/')).toBe('app');
  });

  /*
   * THE ONE THAT WOULD HAVE CAUGHT THIS. The address the email actually builds
   * must be an address this application actually serves. Asserting the link
   * string alone is what let a dead link ship.
   */
  it('serves the exact path the verification email links to', () => {
    const link = verificationLink('https://staging.consummate7.com', 'a-token');
    const { pathname } = new URL(link);

    expect(isVerifyEmailPath(pathname)).toBe(true);
    expect(routeFromPath(pathname)).toBe('app');
  });

  it('carries the token as a query parameter the page can read', () => {
    const link = verificationLink('https://staging.consummate7.com', 'tok en/+&=');
    const url = new URL(link);

    // Round-trips through encoding: a token mangled in the link is a link that
    // fails for exactly the characters a random token most often contains.
    expect(url.searchParams.get('token')).toBe('tok en/+&=');
  });
});
