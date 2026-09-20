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

/**
 * THE OUTGOING RING'S ARC, and why it is a measurement.
 *
 * The board draws a teal arc with a bright node at its head around the
 * outgoing call. An arc that simply spins is decoration; an arc that fills is a
 * claim, and a claim has to be about something. This one is about the RING
 * WINDOW: `call:direct:state` carries a server-stamped `expiresAtMs`, and when
 * it passes the gateway itself transitions the call to `no_answer` (or
 * `unavailable`). So the arc is the share of the ring window that has gone --
 * the call really is that far through its chance of being answered.
 *
 * NO WINDOW LENGTH IS ASSUMED. `RINGING_WINDOW_MS` lives on the server and the
 * grace period after Answer moves `expiresAtMs` forward, so the denominator is
 * the FIRST remaining figure this screen saw, captured from the wire. A ring
 * that gets extended simply un-fills, which is the honest picture of a
 * deadline that moved.
 *
 * Returns null when there is nothing to measure -- no deadline on the wire, or
 * a deadline that had already passed when it arrived -- and the caller draws
 * no arc at all rather than an empty one.
 */
export function ringProgress(input: {
  /** Server-stamped deadline from `call:direct:state`. */
  readonly expiresAtMs: number | null;
  /** The first `expiresAtMs - serverNow` this screen saw, in ms. */
  readonly windowMs: number | null;
  /** local-now minus server-now, from {@link observeServerClock}. */
  readonly offsetMs: number | null;
  readonly localNowMs: number;
}): number | null {
  const { expiresAtMs, windowMs } = input;
  if (expiresAtMs === null || expiresAtMs <= 0) return null;
  if (windowMs === null || windowMs <= 0) return null;
  const serverNow = input.localNowMs - (input.offsetMs ?? 0);
  const remaining = expiresAtMs - serverNow;
  const elapsed = windowMs - remaining;
  if (elapsed <= 0) return 0;
  return Math.min(1, elapsed / windowMs);
}

/**
 * The denominator, captured once. The first deadline this screen was told
 * about, measured against the server's clock at that moment; later wires never
 * move it, for the same reason {@link observeServerClock} never moves the
 * offset.
 */
export function observeRingWindow(
  current: number | null,
  expiresAtMs: number | null,
  offsetMs: number | null,
  localNowMs: number,
): number | null {
  if (current !== null) return current;
  if (expiresAtMs === null || expiresAtMs <= 0) return null;
  const remaining = expiresAtMs - (localNowMs - (offsetMs ?? 0));
  return remaining > 0 ? remaining : null;
}

/**
 * `0:07`, `4:12`, `1:02:33` -- a length, in a line of running text. This is the
 * call HISTORY's form, where the duration sits inside a sentence beside a name
 * and a leading zero reads as a typo.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/**
 * `00:07`, `03:48`, `1:02:33` -- THE CLOCK FACE on the live call screen.
 *
 * Zero-padded, and a separate function rather than a flag, because the two
 * surfaces want different things and each is pinned by its own test. This one
 * is the largest type on the screen and is set in tabular figures: a clock that
 * changes width at ten minutes shifts the whole centred column sideways, which
 * is the one thing tabular numerals are chosen to prevent. The board reads
 * `03:48`; the history list reads `4:12`, and that is deliberate too.
 */
export function formatCallClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

/**
 * IS THERE ANYTHING FOR THE SCREEN'S CLOCK TO ADVANCE?
 *
 * `!terminal` LEADS, and that is the property this function exists to hold: a
 * call the server has ended stops the clock before any other consideration. It
 * used to require an origin to count from, which is right for the duration and
 * left the outgoing ring arc frozen for the whole of the ring -- the one phase
 * it exists for -- so a ring deadline is reason enough to tick as well.
 */
export function callTickWanted(input: {
  readonly terminal: boolean;
  readonly connectedAtMs: number | null;
  readonly ringExpiresAtMs: number | null;
}): boolean {
  if (input.terminal) return false;
  return input.connectedAtMs !== null || input.ringExpiresAtMs !== null;
}

/**
 * How often. A second-by-second ARC steps visibly, and a stepping arc reads as
 * a rendering fault rather than a measurement; a duration in whole seconds has
 * nothing to gain from a faster tick.
 */
export function callTickIntervalMs(connectedAtMs: number | null): number {
  return connectedAtMs === null ? 250 : 1000;
}

/** Whatever `setInterval` handed back. Never inspected, only cancelled. */
export type TickHandle = unknown;

/**
 * THE TICK, AND ITS CANCELLATION, OUT WHERE BOTH CAN BE MEASURED.
 *
 * This was four lines inside a `useEffect`, and the test that guarded it
 * asserted the SOURCE TEXT of two other lines in the same file. A mutant that
 * deleted the cleanup -- leaving the interval running after the call ended,
 * which is the exact property the test exists to protect -- left both asserted
 * strings byte-identical and the suite green.
 *
 * So the effect's whole body is this function, and the test calls it: the
 * returned canceller is an ordinary value that can be invoked and checked.
 * `schedule` and `cancel` are injected for the same reason -- a test should not
 * have to wait a real second to find out that nothing was cancelled.
 */
export function startCallTick(input: {
  readonly ticking: boolean;
  readonly intervalMs: number;
  readonly onTick: (nowMs: number) => void;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => TickHandle;
  readonly cancel?: (handle: TickHandle) => void;
}): (() => void) | undefined {
  if (!input.ticking) return undefined;
  const now = input.now ?? Date.now;
  const schedule = input.schedule ?? ((fn, ms): TickHandle => setInterval(fn, ms));
  const cancel =
    input.cancel ?? ((handle: TickHandle): void => clearInterval(handle as ReturnType<typeof setInterval>));
  // Once immediately: the screen may have been still for a while before the
  // reason to tick appeared, and the first painted figure must not be stale.
  input.onTick(now());
  const handle = schedule(() => input.onTick(now()), input.intervalMs);
  return () => cancel(handle);
}

/**
 * `4 min 51 s` -- the ended screen's duration, in words rather than a clock
 * face. A call that is over is a length, not a time; `0:07` reads like
 * something still running.
 */
export function formatSpokenElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hr`);
  if (minutes > 0) parts.push(`${minutes} min`);
  // Seconds are dropped only when a whole minute or hour stands alone, so
  // "1 hr" never silently means "1 hr 0 min 0 s" while "4 min 51 s" shows both.
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} s`);
  return parts.join(' ');
}
