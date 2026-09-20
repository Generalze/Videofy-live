/** @author masterzee001 */
/**
 * The one-second video tile, as an outcome test.
 *
 * THE DEFECT. On an audio-only call the remote video frame appeared for about
 * a second and vanished (founder report, twice). The callee's device timeline
 * from a real two-phone call on 18 Sep 2026 reads `video_remote_stream` then
 * `video_remote_null` about three seconds later, n=1 each, with
 * `video_inbound_frames: 0`: a tile shown for a track that never delivered a
 * frame. Three seconds is react-native-webrtc's own
 * `VideoTrackAdapter.INITIAL_MUTE_DELAY`, the point at which Android stops
 * claiming a freshly-announced remote track is unmuted and counts the frames
 * it has actually rendered.
 *
 * WHAT THESE ASSERT. What reached the SCREEN, and when -- never that a
 * particular guard exists or that a function was called. A test that pinned
 * the old publish-on-announce behaviour would have agreed with the defect and
 * passed for as long as it survived.
 */
import { describe, expect, it } from 'vitest';
import {
  createRemoteVideoGate,
  type GatedRemoteStream,
  type RemoteVideoVerdict,
} from '../call/remoteVideoGate';

const THEM = 'participant_them';
const OTHER = 'participant_other';

/** A stream is only ever a URL to the tile, so that is all a test one needs. */
function stream(url: string): GatedRemoteStream {
  return { toURL: () => url };
}

interface Painted {
  readonly participantId: string;
  /** null means the tile was CLEARED; a string means a picture was shown. */
  readonly url: string | null;
}

function harness() {
  const painted: Painted[] = [];
  const verdicts: RemoteVideoVerdict[] = [];
  /** Decoded frames per participant; absent means the peer is gone. */
  const frames = new Map<string, number>([[THEM, 0]]);
  /** Inbound bytes per participant; absent reads as zero. */
  const bytes = new Map<string, number>();
  /** Participants whose getStats does not answer: counters zero, unmeasured. */
  const unmeasurable = new Set<string>();
  const waiting: (() => void)[] = [];

  const gate = createRemoteVideoGate({
    inbound: async (participantId: string) => {
      if (unmeasurable.has(participantId)) return { frames: 0, bytes: 0, measured: false };
      const decoded = frames.get(participantId);
      if (decoded === undefined) return null;
      return { frames: decoded, bytes: bytes.get(participantId) ?? 0, measured: true };
    },
    show: (participantId: string, shown: GatedRemoteStream | null) => {
      painted.push({ participantId, url: shown === null ? null : shown.toURL() });
    },
    delay: () => new Promise<void>((resolve) => waiting.push(resolve)),
    report: (verdict) => verdicts.push(verdict),
  });

  /** Let every pending promise chain run to its next await. */
  const settle = async (): Promise<void> => {
    for (let pass = 0; pass < 6; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  /** Release one sampling interval, the way a real timer would. */
  const tick = async (count = 1): Promise<void> => {
    await settle();
    for (let step = 0; step < count; step += 1) {
      const next = waiting.shift();
      if (next === undefined) break;
      next();
      await settle();
    }
  };

  return { gate, painted, verdicts, frames, bytes, unmeasurable, tick, settle };
}

describe('a remote tile is shown only for video that is arriving', () => {
  it('shows nothing for a track announced before any frame has arrived', async () => {
    const { gate, painted, tick } = harness();

    gate.offer(THEM, stream('rtc://them'));
    await tick(4);

    // The founder's flash, and the whole point: the screen was never given a
    // stream, so there is nothing to take away again.
    expect(painted).toEqual([]);
    gate.dispose();
  });

  it('survives the platform mute that used to end the flash, without ever flashing', async () => {
    const { gate, painted, tick } = harness();

    // t=0: react-native-webrtc announces the track and reports it unmuted.
    gate.offer(THEM, stream('rtc://them'));
    await tick(6);
    // t~3s: Android counts zero rendered frames and mutes it, so the mesh
    // withdraws the stream. On the old path this pair was the flash.
    gate.offer(THEM, null);
    await tick(2);

    expect(painted.filter((entry) => entry.url !== null)).toEqual([]);
    gate.dispose();
  });

  it('shows the picture as soon as frames are being decoded', async () => {
    const { gate, painted, frames, settle } = harness();

    frames.set(THEM, 12);
    gate.offer(THEM, stream('rtc://them'));
    await settle();

    expect(painted).toEqual([{ participantId: THEM, url: 'rtc://them' }]);
    gate.dispose();
  });

  it('shows the picture when video starts later in the call', async () => {
    const { gate, painted, frames, tick } = harness();

    gate.offer(THEM, stream('rtc://them'));
    await tick(3);
    expect(painted).toEqual([]);

    // The other person turns their camera on; frames start being decoded.
    frames.set(THEM, 7);
    await tick(1);

    expect(painted).toEqual([{ participantId: THEM, url: 'rtc://them' }]);
    gate.dispose();
  });

  it('keeps waiting well past the fast window, so a late camera still gets a tile', async () => {
    const { gate, painted, frames, tick } = harness();

    gate.offer(THEM, stream('rtc://them'));
    // Far longer than the four-second close watch.
    await tick(30);
    expect(painted).toEqual([]);

    frames.set(THEM, 3);
    await tick(1);
    expect(painted).toEqual([{ participantId: THEM, url: 'rtc://them' }]);
    gate.dispose();
  });

  it('accepts inbound bytes as proof when the platform counts no frames', async () => {
    const { gate, painted, bytes, settle } = harness();

    // frames stays 0: a stats row whose inbound-rtp carries bytesReceived
    // but neither framesReceived nor framesDecoded.
    bytes.set(THEM, 5120);
    gate.offer(THEM, stream('rtc://them'));
    await settle();

    expect(painted).toEqual([{ participantId: THEM, url: 'rtc://them' }]);
    gate.dispose();
  });
});

describe('a phone that cannot measure is not a phone that receives nothing', () => {
  it('shows the stream on the platform word when getStats does not answer', async () => {
    const { gate, painted, verdicts, unmeasurable, settle } = harness();

    unmeasurable.add(THEM);
    gate.offer(THEM, stream('rtc://them'));
    await settle();

    // Failing closed here would be worse than the flash: no picture, ever.
    expect(painted).toEqual([{ participantId: THEM, url: 'rtc://them' }]);
    // And the timeline must not dress that up as a proven picture.
    expect(verdicts.some((verdict) => verdict.kind === 'live')).toBe(false);
    expect(verdicts.filter((verdict) => verdict.kind === 'unmeasured')).toEqual([
      { kind: 'unmeasured', participantId: THEM },
    ]);
    gate.dispose();
  });

  it('still clears an unmeasured tile when the mesh withdraws the stream', async () => {
    const { gate, painted, unmeasurable, settle } = harness();

    unmeasurable.add(THEM);
    gate.offer(THEM, stream('rtc://them'));
    await settle();
    gate.offer(THEM, null);

    expect(painted[painted.length - 1]).toEqual({ participantId: THEM, url: null });
    gate.dispose();
  });
});

describe('clearing a tile is never delayed or second-guessed', () => {
  it('clears at once when the mesh withdraws the stream', async () => {
    const { gate, painted, frames, settle } = harness();

    frames.set(THEM, 9);
    gate.offer(THEM, stream('rtc://them'));
    await settle();
    gate.offer(THEM, null);

    // Synchronously, before any settling: a tile left up for somebody who has
    // gone dark shows a frozen still of a person who believes they are hidden.
    expect(painted[painted.length - 1]).toEqual({ participantId: THEM, url: null });
  });

  it('does not put a withdrawn stream back when its frames arrive afterwards', async () => {
    const { gate, painted, frames, tick } = harness();

    gate.offer(THEM, stream('rtc://them'));
    await tick(2);
    gate.offer(THEM, null);
    frames.set(THEM, 40);
    await tick(4);

    expect(painted.filter((entry) => entry.url !== null)).toEqual([]);
    gate.dispose();
  });

  it('shows nothing once the call has been left', async () => {
    const { gate, painted, frames, tick } = harness();

    gate.offer(THEM, stream('rtc://them'));
    await tick(1);
    gate.dispose();
    frames.set(THEM, 99);
    await tick(4);

    expect(painted).toEqual([]);
  });

  it('gives up on a peer that has left the mesh', async () => {
    const { gate, painted, frames, tick } = harness();

    gate.offer(THEM, stream('rtc://them'));
    await tick(1);
    // No stats row at all: that seat's peer is gone.
    frames.delete(THEM);
    await tick(4);
    // And if the id were ever reused, the dead hold must not paint it.
    frames.set(THEM, 25);
    await tick(4);

    expect(painted).toEqual([]);
    gate.dispose();
  });
});

describe('each seat is judged on its own frames', () => {
  it('shows the one that is sending and not the one that is silent', async () => {
    const { gate, painted, frames, tick } = harness();

    frames.set(OTHER, 0);
    gate.offer(THEM, stream('rtc://them'));
    gate.offer(OTHER, stream('rtc://other'));
    await tick(2);
    frames.set(OTHER, 15);
    await tick(2);

    expect(painted).toEqual([{ participantId: OTHER, url: 'rtc://other' }]);
    gate.dispose();
  });

  it('shows the newest stream for a seat, never the superseded one', async () => {
    const { gate, painted, frames, tick } = harness();

    gate.offer(THEM, stream('rtc://first'));
    await tick(2);
    // A rebuilt peer re-announces; the first hold must not win the race.
    gate.offer(THEM, stream('rtc://second'));
    frames.set(THEM, 11);
    await tick(3);

    expect(painted).toEqual([{ participantId: THEM, url: 'rtc://second' }]);
    gate.dispose();
  });
});

describe('the timeline can tell a held tile from one that never existed', () => {
  it('records that a track was announced and that it never produced a picture', async () => {
    const { gate, verdicts, tick } = harness();

    gate.offer(THEM, stream('rtc://them'));
    await tick(12);

    expect(verdicts.some((verdict) => verdict.kind === 'offered')).toBe(true);
    const idle = verdicts.find((verdict) => verdict.kind === 'idle');
    expect(idle).toBeDefined();
    // Reported once, not once per sample: a timeline of repeats says nothing
    // the first one did not.
    expect(verdicts.filter((verdict) => verdict.kind === 'idle')).toHaveLength(1);
    gate.dispose();
  });

  it('records idle BEFORE the platform mute at 3 s withdraws the stream and ends the watch', async () => {
    const { gate, painted, verdicts, tick } = harness();

    // t=0: announced. Each tick is one 500 ms sample interval.
    gate.offer(THEM, stream('rtc://them'));
    // t=3000: Android's INITIAL_MUTE_DELAY elapses with no frames rendered,
    // the track mutes, and the mesh withdraws the stream.
    await tick(6);
    const idleBeforeWithdrawal = verdicts.filter((verdict) => verdict.kind === 'idle');
    gate.offer(THEM, null);
    await tick(4);

    // This is the device proof of the fix, and it has to be reachable on the
    // exact call it was built for: offered, then idle, and never a picture.
    expect(idleBeforeWithdrawal).toEqual([{ kind: 'idle', participantId: THEM, heldMs: 2000 }]);
    expect(verdicts.map((verdict) => verdict.kind)).toEqual(['offered', 'idle']);
    expect(painted.filter((entry) => entry.url !== null)).toEqual([]);
    gate.dispose();
  });

  it('records the frame and byte counts that earned a tile', async () => {
    const { gate, verdicts, frames, bytes, settle } = harness();

    frames.set(THEM, 18);
    bytes.set(THEM, 9000);
    gate.offer(THEM, stream('rtc://them'));
    await settle();

    expect(verdicts.filter((verdict) => verdict.kind === 'live')).toEqual([
      { kind: 'live', participantId: THEM, frames: 18, bytes: 9000 },
    ]);
    gate.dispose();
  });

  it('says nothing about idleness for a tile that went live', async () => {
    const { gate, verdicts, frames, tick } = harness();

    gate.offer(THEM, stream('rtc://them'));
    await tick(2);
    frames.set(THEM, 4);
    await tick(2);

    expect(verdicts.some((verdict) => verdict.kind === 'idle')).toBe(false);
    gate.dispose();
  });
});
