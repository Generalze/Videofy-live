// owner: masterzee001
/**
 * The rejoin plan. When the SDK reports that the credential in hand is
 * finished (a terminal signal — no retry with the old token can succeed),
 * the app fetches a FRESH token from the KC server and joins again. That
 * loop is bounded and its delays are fixed here, so the behaviour is a
 * testable fact rather than an accident of wiring.
 */

export const REJOIN_MAX_ATTEMPTS = 4;

const REJOIN_DELAYS_MS = [0, 600, 1500, 3000] as const;

/** Delay BEFORE the given 1-based attempt. The first attempt is immediate. */
export function rejoinDelayMs(attempt: number): number {
  if (attempt <= 1) return 0;
  const index = Math.min(attempt - 1, REJOIN_DELAYS_MS.length - 1);
  return REJOIN_DELAYS_MS[index] ?? 0;
}

export function shouldKeepTrying(attempt: number): boolean {
  return attempt >= 1 && attempt <= REJOIN_MAX_ATTEMPTS;
}

/** Product-language status for the visible rejoin banner. */
export function rejoinStatusLine(
  attempt: number,
  maxAttempts: number = REJOIN_MAX_ATTEMPTS,
): string {
  return (
    'Your seat needs a fresh invitation — getting you back in (attempt ' +
    attempt +
    ' of ' +
    maxAttempts +
    ')'
  );
}

export function rejoinFailedLine(): string {
  return 'We could not get you back into the room. Return to the lobby and join again.';
}
