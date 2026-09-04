/** @author masterzee001 */
/**
 * A finished call, as a line in the conversation -- the web twin of the
 * phone's `callHistoryWords`. The account service records every direct call
 * (id, who, mode, when, outcome, who hung up, duration) and the timeline
 * carries it between the messages; this turns the record into words from
 * THIS reader's side.
 */

export interface WireCallEntry {
  readonly kind: 'call';
  readonly callId: string;
  readonly direction: 'outgoing' | 'incoming';
  readonly mode: 'normal' | 'translated';
  readonly outcome: string;
  readonly durationSeconds: number | null;
  readonly createdAtMs: number;
  readonly endedAtMs: number | null;
  readonly endedByMe: boolean;
}

export function formatCallDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

export function callHistoryWords(entry: WireCallEntry): {
  readonly title: string;
  readonly detail: string | null;
  readonly missed: boolean;
} {
  const outgoing = entry.direction === 'outgoing';
  const kind = entry.mode === 'translated' ? 'translated call' : 'call';
  const duration =
    entry.durationSeconds !== null && entry.durationSeconds > 0
      ? formatCallDuration(entry.durationSeconds)
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
