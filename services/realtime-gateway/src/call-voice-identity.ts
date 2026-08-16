/** @owner masterzee001 */
/**
 * Deriving who is speaking, at the gateway boundary.
 *
 * Call join used to accept `voiceOwnerId` straight from the browser while
 * enrolment and deletion already required a verified token. That asymmetry was
 * the whole defect: a caller could name somebody else's account in a join
 * payload and have that account's personal voice selected for them.
 *
 * The join contract no longer has a field for naming an account. A client may
 * present a signed token; the gateway checks the signature and decides who that
 * is. Verification happens HERE and the derived owner travels inward — the
 * token itself goes no further than this boundary, and specifically never into
 * the session store, the ingest plan, media-ingest, captions, generated-audio
 * events, `call:state` or any log line.
 *
 * KNOWN CONSTRAINT, carried over from the token design: verification is local,
 * so a token remains usable here until it expires even if the account service
 * has since revoked that generation. Acceptable for the development
 * architecture, and it must be revisited before any staged or public
 * deployment.
 */
import { requireSessionSecret, verifySessionToken } from '@videofy-live/account-tokens';
import { logger } from './logger.js';

/** Returns the verified account, or null. Never throws, never logs the token. */
export type CallVoiceIdentityVerifier = (sessionToken: string) => string | null;

export function createCallVoiceIdentityVerifier(
  secretValue: string | undefined = process.env['VIDEOFY_AUTH_SECRET'],
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): CallVoiceIdentityVerifier | null {
  if (!secretValue) {
    // Not an error. Personal voice is optional, and a gateway with no secret
    // simply cannot grant it — which is the safe direction. Refusing to start
    // would take calls down over a feature most participants never use.
    logger.warn('VIDEOFY_AUTH_SECRET is not set; calls will use standard voices only');
    return null;
  }

  let secret: Buffer;
  try {
    secret = requireSessionSecret(secretValue, 'VIDEOFY_AUTH_SECRET');
  } catch (error) {
    // A secret too short to be a secret is a misconfiguration worth saying out
    // loud, and still not a reason to stop answering calls.
    logger.warn('VIDEOFY_AUTH_SECRET is unusable; calls will use standard voices only', {
      message: error instanceof Error ? error.message : 'invalid secret',
    });
    return null;
  }

  return (sessionToken) => {
    const verified = verifySessionToken({ secret, token: sessionToken, nowSeconds: nowSeconds() });
    // Forged, expired, malformed and "signed by somebody else" all arrive here
    // as the same answer, and all mean the same thing: no personal voice. The
    // reason is deliberately not logged — a log of failed voice
    // authentications is a log of who tried to speak as whom.
    return verified.ok ? verified.claims.accountId : null;
  };
}
