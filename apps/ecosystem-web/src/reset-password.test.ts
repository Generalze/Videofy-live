/**
 * The password-reset landing.
 *
 * THE DEFECT THIS PINS, and it was the whole flow rather than a corner of it.
 * The reset backend was complete: a challenge, a delivery, a single-use
 * completion that revokes every session. But the delivery provider could not
 * tell one kind of message from another, so a reset arrived as the
 * VERIFICATION email -- wrong subject, wrong words, and a link to
 * /app/verify-email/, which refuses a reset token because the two live in
 * deliberately separate fields. And nothing served /app/reset-password/ either,
 * because nothing had ever sent anybody there.
 *
 * Every half passed its own tests. Nothing tested the seam, so the product
 * shipped a password reset that could not reset a password.
 */
import { describe, expect, it } from 'vitest';
import { verificationLink } from '@videofy-live/account-trust';
import { routeFromPath } from './router';
import { isResetPasswordPath } from './pages/ResetPassword';
import { isVerifyEmailPath } from './pages/VerifyEmail';

describe('the reset landing path', () => {
  it('matches with and without a trailing slash', () => {
    expect(isResetPasswordPath('/app/reset-password')).toBe(true);
    expect(isResetPasswordPath('/app/reset-password/')).toBe(true);
  });

  it('does not swallow the rest of the registered shell', () => {
    expect(isResetPasswordPath('/app/')).toBe(false);
    expect(isResetPasswordPath('/app/organizations/')).toBe(false);
    expect(isResetPasswordPath('/app/reset-password-now/')).toBe(false);
  });

  /* Both landings live under /app/, so the router must still route them there. */
  it('is served by the app route', () => {
    expect(routeFromPath('/app/reset-password/')).toBe('app');
  });

  /*
   * THE COLLISION THAT CAUSED THIS. The two landings must never both claim a
   * path: rendering the verification page for a reset token is exactly the
   * failure being fixed.
   */
  it('never claims the same path as the verification landing', () => {
    for (const path of ['/app/reset-password/', '/app/verify-email/', '/app/']) {
      expect(isResetPasswordPath(path) && isVerifyEmailPath(path)).toBe(false);
    }
  });
});

describe('the link the email actually builds', () => {
  const ORIGIN = 'https://staging.consummate7.com';

  /*
   * Asserted against the REAL link builder rather than a hardcoded string. A
   * test that pins how a URL is spelt passes happily while nothing serves it,
   * which is how the verification gap survived; this one fails if either side
   * moves.
   */
  it('sends a reset to the page that can complete one', () => {
    const link = verificationLink(ORIGIN, 'a-token', 'password-reset');
    expect(isResetPasswordPath(new URL(link).pathname)).toBe(true);
    expect(isVerifyEmailPath(new URL(link).pathname)).toBe(false);
  });

  it('still sends a verification to the verification page', () => {
    const link = verificationLink(ORIGIN, 'a-token', 'verify-email');
    expect(isVerifyEmailPath(new URL(link).pathname)).toBe(true);
    expect(isResetPasswordPath(new URL(link).pathname)).toBe(false);
  });

  it('carries the token that the page reads back', () => {
    const link = verificationLink(ORIGIN, 'a token/with?awkward=chars', 'password-reset');
    expect(new URL(link).searchParams.get('token')).toBe('a token/with?awkward=chars');
  });

  /* Defaulting to verification is what made every message look the same. */
  it('defaults to verification only when nobody said otherwise', () => {
    expect(isVerifyEmailPath(new URL(verificationLink(ORIGIN, 't')).pathname)).toBe(true);
  });
});
