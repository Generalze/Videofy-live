/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  elapsedSinceMs,
  formatCallClock,
  formatElapsed,
  observeServerClock,
} from '../call/callTimer';

describe('call timer', () => {
  it('measures the server clock offset once, from the first wire, and never again', () => {
    const first = observeServerClock(null, 1_000_000, 1_000_500);
    expect(first).toBe(500);
    // A resume ack minutes later carries an OLD updatedAtMs: the offset must not move.
    expect(observeServerClock(first, 1_000_000, 1_180_500)).toBe(500);
  });

  it('elapsed time follows the server origin on the phone clock, and survives a reconnect', () => {
    const offset = 500;
    const connectedAt = 1_000_000;
    expect(elapsedSinceMs(connectedAt, offset, 1_004_500)).toBe(4000);
    // Same origin re-delivered after a reconnect: the clock keeps counting.
    expect(elapsedSinceMs(connectedAt, offset, 1_120_500)).toBe(120_000);
  });

  it('never runs negative when clocks disagree', () => {
    expect(elapsedSinceMs(1_000_000, null, 999_000)).toBe(0);
  });

  it('formats like a phone: m:ss, then h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7_400)).toBe('0:07');
    expect(formatElapsed(252_000)).toBe('4:12');
    expect(formatElapsed(3_753_000)).toBe('1:02:33');
  });

  it('pads the CLOCK FACE, which is the largest type on the call screen', () => {
    /*
     * Set in tabular figures, and the board reads `03:48`. A clock that changes
     * width at ten minutes shifts the whole centred column sideways, which is
     * the one thing tabular numerals are chosen to prevent. The history list
     * keeps the unpadded form above: a duration inside a line of text.
     */
    expect(formatCallClock(0)).toBe('00:00');
    expect(formatCallClock(7_400)).toBe('00:07');
    expect(formatCallClock(228_000)).toBe('03:48');
    expect(formatCallClock(600_000)).toBe('10:00');
    expect(formatCallClock(3_753_000)).toBe('1:02:33');
  });
});
