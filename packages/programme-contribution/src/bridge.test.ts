/** @author masterzee001 */
/**
 * One clock, one encode, and what happens when the encoder cannot keep up.
 *
 * The failure this module exists to prevent does not throw and does not log.
 * It is lips that stop matching words some minutes into a broadcast, because
 * two callbacks each sampled the wall clock and their positions separated. So
 * the central assertion here is arithmetic rather than behavioural: after a
 * simulated stretch of real time, the audio position and the video position
 * describe the same moment.
 */
import { describe, expect, it } from 'vitest';
import {
  ProgrammeContributionBridge,
  type ContributionAudioFormat,
  type ContributionOutput,
  type ContributionVideoFormat,
} from './bridge.js';
import { ContributionClock, framesDueBy, samplesDueBy } from './clock.js';

const VIDEO: ContributionVideoFormat = { width: 320, height: 240, frameRate: 25 };
const AUDIO: ContributionAudioFormat = { sampleRate: 48_000, channels: 1 };
/** I420 is one byte of luma plus half a byte of chroma per pixel. */
const FRAME_BYTES = (VIDEO.width * VIDEO.height * 3) / 2;

function frame(fill = 1): Uint8Array {
  return new Uint8Array(FRAME_BYTES).fill(fill);
}

/** 10 ms of audio, which is what a WebRTC sink delivers at a time. */
function audioChunk(): Int16Array {
  return new Int16Array((AUDIO.sampleRate / 100) * AUDIO.channels).fill(1000);
}

function sink(): ContributionOutput & {
  readonly videoFrames: () => number;
  readonly audioSamples: () => number;
  ready: boolean;
} {
  let videoFrames = 0;
  let audioSamples = 0;
  return {
    ready: true,
    writeVideo() {
      videoFrames += 1;
    },
    writeAudio(samples) {
      audioSamples += samples.length;
    },
    videoFrames: () => videoFrames,
    audioSamples: () => audioSamples,
  };
}

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

describe('the clock both media read', () => {
  it('starts at zero and advances with real time', () => {
    const time = clock(5_000);
    const contribution = new ContributionClock(time.now);
    contribution.start();
    expect(contribution.elapsedMs()).toBe(0);
    time.advance(1_500);
    expect(contribution.elapsedMs()).toBe(1_500);
  });

  it('holds its position across an interruption rather than jumping the gap', () => {
    const time = clock();
    const contribution = new ContributionClock(time.now);
    contribution.start();
    time.advance(10_000);
    contribution.stop();

    // The contribution is gone for a minute. The programme did not advance a
    // minute: nothing was contributed to it.
    time.advance(60_000);
    expect(contribution.elapsedMs()).toBe(10_000);

    contribution.start();
    expect(contribution.elapsedMs()).toBe(10_000);
    time.advance(2_000);
    /*
     * A RECONNECT IS NOT A NEW BROADCAST. Restarting at zero would place the
     * returning contribution on top of material already published, and every
     * caption and advert positioned against those moments would point at the
     * wrong thing.
     */
    expect(contribution.elapsedMs()).toBe(12_000);
  });

  it('derives both positions from one number', () => {
    // Not two clocks that agree; one clock read twice.
    expect(framesDueBy(1_000, 25)).toBe(25);
    expect(samplesDueBy(1_000, 48_000)).toBe(48_000);
  });
});

describe('pacing into the encoder', () => {
  it('writes exactly as many frames as the clock says are due', () => {
    const time = clock();
    const out = sink();
    const bridge = new ProgrammeContributionBridge(out, { monotonic: time.now });
    bridge.begin();
    /*
     * Both media, because both is what a contribution carries -- and the
     * encoder's zero is decided once, for the pair. The pump below settles
     * that zero, exactly as production does by pumping every 10 ms.
     */
    bridge.pushAudio(audioChunk(), AUDIO);
    bridge.pushVideo(frame(), VIDEO);
    bridge.pump();

    for (let tick = 0; tick < 50; tick += 1) {
      bridge.pushVideo(frame(), VIDEO);
      bridge.pushAudio(audioChunk(), AUDIO);
      time.advance(40);
      bridge.pump();
    }
    // Two seconds at twenty-five frames a second.
    expect(out.videoFrames()).toBe(50);
  });

  it('repeats the last frame rather than falling behind the clock', () => {
    const time = clock();
    const out = sink();
    const bridge = new ProgrammeContributionBridge(out, { monotonic: time.now });
    bridge.begin();
    bridge.pushAudio(audioChunk(), AUDIO);
    bridge.pushVideo(frame(), VIDEO);
    // Settles the encoder's zero for both media together.
    bridge.pump();
    bridge.pushVideo(frame(), VIDEO);
    time.advance(40);
    bridge.pump();

    // The source stalls for half a second. The clock does not.
    time.advance(500);
    bridge.pump();

    /*
     * A frame short is a frame of drift, and the encoder derives its
     * timestamps from the count, so it never comes back. A freeze is visible
     * and honest; drift is neither.
     */
    expect(out.videoFrames()).toBe(framesDueBy(540, VIDEO.frameRate));
    expect(bridge.status().repeatedFrames).toBeGreaterThan(0);
  });

  it('pads audio with silence rather than leaving its position short', () => {
    const time = clock();
    const out = sink();
    const bridge = new ProgrammeContributionBridge(out, { monotonic: time.now });
    bridge.begin();
    bridge.pushVideo(frame(), VIDEO);
    bridge.pushAudio(audioChunk(), AUDIO);
    time.advance(10);
    bridge.pump();

    // Audio stops arriving for 200 ms.
    time.advance(200);
    bridge.pump();

    // Leaving it short moves audio earlier than video for the rest of the
    // broadcast.
    expect(bridge.status().paddedSamples).toBeGreaterThan(0);
    expect(out.audioSamples()).toBeGreaterThanOrEqual(samplesDueBy(200, AUDIO.sampleRate) * 0.9);
  });

  it('keeps audio and video describing the same moment over a long run', () => {
    /*
     * THE ASSERTION THIS FILE EXISTS FOR. Ten minutes of contribution with
     * both media arriving irregularly, and at the end the two positions must
     * still describe the same instant. Two clocks would agree for a while and
     * then separate, which is exactly why this is measured at the end rather
     * than at the start.
     */
    const time = clock();
    const out = sink();
    const bridge = new ProgrammeContributionBridge(out, { monotonic: time.now });
    bridge.begin();

    /*
     * ASYMMETRIC LOSS, which is what makes this test able to fail. A real
     * source loses video and audio at different rates -- a dropped frame is
     * not a dropped packet -- so an implementation that simply forwards what
     * arrives ends up with the two media short by DIFFERENT amounts. That
     * difference is the drift, and it only becomes visible over time.
     */
    let videoTick = 0;
    let audioTick = 0;
    for (let ms = 0; ms < 600_000; ms += 10) {
      if (ms % 40 === 0) {
        videoTick += 1;
        // One frame in ten never arrives.
        if (videoTick % 10 !== 0) bridge.pushVideo(frame(), VIDEO);
      }
      audioTick += 1;
      // One block in thirty-three never arrives.
      if (audioTick % 33 !== 0) bridge.pushAudio(audioChunk(), AUDIO);
      time.advance(10);
      bridge.pump();
    }

    const videoSeconds = out.videoFrames() / VIDEO.frameRate;
    const audioSeconds = out.audioSamples() / (AUDIO.sampleRate * AUDIO.channels);
    // Within one frame after ten minutes.
    expect(Math.abs(videoSeconds - audioSeconds)).toBeLessThan(1 / VIDEO.frameRate);
  });
});

describe('backpressure', () => {
  it('reports overload rather than dropping enough frames to look healthy', () => {
    const time = clock();
    const out = sink();
    const bridge = new ProgrammeContributionBridge(out, {
      monotonic: time.now,
      maxVideoFrames: 4,
    });
    bridge.begin();

    // The encoder is not being pumped; frames keep arriving.
    for (let i = 0; i < 20; i += 1) bridge.pushVideo(frame(), VIDEO);

    const status = bridge.status();
    /*
     * Discarding quietly would make an encoder that cannot cope look like a
     * healthy broadcast, and the audience would be the first to know.
     */
    expect(status.state).toBe('overloaded');
    expect(status.droppedFrames).toBeGreaterThan(0);
    expect(status.detail).toContain('not consuming');
  });

  it('never blocks the caller, because the caller is the gateway media thread', () => {
    const out = sink();
    const bridge = new ProgrammeContributionBridge(out, { maxVideoFrames: 2 });
    bridge.begin();
    // Anything slow here is slow for the TRUE LIVE audience too, who have
    // nothing to do with the protected one.
    expect(() => {
      for (let i = 0; i < 1000; i += 1) bridge.pushVideo(frame(), VIDEO);
    }).not.toThrow();
  });

  it('recovers once the encoder catches up', () => {
    const time = clock();
    const out = sink();
    const bridge = new ProgrammeContributionBridge(out, {
      monotonic: time.now,
      maxVideoFrames: 4,
    });
    bridge.begin();
    bridge.pushAudio(audioChunk(), AUDIO);
    bridge.pushVideo(frame(), VIDEO);
    bridge.pump();
    for (let i = 0; i < 20; i += 1) bridge.pushVideo(frame(), VIDEO);
    expect(bridge.status().state).toBe('overloaded');

    time.advance(2_000);
    bridge.pump();
    expect(bridge.status().state).toBe('running');
  });

  it('writes nothing while the destination is not ready', () => {
    const time = clock();
    const out = sink();
    out.ready = false;
    const bridge = new ProgrammeContributionBridge(out, { monotonic: time.now });
    bridge.begin();
    bridge.pushVideo(frame(), VIDEO);
    time.advance(200);
    bridge.pump();
    // Writing into a destination that is not draining is how a bounded queue
    // becomes an unbounded one somewhere else.
    expect(out.videoFrames()).toBe(0);
  });
});

describe('a source that changes shape', () => {
  it('reports a resolution change instead of feeding two sizes to one encoder', () => {
    const changes: ContributionVideoFormat[] = [];
    const bridge = new ProgrammeContributionBridge(sink(), {
      onFormatChange: (format) => changes.push(format),
    });
    bridge.begin();
    bridge.pushVideo(frame(), VIDEO);
    bridge.pushVideo(frame(), { ...VIDEO, width: 640, height: 480 });

    /*
     * A camera rotates, a screen share starts, bandwidth adaptation steps the
     * resolution down. Raw video input cannot carry two sizes, and pretending
     * it can produces a stream that decodes as noise.
     */
    expect(bridge.status().state).toBe('format-changed');
    expect(changes[0]?.width).toBe(640);
    expect(bridge.status().detail).toContain('320x240');
  });

  it('continues the broadcast clock across the new generation', () => {
    const time = clock();
    const out = sink();
    const bridge = new ProgrammeContributionBridge(out, { monotonic: time.now });
    bridge.begin();
    bridge.pushAudio(audioChunk(), AUDIO);
    bridge.pushVideo(frame(), VIDEO);
    bridge.pump();
    time.advance(30_000);
    bridge.pump();

    bridge.pushVideo(frame(), { ...VIDEO, width: 640, height: 480 });
    bridge.restartGeneration();

    /*
     * The encoder's counters reset because its output restarts at its own
     * zero. The CLOCK does not: the programme is thirty seconds in, and asking
     * the new encoder for thirty seconds of frames in one tick would be asking
     * it to replay the broadcast.
     */
    expect(bridge.status().elapsedMs).toBe(30_000);
    const before = out.videoFrames();
    /*
     * The new generation decides its own zero, for both media together, and
     * the pump that settles it writes nothing -- nothing is due at zero. The
     * frame due after that is the one asserted.
     */
    bridge.pushVideo(frame(), { ...VIDEO, width: 640, height: 480 });
    bridge.pushAudio(audioChunk(), AUDIO);
    bridge.pump();
    bridge.pushVideo(frame(), { ...VIDEO, width: 640, height: 480 });
    time.advance(40);
    bridge.pump();
    expect(out.videoFrames() - before).toBe(1);
  });
});

describe('a contribution that goes away', () => {
  it('is interrupted rather than failed, and keeps its position', () => {
    const time = clock();
    const bridge = new ProgrammeContributionBridge(sink(), { monotonic: time.now });
    bridge.begin();
    time.advance(20_000);
    bridge.interrupt('the broadcaster disconnected');

    expect(bridge.status().state).toBe('interrupted');
    time.advance(30_000);
    // The programme did not advance while nothing was contributed to it.
    expect(bridge.status().elapsedMs).toBe(20_000);
  });

  it('writes nothing while interrupted', () => {
    const time = clock();
    const out = sink();
    const bridge = new ProgrammeContributionBridge(out, { monotonic: time.now });
    bridge.begin();
    bridge.pushVideo(frame(), VIDEO);
    bridge.interrupt('gone');
    time.advance(5_000);
    bridge.pump();
    expect(out.videoFrames()).toBe(0);
  });

  it('stays failed once it has failed, rather than resuming into a broken encoder', () => {
    const bridge = new ProgrammeContributionBridge(sink());
    bridge.fail('the encoder exited');
    bridge.begin();
    expect(bridge.status().state).toBe('failed');
  });
});
