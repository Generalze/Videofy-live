/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import { callHistoryWords, type CallHistoryEntry } from '../call/callHistoryWords';

const base: CallHistoryEntry = {
  kind: 'call',
  callId: 'ring-1',
  direction: 'outgoing',
  mode: 'normal',
  outcome: 'completed',
  durationSeconds: 252,
  createdAtMs: 1_000,
  endedAtMs: 300_000,
  endedByMe: true,
};

describe('call history words', () => {
  it('a completed call names its direction and duration', () => {
    expect(callHistoryWords(base)).toEqual({ title: 'Outgoing call', detail: '4:12', missed: false });
    expect(callHistoryWords({ ...base, direction: 'incoming', mode: 'translated' })).toEqual({
      title: 'Incoming translated call',
      detail: '4:12',
      missed: false,
    });
  });

  it('the same record is "No answer" to the caller and "Missed call" to the callee', () => {
    const record = { ...base, outcome: 'missed', durationSeconds: null, endedAtMs: null };
    expect(callHistoryWords(record).title).toBe('No answer');
    expect(callHistoryWords(record).missed).toBe(false);
    const theirs = callHistoryWords({ ...record, direction: 'incoming' });
    expect(theirs.title).toBe('Missed call');
    expect(theirs.missed).toBe(true);
  });

  it('busy, declined, unavailable and dropped calls each read as what happened', () => {
    expect(callHistoryWords({ ...base, outcome: 'busy' }).title).toBe('Busy');
    expect(callHistoryWords({ ...base, outcome: 'declined' }).title).toBe('Call declined');
    expect(callHistoryWords({ ...base, outcome: 'unavailable' }).title).toBe('Couldn’t be reached');
    expect(callHistoryWords({ ...base, outcome: 'network' })).toEqual({
      title: 'Call dropped',
      detail: '4:12',
      missed: false,
    });
  });

  it('a failed call says so', () => {
    expect(callHistoryWords({ ...base, outcome: 'failed' }).title).toBe('Call failed');
  });

  it('a zero-length ended call says Ended rather than 0:00', () => {
    expect(callHistoryWords({ ...base, durationSeconds: 0 }).detail).toBe('Ended');
  });
});
