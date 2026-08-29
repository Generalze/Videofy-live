/** @author masterzee001 */
/**
 * Call history -- a direct call is part of the relationship between two
 * accounts, exactly like a message or a voice note (founder ruling
 * 2026-08-29). It is a proper domain record, NOT a fake chat message: the
 * chat timeline renders these as system events ("Outgoing call · 4 min",
 * "Missed call", "Call declined"…) beside the messages, keyed by the same
 * sorted account pair.
 *
 * METADATA ONLY, by construction: ids, accounts, mode, timestamps, outcome,
 * who ended it, duration. No transcript, no audio, no diagnostics -- there
 * is no column for them.
 *
 * Written by the gateway's DirectCallLifecycle when a call reaches a
 * terminal state, over the internal token. Read by both participants as
 * part of their conversation.
 */
import { messagePair } from './message-store.js';

export type CallOutcome =
  | 'completed'
  | 'missed'
  | 'declined'
  | 'busy'
  | 'unavailable'
  | 'network'
  | 'failed';

export interface CallRecord {
  readonly callId: string;
  readonly lowAccountId: string;
  readonly highAccountId: string;
  readonly callerAccountId: string;
  readonly peerAccountId: string;
  readonly mode: 'normal' | 'translated';
  readonly createdAtMs: number;
  readonly answeredAtMs: number | null;
  readonly connectedAtMs: number | null;
  readonly endedAtMs: number;
  readonly outcome: CallOutcome;
  /** Who hung up a completed call; null when the network or nobody did. */
  readonly endedByAccountId: string | null;
  /** Connected seconds; 0 for anything that never connected. */
  readonly durationSeconds: number;
}

export interface CallRecordPort {
  upsert(record: CallRecord): Promise<void>;
  /** Newest first, bounded. */
  forPair(lowAccountId: string, highAccountId: string, limit: number): Promise<readonly CallRecord[]>;
}

export function createInMemoryCallRecordPort(): CallRecordPort {
  const rows = new Map<string, CallRecord>();
  return {
    async upsert(record) {
      rows.set(record.callId, record);
    },
    async forPair(low, high, limit) {
      return [...rows.values()]
        .filter((row) => row.lowAccountId === low && row.highAccountId === high)
        .sort((a, b) => b.endedAtMs - a.endedAtMs)
        .slice(0, limit);
    },
  };
}

/** Shape-check an ingest body from the gateway; null means refuse. */
export function parseCallRecord(body: unknown): CallRecord | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const str = (key: string): string | null => (typeof b[key] === 'string' && (b[key] as string).length > 0 ? (b[key] as string) : null);
  const num = (key: string): number | null => (typeof b[key] === 'number' && Number.isFinite(b[key] as number) ? (b[key] as number) : null);
  const callId = str('callId');
  const caller = str('callerAccountId');
  const peer = str('peerAccountId');
  const mode = b['mode'] === 'translated' ? 'translated' : b['mode'] === 'normal' ? 'normal' : null;
  const outcome = b['outcome'];
  const OUTCOMES: readonly CallOutcome[] = ['completed', 'missed', 'declined', 'busy', 'unavailable', 'network', 'failed'];
  const createdAtMs = num('createdAtMs');
  const endedAtMs = num('endedAtMs');
  if (
    callId === null || caller === null || peer === null || mode === null ||
    createdAtMs === null || endedAtMs === null ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(callId) ||
    !OUTCOMES.includes(outcome as CallOutcome)
  ) {
    return null;
  }
  const pair = messagePair(caller, peer);
  const connectedAtMs = num('connectedAtMs');
  const duration =
    connectedAtMs === null ? 0 : Math.max(0, Math.round((endedAtMs - connectedAtMs) / 1000));
  return {
    callId,
    lowAccountId: pair.low,
    highAccountId: pair.high,
    callerAccountId: caller,
    peerAccountId: peer,
    mode,
    createdAtMs,
    answeredAtMs: num('answeredAtMs'),
    connectedAtMs,
    endedAtMs,
    outcome: outcome as CallOutcome,
    endedByAccountId: str('endedByAccountId'),
    durationSeconds: duration,
  };
}

/** What a participant sees in their timeline: direction is relative to THEM. */
export function callRecordToWire(record: CallRecord, viewerAccountId: string): Record<string, unknown> {
  return {
    kind: 'call',
    callId: record.callId,
    direction: record.callerAccountId === viewerAccountId ? 'outgoing' : 'incoming',
    mode: record.mode,
    outcome: record.outcome,
    durationSeconds: record.durationSeconds,
    createdAtMs: record.createdAtMs,
    endedAtMs: record.endedAtMs,
    endedByMe: record.endedByAccountId === viewerAccountId,
  };
}
