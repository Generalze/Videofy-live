/** @author masterzee001 */
/**
 * WHAT THE CALL SCREEN SAYS, decided away from the screen so it can be proven.
 *
 * THE RULE THIS FILE EXISTS TO HOLD:
 *
 *   `connectedAtMs` tells us WHEN the call first connected.
 *   `serverState`   tells us WHAT the call is doing now.
 *
 * They are not interchangeable, and the screen used to treat them as if they
 * were: the connected row rendered whenever `connectedAtMs` existed, and said
 * "Connected" for any non-terminal state that was not `reconnecting`. So a
 * server that had gone back to `connecting` after a renegotiation still read
 * Connected, and the caller's screen quietly disagreed with the call.
 *
 * The elapsed time keeps running across a reconnect -- the call did not restart
 * -- but the sentence beneath it is whatever the server currently says.
 *
 * ONE SENTENCE PER STATE. `directStateWords` is the only place a state becomes
 * words, so `reconnecting` reads the same before and after the timer appears.
 * It previously said "Network issue -- reconnecting..." in one place and
 * "Reconnecting..." in the other, for the identical state.
 */
import { directStateWords, TERMINAL_DIRECT_STATES } from './directCallApi';

/**
 * The state the server currently asserts, or null when there is none to show.
 *
 * Terminal states are excluded because the screen has a separate ending
 * treatment for them; a caller does not want a running timer under "Call
 * ended".
 */
export function liveStateOf(serverState: string | null): string | null {
  if (serverState === null) return null;
  return TERMINAL_DIRECT_STATES.has(serverState) ? null : serverState;
}

/** True once the call has reached a state it cannot leave. */
export function isTerminal(serverState: string | null): boolean {
  return serverState !== null && TERMINAL_DIRECT_STATES.has(serverState);
}

/**
 * The words shown while two-way audio is not yet proven.
 *
 * Before the first wire arrives there is genuinely nothing the server has said,
 * so the screen falls back to the one thing it does know for certain: which end
 * of the call this device is. A caller reads "Calling"; a callee, who has
 * already answered, reads "Connecting".
 */
export function stateLine(
  serverState: string | null,
  role: 'caller' | 'callee',
  peerName: string,
): string {
  if (serverState === null) return role === 'caller' ? `Calling ${peerName}…` : 'Connecting…';
  return directStateWords(serverState, peerName);
}

export interface ConnectedRow {
  /** Show the running timer and the status line beneath it. */
  readonly show: boolean;
  /** The server's own sentence for the current state. */
  readonly words: string;
  /** Anything other than `connected` is worth marking. */
  readonly warn: boolean;
}

/**
 * The row beneath the timer.
 *
 * Rendered only when there is BOTH an origin to count from AND a live state to
 * describe. A historic `connectedAtMs` on its own is not permission to claim
 * the call is connected now.
 */
export function connectedRow(
  serverState: string | null,
  connectedAtMs: number | null,
  peerName: string,
): ConnectedRow {
  const live = liveStateOf(serverState);
  if (connectedAtMs === null || live === null) {
    return { show: false, words: '', warn: false };
  }
  return {
    show: true,
    words: directStateWords(live, peerName),
    warn: live !== 'connected',
  };
}

/**
 * WHY TRANSLATED AUDIO IS UNAVAILABLE, in the line the transport log carries.
 *
 * The screen used to print one fixed sentence -- "translated audio unavailable
 * on this build" -- for both branches of the diagnostic, and the two branches
 * are different investigations:
 *
 *   no reason    the APK genuinely ships no native track, so the next step is a
 *                build that contains one.
 *   a reason     the track is there and THREW. A build would change nothing;
 *                the message is the whole evidence, and on a handset it is the
 *                only evidence anybody will get.
 *
 * This matters most on the first device run of the native track, where the
 * wrong sentence would send the investigation at a rebuild that cannot help.
 */
export function translatedAudioUnavailableLine(error?: string): string {
  return error === undefined
    ? 'translated audio unavailable: this build has no native track'
    : `translated audio unavailable: the path threw -- ${error}`;
}
