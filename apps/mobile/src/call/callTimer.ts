/** @author masterzee001 */
/**
 * The call timer, anchored to the SERVER's clock.
 *
 * THE ORIGIN IS `connectedAtMs` FROM THE TELEPHONE STATE, never a local
 * "I saw the first packet" moment: both phones then show the same elapsed
 * time, and a reconnect -- which re-delivers the same origin -- cannot
 * restart the clock. The old screen showed "Connected" with no timer at all,
 * and the person on the phone could not tell a long call from a stuck one.
 *
 * TWO CLOCKS. The origin is in server time; the ticking is in phone time. The
 * offset between them is measured ONCE, from the first state the socket
 * receives: that state was just emitted, so its `updatedAtMs` is the server's
 * "now" at the moment of receipt. Later wires never move it -- a resume ack
 * legitimately carries a state that transitioned minutes ago.
 */

/** local-now minus server-now, measured from the first live wire. */
export function observeServerClock(
  current: number | null,
  wireUpdatedAtMs: number,
  localNowMs: number,
): number {
  return current ?? localNowMs - wireUpdatedAtMs;
}

/** Milliseconds since the server-stamped origin, on the phone's clock. Never negative. */
export function elapsedSinceMs(
  connectedAtMs: number,
  offsetMs: number | null,
  localNowMs: number,
): number {
  return Math.max(0, localNowMs - (offsetMs ?? 0) - connectedAtMs);
}

/** `0:07`, `4:12`, `1:02:33` -- what a phone shows, not what a log shows. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}
