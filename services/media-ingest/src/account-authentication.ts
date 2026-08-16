/** @owner masterzee001 */
/**
 * Who is calling, established rather than accepted.
 *
 * Until accounts existed, ownership arrived in an `x-videofy-voice-owner`
 * header — a value the client simply asserted. That was survivable only while
 * the identity was a browser-local prototype that identified nothing; with real
 * accounts it would mean anybody could enrol into, or delete, another person's
 * voice by typing their account id into a header. The header is gone.
 *
 * A bearer token is verified here instead, locally, with no call to the account
 * service: a signature check is cheap and a round trip would make enrolment and
 * call joins depend on sign-in being up.
 *
 * The one thing local verification cannot see is a revocation — "sign out
 * everywhere" bumps a counter this service does not read — so a token stays
 * usable here until it expires. That is written down in the token module too,
 * and it is the deliberate price of not needing the account service present.
 */
import type express from 'express';
import { bearerToken, verifySessionToken } from '@videofy-live/account-tokens';
import type { VoiceOwnerId } from '@videofy-live/participant-contracts';

/** Returns the authenticated owner, or null. Never throws, never logs. */
export type AuthenticateRequest = (req: express.Request) => VoiceOwnerId | null;

export function createTokenAuthentication(
  secret: Buffer,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): AuthenticateRequest {
  return (req) => {
    const token = bearerToken(req.header('authorization'));
    if (!token) return null;
    const verified = verifySessionToken({ secret, token, nowSeconds: nowSeconds() });
    // The account id inside a token whose signature held. Nothing the client
    // said about itself outside that signature is consulted.
    return verified.ok ? verified.claims.accountId : null;
  };
}

/**
 * Refuses everybody.
 *
 * The default when no secret is configured. A service that cannot verify a
 * token must not fall back to trusting a header — failing closed costs a
 * feature, failing open costs somebody their voice.
 */
export function createRefusingAuthentication(): AuthenticateRequest {
  return () => null;
}
