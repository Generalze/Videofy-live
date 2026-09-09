/** @author masterzee001 */
/**
 * Native ring credentials are deliberately shorter than the device session.
 *
 * The account session can last until sign-out, but the native receiver may run
 * while JS is not alive. This bound means the receiver can only answer ring
 * pushes for a short period after JS last validated/refreshed the account
 * session; foreground use refreshes it.
 */

export const NATIVE_RING_CREDENTIAL_TTL_MS = 15 * 60 * 1000;
export const NATIVE_RING_CREDENTIAL_REFRESH_MS = 5 * 60 * 1000;

export function nativeRingCredentialExpiresAt(
  sessionExpiresAtMs: number | null,
  nowMs = Date.now(),
): number | null {
  if (sessionExpiresAtMs === null || sessionExpiresAtMs <= nowMs) return null;
  return Math.min(sessionExpiresAtMs, nowMs + NATIVE_RING_CREDENTIAL_TTL_MS);
}
