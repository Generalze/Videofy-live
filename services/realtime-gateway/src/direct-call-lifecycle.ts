/** @author masterzee001 */
/**
 * The direct-call lifecycle -- a telephone, owned by the server.
 *
 * A PUSH NOTIFICATION IS NOT THE CALL; it is only the mechanism that wakes
 * the other device (founder ruling 2026-08-28). Every word a caller reads
 * -- Calling, Ringing, Connecting, Connected, Busy, Declined, No answer,
 * Network issue, Ended -- comes from THIS state, broadcast to both sides,
 * never inferred from a push result or a video tile.
 *
 *   CALLING      the call exists; the peer's devices are being reached
 *   RINGING      at least one of the peer's devices ACKNOWLEDGED showing
 *                the incoming-call surface (a push being sent is not this)
 *   ANSWERED     the peer joined the session
 *   CONNECTING   media negotiating
 *   CONNECTED    two-way audio proven: the gateway has ROUTED frames from
 *                each participant to the other (device-independent truth)
 *   RECONNECTING a participant's media dropped; bounded recovery window
 *
 *   BUSY         the peer already has an active call (one per account)
 *   DECLINED     the peer pressed Decline
 *   NO_ANSWER    nobody accepted within the ringing window
 *   UNAVAILABLE  the ring reached no device at all
 *   NETWORK      the recovery window ran out
 *   ENDED        somebody hung up
 *
 * Pure with respect to time: `now` and timers are injected, so the machine
 * is tested without clocks. The runtime owns the side effects (rooms,
 * probes); this owns the truth.
 */

export type DirectCallState =
  | 'calling'
  | 'ringing'
  | 'answered'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'busy'
  | 'declined'
  | 'no_answer'
  | 'unavailable'
  | 'network'
  | 'ended';

export const TERMINAL_STATES: ReadonlySet<DirectCallState> = new Set([
  'busy',
  'declined',
  'no_answer',
  'unavailable',
  'network',
  'ended',
]);

/** Ringing window: nobody accepted -> NO ANSWER. Matches the push TTL. */
export const RINGING_WINDOW_MS = 30_000;
/** Media recovery window before a drop becomes a NETWORK failure. */
/**
 * A phone that changes network (wifi to data, a lift, a stairwell) needs
 * longer than twelve seconds to notice, reconnect the socket, resume its seat
 * and renegotiate both voice legs. Thirty is still short enough that a
 * caller is never left listening to silence for long.
 */
export const RECONNECT_WINDOW_MS = 30_000;

export interface DirectCallRecord {
  readonly callId: string;
  readonly callerAccountId: string;
  readonly peerAccountId: string;
  readonly callerName: string;
  readonly mode: 'normal' | 'translated';
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  state: DirectCallState;
  /** When the state last changed; for the T0..T11 timeline and staleness. */
  updatedAtMs: number;
  /** Devices the push reached, as the account service reported. -1 unknown. */
  reachedDevices: number;
  /** The timeline, metadata only: state -> when it was entered. */
  readonly timeline: { state: DirectCallState; atMs: number }[];
  /** When the peer joined; null until answered. */
  answeredAtMs: number | null;
  /** When two-way audio was first proven; the durable timer's origin. */
  connectedAtMs: number | null;
  /** Who hung up a completed call, when somebody did. */
  endedByAccountId: string | null;
}

export interface DirectCallWire {
  readonly callId: string;
  readonly state: DirectCallState;
  readonly mode: 'normal' | 'translated';
  readonly callerAccountId: string;
  readonly callerName: string;
  readonly peerAccountId: string;
  readonly expiresAtMs: number;
  readonly updatedAtMs: number;
  readonly answeredAtMs: number | null;
  /** The authoritative origin of the elapsed timer both screens show. */
  readonly connectedAtMs: number | null;
  readonly endedByAccountId: string | null;
}

/** What the account service keeps forever about a finished call. Metadata only. */
export interface DirectCallOutcomeRecord {
  readonly callId: string;
  readonly callerAccountId: string;
  readonly peerAccountId: string;
  readonly mode: 'normal' | 'translated';
  readonly createdAtMs: number;
  readonly answeredAtMs: number | null;
  readonly connectedAtMs: number | null;
  readonly endedAtMs: number;
  readonly outcome: 'completed' | 'missed' | 'declined' | 'busy' | 'unavailable' | 'network' | 'failed';
  readonly endedByAccountId: string | null;
}

export interface DirectCallLifecycleOptions {
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Every transition, for the room broadcast and the journal. */
  readonly onState?: (wire: DirectCallWire, previous: DirectCallState) => void;
  /** Every TERMINAL transition, once: the call-history record. */
  readonly onOutcome?: (record: DirectCallOutcomeRecord) => void;
}

export function toDirectCallWire(record: DirectCallRecord): DirectCallWire {
  return {
    callId: record.callId,
    state: record.state,
    mode: record.mode,
    callerAccountId: record.callerAccountId,
    callerName: record.callerName,
    peerAccountId: record.peerAccountId,
    expiresAtMs: record.expiresAtMs,
    updatedAtMs: record.updatedAtMs,
    answeredAtMs: record.answeredAtMs,
    connectedAtMs: record.connectedAtMs,
    endedByAccountId: record.endedByAccountId,
  };
}

function outcomeOf(state: DirectCallState): DirectCallOutcomeRecord['outcome'] {
  switch (state) {
    case 'ended':
      return 'completed';
    case 'no_answer':
      return 'missed';
    case 'declined':
      return 'declined';
    case 'busy':
      return 'busy';
    case 'unavailable':
      return 'unavailable';
    case 'network':
      return 'network';
    default:
      return 'failed';
  }
}

export class DirectCallLifecycle {
  private readonly calls = new Map<string, DirectCallRecord>();
  private readonly timers = new Map<string, unknown>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onState: DirectCallLifecycleOptions['onState'];
  private readonly onOutcome: DirectCallLifecycleOptions['onOutcome'];

  constructor(options: DirectCallLifecycleOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.onState = options.onState;
    this.onOutcome = options.onOutcome;
  }

  /**
   * A direct call was created. BUSY is decided HERE, before anybody rings:
   * `peerBusy` is the runtime's answer to "does the peer already hold a
   * connected seat anywhere" -- one active call per account.
   */
  create(input: {
    callId: string;
    callerAccountId: string;
    peerAccountId: string;
    callerName: string;
    mode: 'normal' | 'translated';
    peerBusy: boolean;
  }): DirectCallWire {
    const at = this.now();
    const record: DirectCallRecord = {
      callId: input.callId,
      callerAccountId: input.callerAccountId,
      peerAccountId: input.peerAccountId,
      callerName: input.callerName,
      mode: input.mode,
      createdAtMs: at,
      expiresAtMs: at + RINGING_WINDOW_MS,
      state: 'calling',
      updatedAtMs: at,
      reachedDevices: -1,
      timeline: [{ state: 'calling', atMs: at }],
      answeredAtMs: null,
      connectedAtMs: null,
      endedByAccountId: null,
    };
    this.calls.set(input.callId, record);
    if (input.peerBusy) {
      this.transition(record, 'busy');
      return toDirectCallWire(record);
    }
    this.arm(record, 'ringing-window', RINGING_WINDOW_MS, () => {
      if (record.state === 'calling' || record.state === 'ringing') {
        this.transition(record, record.reachedDevices === 0 ? 'unavailable' : 'no_answer');
      }
    });
    return toDirectCallWire(record);
  }

  get(callId: string): DirectCallWire | null {
    const record = this.calls.get(callId);
    return record ? toDirectCallWire(record) : null;
  }

  /** The caller's ring dispatch result. Zero devices is honest: UNAVAILABLE at once. */
  noteRingDispatch(callId: string, reachedDevices: number): void {
    const record = this.calls.get(callId);
    if (!record || TERMINAL_STATES.has(record.state)) return;
    record.reachedDevices = reachedDevices;
    if (reachedDevices === 0 && record.state === 'calling') this.transition(record, 'unavailable');
  }

  /** A peer device says it is SHOWING the incoming call. This is what Ringing means. */
  ringingAck(callId: string, accountId: string): boolean {
    const record = this.calls.get(callId);
    if (!record || record.peerAccountId !== accountId) return false;
    if (record.state === 'calling') this.transition(record, 'ringing');
    return !TERMINAL_STATES.has(record.state);
  }

  decline(callId: string, accountId: string): boolean {
    const record = this.calls.get(callId);
    if (!record || record.peerAccountId !== accountId) return false;
    if (record.state === 'calling' || record.state === 'ringing') {
      this.transition(record, 'declined');
      return true;
    }
    return false;
  }

  /** The peer joined the session: ANSWERED, then media negotiates. */
  peerJoined(callId: string, accountId: string): void {
    const record = this.calls.get(callId);
    if (!record || record.peerAccountId !== accountId) return;
    if (record.state === 'calling' || record.state === 'ringing') {
      this.disarm(record, 'ringing-window');
      record.answeredAtMs = this.now();
      this.transition(record, 'answered');
      this.transition(record, 'connecting');
    }
  }

  /**
   * The runtime's media probe: are frames routed in BOTH directions? True
   * moves CONNECTING/RECONNECTING to CONNECTED; false on a CONNECTED call
   * opens the recovery window.
   */
  noteTwoWayAudio(callId: string, twoWay: boolean): void {
    const record = this.calls.get(callId);
    if (!record) return;
    if (twoWay && (record.state === 'connecting' || record.state === 'reconnecting')) {
      this.disarm(record, 'reconnect-window');
      // The timer's origin is the FIRST connection; a reconnect resumes it.
      if (record.connectedAtMs === null) record.connectedAtMs = this.now();
      this.transition(record, 'connected');
      return;
    }
    if (!twoWay && record.state === 'connected') {
      this.transition(record, 'reconnecting');
      this.arm(record, 'reconnect-window', RECONNECT_WINDOW_MS, () => {
        if (record.state === 'reconnecting') this.transition(record, 'network');
      });
    }
  }

  /**
   * Somebody hung up, or the session tore down. A hang-up before anybody
   * answered is a cancelled ring, which the peer's history shows as a
   * missed call; after an answer it is a completed call ended by them.
   */
  ended(callId: string, endedByAccountId: string | null = null): void {
    const record = this.calls.get(callId);
    if (!record || TERMINAL_STATES.has(record.state)) return;
    record.endedByAccountId = endedByAccountId;
    this.transition(record, record.answeredAtMs !== null ? 'ended' : 'no_answer');
  }

  /** Terminal records linger for the pre-join check (stale push -> expired), then go. */
  forget(callId: string): void {
    const record = this.calls.get(callId);
    if (!record) return;
    this.disarm(record, 'ringing-window');
    this.disarm(record, 'reconnect-window');
    this.calls.delete(callId);
  }

  /**
   * The peer device's pre-join question: "should I ring for this?" Only a
   * live CALLING/RINGING call rings. A stale push that arrives after NO
   * ANSWER, DECLINED or ENDED gets 'expired' and must stay silent.
   */
  shouldRing(callId: string, accountId: string): 'ring' | 'expired' | 'unknown' {
    const record = this.calls.get(callId);
    if (!record || record.peerAccountId !== accountId) return 'unknown';
    return record.state === 'calling' || record.state === 'ringing' ? 'ring' : 'expired';
  }

  private transition(record: DirectCallRecord, next: DirectCallState): void {
    if (record.state === next) return;
    const previous = record.state;
    record.state = next;
    record.updatedAtMs = this.now();
    record.timeline.push({ state: next, atMs: record.updatedAtMs });
    if (TERMINAL_STATES.has(next)) {
      this.disarm(record, 'ringing-window');
      this.disarm(record, 'reconnect-window');
    }
    this.onState?.(toDirectCallWire(record), previous);
    if (TERMINAL_STATES.has(next)) {
      this.onOutcome?.({
        callId: record.callId,
        callerAccountId: record.callerAccountId,
        peerAccountId: record.peerAccountId,
        mode: record.mode,
        createdAtMs: record.createdAtMs,
        answeredAtMs: record.answeredAtMs,
        connectedAtMs: record.connectedAtMs,
        endedAtMs: record.updatedAtMs,
        outcome: outcomeOf(next),
        endedByAccountId: record.endedByAccountId,
      });
    }
  }

  private arm(record: DirectCallRecord, name: string, ms: number, fn: () => void): void {
    this.disarm(record, name);
    this.timers.set(`${record.callId} ${name}`, this.setTimer(fn, ms));
  }

  private disarm(record: DirectCallRecord, name: string): void {
    const key = `${record.callId} ${name}`;
    const handle = this.timers.get(key);
    if (handle !== undefined) {
      this.clearTimer(handle);
      this.timers.delete(key);
    }
  }
}
