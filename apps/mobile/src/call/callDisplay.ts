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
import { formatSpokenElapsed } from './callTimer';
import type { EndedTranslationOutcome } from './translationReadiness';

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

/** Which of the board's three direct-call treatments this call is in. */
export type DirectCallPhase = 'placing' | 'live' | 'ended';

/**
 * The phase, from the two facts that decide it and no others.
 *
 * `live` is deliberately the SAME condition the timer row has always used --
 * an origin to count from AND a live state to describe -- rather than a second
 * opinion about when a call is up. Two answers to "is this call connected" is
 * how a screen comes to disagree with the call it is showing.
 */
export function directCallPhase(input: {
  readonly serverState: string | null;
  readonly elapsedMs: number | null;
  readonly connectedRowShown: boolean;
}): DirectCallPhase {
  if (isTerminal(input.serverState)) return 'ended';
  return input.elapsedMs !== null && input.connectedRowShown ? 'live' : 'placing';
}

/**
 * THE EYEBROW: the small capitals naming the moment.
 *
 * Nothing for a live call -- the board gives that screen a speech indicator
 * and a timer instead, and a caption above them would only repeat what the
 * running clock already says.
 *
 * `placing` reads differently at the two ends, and it is the one sentence on
 * this screen that is allowed to: which end of the call this device is, is the
 * single thing it knows for certain before the server has spoken.
 */
export function callEyebrow(
  serverState: string | null,
  role: 'caller' | 'callee',
  phase: DirectCallPhase,
): string | null {
  if (phase === 'ended') return 'Call ended';
  if (phase === 'live') return null;
  return role === 'caller' ? 'Calling…' : 'Connecting';
}

/**
 * The line under the name on the ended screen: `4 min 51 s · translated`.
 *
 * Null when the call never connected, because there is then no duration and
 * "0 s · translated" would describe a call that did not happen. The mode half
 * is dropped when the server never stated one; it is not guessed at 'normal',
 * which is the exact coercion that silenced translated audio for a whole call
 * once already (see callConnection's `deliverDirectState`).
 *
 * THE MODE IS NOT ENOUGH TO CERTIFY A CALL AS TRANSLATED, and this line got
 * that wrong for a day. `translated` is what the call was CONFIGURED as; by the
 * time it ends the phone may also hold the gateway's own
 * `translation-engine-unavailable`, or its own playback verdict, or the proof
 * of a frame it actually played. The screen warned "This server cannot
 * translate" for four minutes and then wrote "· translated" underneath, which
 * is this product's signature defect with the contradiction already in hand.
 *
 * So the outcome is a REQUIRED third argument -- see
 * `endedTranslationOutcome` -- and it is required rather than defaulted so that
 * forgetting it is a compile error rather than a confident sentence:
 *
 *   translated      translated audio covered MOST of the call. Only this
 *                   entitles the line to the bare word "translated". A caption
 *                   proves the engine ran, not that anybody heard it; and one
 *                   played frame proves one played frame, which for one commit
 *                   was enough to write this word over a 291-second call with
 *                   three seconds of audio in it.
 *   partly          it played for a measured minority of the call, and the line
 *                   says which minority.
 *   interrupted     the same, and it finished with frames being turned away.
 *   text-only       translated text arrived and no audio ever played.
 *   not-translated  something was measured that says it did not happen.
 *   unproven        nothing. The duration alone; the call claims nothing.
 */
export function endedSummaryLine(
  elapsedMs: number | null,
  mode: 'normal' | 'translated' | null,
  outcome: EndedTranslationOutcome,
): string | null {
  if (elapsedMs === null) return null;
  const duration = formatSpokenElapsed(elapsedMs);
  if (mode === 'normal') return `${duration} · original voices`;
  if (mode !== 'translated') return duration;
  const { verdict } = outcome;
  if (verdict === 'translated') return `${duration} · translated`;
  if (verdict === 'partly') return `${duration} · translated for ${sharePhrase(outcome.playedShare)}`;
  if (verdict === 'interrupted') {
    return `${duration} · translated for ${sharePhrase(outcome.playedShare)}, then stopped`;
  }
  if (verdict === 'text-only') return `${duration} · translated text only`;
  if (verdict === 'not-translated') return `${duration} · not translated`;
  return duration;
}

/**
 * THE SHARE OF THE CALL, IN WORDS A PERSON READS -- "about 4% of the call".
 *
 * ROUNDED DOWN, always. Rounding is a choice about which way to be wrong, and
 * on this screen the direction is settled: a figure that flatters the
 * translation is the defect this whole file exists to prevent. 0.9% is "less
 * than 1%", not "about 1%".
 */
export function sharePhrase(share: number | null): string {
  if (share === null) return 'part of the call';
  const percent = Math.floor(Math.min(1, Math.max(0, share)) * 100);
  return percent < 1 ? 'less than 1% of the call' : `about ${percent}% of the call`;
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
