/** @author masterzee001 */
/**
 * The direct-call state machine: state from call state, never from tiles.
 */
import { describe, expect, it } from 'vitest';
import { directCallPhase, directCallWords } from '../call/callPhase';

const base = {
  joined: true,
  joinFailed: false,
  rang: 1,
  others: 0,
  receiveState: 'new',
  ended: false,
};

describe('directCallPhase', () => {
  it('is DIALING until the join ack is read', () => {
    expect(directCallPhase({ ...base, joined: false, rang: null })).toBe('dialing');
  });

  it('is CALLING once the ring was dispatched -- devices reached is not an answer', () => {
    expect(directCallPhase({ ...base, rang: 3 })).toBe('calling');
  });

  it('leaves CALLING the moment the callee JOINS, whatever the media is doing', () => {
    // The old screen waited for a video tile; an audio-only callee could join
    // and the caller would stare at "Ringing" forever.
    expect(directCallPhase({ ...base, others: 1, receiveState: 'connecting' })).toBe('answered');
  });

  it('is CONNECTED when their voice leg is up', () => {
    expect(directCallPhase({ ...base, others: 1, receiveState: 'connected' })).toBe('connected');
  });

  it('an answer outranks a failed or empty ring', () => {
    expect(directCallPhase({ ...base, rang: 0, others: 1, receiveState: 'connected' })).toBe(
      'connected',
    );
    expect(directCallPhase({ ...base, rang: -1, others: 1 })).toBe('answered');
  });

  it('is UNAVAILABLE when the ring reached nobody and nobody joined', () => {
    expect(directCallPhase({ ...base, rang: 0 })).toBe('unavailable');
    expect(directCallPhase({ ...base, rang: -1 })).toBe('unavailable');
  });

  it('FAILED and ENDED are terminal', () => {
    expect(directCallPhase({ ...base, joined: false, joinFailed: true })).toBe('failed');
    expect(directCallPhase({ ...base, others: 1, ended: true })).toBe('ended');
  });
});

describe('directCallWords', () => {
  it('names the person and never a code', () => {
    for (const phase of [
      'dialing',
      'calling',
      'answered',
      'connecting',
      'connected',
      'unavailable',
      'failed',
      'ended',
    ] as const) {
      const words = directCallWords(phase, 'Zoe');
      expect(words).not.toMatch(/code|ring-/iu);
    }
    expect(directCallWords('unavailable', 'Zoe')).toContain('Zoe');
    expect(directCallWords('calling', 'Zoe')).toBe('Calling Zoe…');
  });
});
