/** @author masterzee001 */
/**
 * THE VIDEO DEFECT, AS ARITHMETIC.
 *
 * MEASURED ON TWO REAL PHONES. Turning the camera on about fifty seconds into
 * a settled call worked: 52 frames arrived. Turning it on early failed: 621
 * frames left one side and none reached the other, with the peer closed four
 * times, rebuilt three times and RECOVERED ZERO.
 *
 * The watch caused it. It gave a peer two seconds to produce frames and then
 * rebuilt it, testing nothing but `outboundFrames === 0`. A peer still
 * negotiating is indistinguishable from one that is connected and mute, and
 * negotiation through a relay routinely takes longer than two seconds -- so
 * the remedy fired on a HEALTHY connection, the rebuild restarted the very
 * negotiation it was waiting for, and it did that until it gave up.
 *
 * Both signals it needed were already on the row and both were ignored.
 */
import { describe, expect, it } from 'vitest';
import {
  SILENT_SAMPLES,
  allMoving,
  isMoving,
  nextSilenceStreak,
  peersThatNeverConnected,
  peersToRebuild,
  type VideoPeerSample,
} from '../call/videoSilenceWatch';

function peer(over: Partial<VideoPeerSample> = {}): VideoPeerSample {
  return {
    participantId: 'them',
    connectionState: 'connected',
    outboundFrames: 0,
    outboundBytes: 0,
    measured: true,
    ...over,
  };
}

/** Run n samples of one peer's history and return the streak it ends on. */
function streakAfter(samples: readonly VideoPeerSample[]): number {
  return samples.reduce((streak, row) => nextSilenceStreak(streak, row), 0);
}

describe('a peer that has not connected is not silent', () => {
  it('NEVER counts silence while the peer is still negotiating', () => {
    /*
     * THE DEFECT, DIRECTLY. Twelve seconds of an ordinary relayed handshake --
     * far longer than the two seconds the old watch allowed -- and not one
     * sample may count against it.
     */
    for (const state of ['new', 'connecting', 'checking']) {
      const history = Array.from({ length: 24 }, () => peer({ connectionState: state }));
      expect(streakAfter(history), state).toBe(0);
    }
  });

  it('WILL NOT rebuild a peer that is still negotiating, however long it takes', () => {
    const rows = [peer({ connectionState: 'connecting' })];
    const streaks = new Map([['them', 99]]);
    expect(peersToRebuild(rows, streaks, new Set())).toEqual([]);
  });

  it('starts the clock when the peer CONNECTS, not when the camera opened', () => {
    // Eight samples of negotiating, then four connected and silent. Only the
    // last four count, and they are exactly enough.
    const history = [
      ...Array.from({ length: 8 }, () => peer({ connectionState: 'connecting' })),
      ...Array.from({ length: SILENT_SAMPLES }, () => peer()),
    ];
    expect(streakAfter(history)).toBe(SILENT_SAMPLES);
    expect(peersToRebuild([peer()], new Map([['them', SILENT_SAMPLES]]), new Set())).toEqual(['them']);
  });
});

describe('counters that were never read are not counters that read zero', () => {
  it('does not count a sample the stats call did not answer', () => {
    // `measured: false` says so in its own comment on the row type. Treating
    // it as silence is how a peer gets rebuilt for a getStats hiccup.
    const history = Array.from({ length: 10 }, () => peer({ measured: false }));
    expect(streakAfter(history)).toBe(0);
  });
});

describe('the streak is consecutive, so a peer that recovers is forgiven', () => {
  it('resets when frames move', () => {
    const history = [peer(), peer(), peer({ outboundFrames: 3 }), peer()];
    expect(streakAfter(history)).toBe(1);
  });

  it('resets when the peer drops, so half a verdict is not carried across a gap', () => {
    const history = [peer(), peer(), peer({ connectionState: 'disconnected' }), peer()];
    expect(streakAfter(history)).toBe(1);
  });
});

describe('a connected peer that really is silent is rebuilt, once', () => {
  it('is rebuilt once the streak is reached', () => {
    const streaks = new Map([['them', SILENT_SAMPLES]]);
    expect(peersToRebuild([peer()], streaks, new Set())).toEqual(['them']);
  });

  it('is NOT rebuilt one sample early', () => {
    const streaks = new Map([['them', SILENT_SAMPLES - 1]]);
    expect(peersToRebuild([peer()], streaks, new Set())).toEqual([]);
  });

  it('is never rebuilt twice in one camera activation', () => {
    /*
     * The bound the CTO ruled on 3 Sep, now measured rather than read off the
     * source. The rebuild is a remedy, not a retry loop: three rebuilds that
     * each restart negotiation are worse than one, and the production failure
     * did exactly that.
     */
    const streaks = new Map([['them', 99]]);
    expect(peersToRebuild([peer()], streaks, new Set(['them']))).toEqual([]);
  });

  it('judges each peer on its own history', () => {
    const rows = [peer({ participantId: 'a' }), peer({ participantId: 'b', connectionState: 'connecting' })];
    const streaks = new Map([['a', SILENT_SAMPLES], ['b', SILENT_SAMPLES]]);
    expect(peersToRebuild(rows, streaks, new Set())).toEqual(['a']);
  });
});

describe('a peer that never connected is reported, not rebuilt', () => {
  it('names it once the deadline passes', () => {
    const rows = [peer({ connectionState: 'failed' })];
    expect(peersThatNeverConnected(rows, new Set(), new Set())).toEqual(['them']);
  });

  it('says nothing about a peer that did connect', () => {
    expect(peersThatNeverConnected([peer()], new Set(['them']), new Set())).toEqual([]);
  });

  it('does not also report one it already rebuilt', () => {
    const rows = [peer({ connectionState: 'failed' })];
    expect(peersThatNeverConnected(rows, new Set(), new Set(['them']))).toEqual([]);
  });
});

describe('the watch finishes when video is actually moving', () => {
  it('is satisfied only when EVERY peer is sending', () => {
    expect(allMoving([peer({ outboundFrames: 1 }), peer({ participantId: 'b' })])).toBe(false);
    expect(allMoving([peer({ outboundFrames: 1 }), peer({ participantId: 'b', outboundBytes: 90 })])).toBe(true);
  });

  it('is never satisfied by an empty mesh, which has proven nothing', () => {
    expect(allMoving([])).toBe(false);
  });

  it('counts bytes as movement even before a whole frame is counted', () => {
    expect(isMoving(peer({ outboundBytes: 1 }))).toBe(true);
  });
});
