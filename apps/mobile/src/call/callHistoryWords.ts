/** @author masterzee001 */
/**
 * A finished call, as a line in the conversation.
 *
 * The account service records every direct call as a domain record (call id,
 * who, mode, when, outcome, who hung up, duration) and the chat timeline
 * carries it between the messages -- so "did they ring me while I was away?"
 * has an answer in the same place the messages are. This turns the record
 * into words from THIS reader's side: the same record is "Outgoing call" to
 * one person and "Incoming call" to the other.
 */
import { formatElapsed } from './callTimer';

/** The account service's vocabulary (call-records.ts); the gateway maps to it. */
export type CallHistoryOutcome =
  | 'completed'
  | 'missed'
  | 'declined'
  | 'busy'
  | 'unavailable'
  | 'network'
  | 'failed';

export interface CallHistoryEntry {
  readonly kind: 'call';
  readonly callId: string;
  readonly direction: 'outgoing' | 'incoming';
  readonly mode: 'normal' | 'translated';
  readonly outcome: CallHistoryOutcome | string;
  readonly durationSeconds: number | null;
  readonly createdAtMs: number;
  readonly endedAtMs: number | null;
  readonly endedByMe: boolean;
}

export interface CallHistoryWords {
  readonly title: string;
  readonly detail: string | null;
  /** A call this reader did not take: rendered with emphasis, like a phone does. */
  readonly missed: boolean;
}

export function callHistoryWords(entry: CallHistoryEntry): CallHistoryWords {
  const outgoing = entry.direction === 'outgoing';
  const kind = entry.mode === 'translated' ? 'translated call' : 'call';
  const duration =
    entry.durationSeconds !== null && entry.durationSeconds > 0
      ? formatElapsed(entry.durationSeconds * 1000)
      : null;
  switch (entry.outcome) {
    case 'completed':
      return {
        title: `${outgoing ? 'Outgoing' : 'Incoming'} ${kind}`,
        detail: duration ?? 'Ended',
        missed: false,
      };
    case 'missed':
      return outgoing
        ? { title: 'No answer', detail: null, missed: false }
        : { title: 'Missed call', detail: null, missed: true };
    case 'declined':
      return outgoing
        ? { title: 'Call declined', detail: null, missed: false }
        : { title: 'Declined call', detail: null, missed: false };
    case 'busy':
      return outgoing
        ? { title: 'Busy', detail: null, missed: false }
        : { title: 'Missed call', detail: 'you were on another call', missed: true };
    case 'unavailable':
      return outgoing
        ? { title: 'Couldn’t be reached', detail: null, missed: false }
        : { title: 'Missed call', detail: null, missed: true };
    case 'network':
      return { title: 'Call dropped', detail: duration, missed: false };
    case 'failed':
      return { title: 'Call failed', detail: null, missed: false };
    default:
      return { title: `${outgoing ? 'Outgoing' : 'Incoming'} ${kind}`, detail: duration, missed: false };
  }
}
