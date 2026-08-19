/** @author masterzee001 */
/**
 * The two Zoom signatures — deliberately in one file so nobody reaches for
 * the wrong one.
 *
 * They share nothing but an algorithm:
 *
 *   WEBHOOK      HMAC-SHA256 over  `v0:{x-zm-request-timestamp}:{raw body}`
 *                keyed by the WEBHOOK SECRET TOKEN,
 *                compared against `x-zm-signature` with a `v0=` prefix.
 *
 *   RTMS STREAM  HMAC-SHA256 over  `{client_id},{meeting_uuid},{rtms_stream_id}`
 *                keyed by the CLIENT SECRET, hex digest, sent inside the
 *                handshake messages.
 *
 * Different input, different secret, different purpose. Conflating them is a
 * documented-and-easy mistake that fails in a way that looks like Zoom being
 * broken rather than us being wrong.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The signature carried inside SIGNALING/DATA handshake requests. */
export function rtmsStreamSignature(input: {
  clientId: string;
  clientSecret: string;
  meetingUuid: string;
  rtmsStreamId: string;
}): string {
  const message = `${input.clientId},${input.meetingUuid},${input.rtmsStreamId}`;
  return createHmac('sha256', input.clientSecret).update(message).digest('hex');
}

/** The signature Zoom puts on webhook deliveries. */
export function webhookSignature(input: {
  secretToken: string;
  timestamp: string;
  rawBody: string;
}): string {
  const message = `v0:${input.timestamp}:${input.rawBody}`;
  return `v0=${createHmac('sha256', input.secretToken).update(message).digest('hex')}`;
}

/** Constant-time compare; length mismatch is answered false, never thrown. */
export function signaturesMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Zoom validates a newly-registered endpoint by POSTing an `endpoint.url_
 * validation` event carrying a plainToken; the answer is that token plus its
 * HMAC under the same secret.
 */
export function urlValidationResponse(secretToken: string, plainToken: string): {
  plainToken: string;
  encryptedToken: string;
} {
  return {
    plainToken,
    encryptedToken: createHmac('sha256', secretToken).update(plainToken).digest('hex'),
  };
}
