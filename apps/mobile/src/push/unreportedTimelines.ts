/** @author masterzee001 */
/**
 * THE PUSH THAT ARRIVED AND RANG NOBODY, REPORTED WITHOUT A RING.
 *
 * THE GAP (27 Sep 2026 review). The native messaging service stamps
 * t4_push_received, the standby bucket and the battery exemption the moment
 * a call push arrives, and every exit from the ring path that is not a ring
 * now stamps t5_not_rung with a reason. But the only thing that SENT a
 * device timeline to the gateway was the call screen's teardown -- so the
 * one case those stamps exist for, a push that arrived and nothing rang,
 * reported nothing at all, because no call screen ever mounted. The
 * evidence for "it arrived and nothing rang" cannot depend on something
 * ringing.
 *
 * WHAT THIS DOES. At the next opportunity the app has -- a session exists,
 * or the app returns to the foreground -- every timeline still on the
 * device is read, posted to the gateway's timing route as the callee's,
 * and forgotten ONLY once the gateway has said it has it. A failed post
 * keeps the stamps for the time after. The existing path is untouched: a
 * call that did reach the screen still reports from the teardown, and it is
 * kept out of this sweep two ways -- a call on screen is excluded by id,
 * and a timeline younger than the ring window is left alone, so a ring that
 * is arriving as the sweep runs is not split across two reports.
 *
 * Pure over the two things it is handed: a store (the native bridge, or a
 * fake) and a reporter (ringTimeline.reportRingTimeline, or a fake). That
 * is what lets each rule be proven without a handset.
 */
import { reportRingTimeline, type RingTimeline } from '../call/ringTimeline';

/** What the sweep needs of the native layer; the bridge (native/videofyCall) satisfies it. */
export interface TimelineStore {
  pendingTimelines(): Record<string, RingTimeline>;
  forgetTimeline(callId: string): void;
}

export type TimelineReporter = (
  gatewayUrl: string,
  sessionToken: string | null,
  callId: string,
  timeline: RingTimeline,
  role: 'caller' | 'callee',
) => Promise<boolean>;

/**
 * A timeline whose newest stamp is younger than this is left for the next
 * sweep: it may belong to a ring that is under way right now, whose own
 * teardown will report it whole. The ring window is 30 to 45 s; this is
 * twice the longest.
 */
export const RING_SETTLE_MS = 90_000;

/** Stamps are epoch milliseconds; the readings beside them (bucket codes, reason codes) are small. */
const EPOCH_MS_FLOOR = 1_000_000_000_000;

/** The newest moment in a timeline, or null where it holds readings only. */
export function newestStampMs(timeline: RingTimeline): number | null {
  let newest: number | null = null;
  for (const value of Object.values(timeline)) {
    if (value >= EPOCH_MS_FLOOR && (newest === null || value > newest)) newest = value;
  }
  return newest;
}

/**
 * RingStore.notRung reason codes (Kotlin), transcribed. The Kotlin cannot be
 * run from this workstation; this table is where the mapping is proven, and
 * it is the key for reading `t5_not_rung_reason` off a gateway log line.
 */
export const NOT_RUNG_REASONS: Readonly<Record<number, string>> = {
  1: 'no bound ring credential on this phone',
  2: 'the gateway could not be reached',
  3: 'the ring credential was rejected',
  4: 'the call was no longer ringing',
  5: 'the ringing acknowledgement was refused',
  6: 'the push arrived after its ring window closed',
  7: 'Android refused to start the ring service',
};

export function notRungReason(code: number): string {
  return NOT_RUNG_REASONS[code] ?? `unknown reason code ${code}`;
}

export interface SweepInput {
  readonly store: TimelineStore;
  readonly gatewayUrl: string;
  readonly sessionToken: string | null;
  /** Calls on screen right now; their teardown reports them, so the sweep leaves them. */
  readonly liveCallIds: readonly string[];
  readonly now?: () => number;
  readonly report?: TimelineReporter;
}

export interface SweepOutcome {
  /** Reported and forgotten. */
  readonly sent: readonly string[];
  /** Left on the device: live, too young, or the gateway did not confirm. */
  readonly kept: readonly string[];
}

export async function flushUnreportedTimelines(input: SweepInput): Promise<SweepOutcome> {
  const sent: string[] = [];
  const kept: string[] = [];
  // No session, no report -- and no forgetting either: the stamps wait for one.
  if (input.sessionToken === null) return { sent, kept };
  const now = input.now ?? (() => Date.now());
  const report = input.report ?? reportRingTimeline;
  const live = new Set(input.liveCallIds);
  for (const [callId, timeline] of Object.entries(input.store.pendingTimelines())) {
    if (live.has(callId)) {
      kept.push(callId);
      continue;
    }
    if (Object.keys(timeline).length === 0) {
      // Nothing to say and nothing to wait for.
      input.store.forgetTimeline(callId);
      continue;
    }
    const newest = newestStampMs(timeline);
    if (newest !== null && now() - newest < RING_SETTLE_MS) {
      kept.push(callId);
      continue;
    }
    const recorded = await report(input.gatewayUrl, input.sessionToken, callId, timeline, 'callee');
    if (recorded) {
      input.store.forgetTimeline(callId);
      sent.push(callId);
    } else {
      kept.push(callId);
    }
  }
  return { sent, kept };
}
