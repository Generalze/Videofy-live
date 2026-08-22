/** @author masterzee001 */
/**
 * C-AI1.1D pins: who gets to name audio, and who gets to say it finished.
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_FRAME_SAMPLES,
  TranslatedAudioFramer,
} from '../translated-audio-framer.js';
import {
  MockStreamingSynthesisProvider,
  type StreamingSpeechSynthesisProvider,
  type StreamingSynthesisOptions,
  type StreamingSynthesisResult,
} from '../streaming-speech-synthesis-provider.js';
import { speakSegment } from '../speak-segment.js';
import { TranslatedAudioDelivery } from '../translated-audio-delivery.js';
import type { TranslatedAudioFrame } from '../translated-audio.js';

function collector() {
  const frames: TranslatedAudioFrame[] = [];
  return { frames, emit: (f: TranslatedAudioFrame) => { frames.push(f); } };
}

function framerRig(frameSamples = 4) {
  const sink = collector();
  return {
    ...sink,
    framer: new TranslatedAudioFramer({
      segmentId: 'seg_1', generation: 3, segmentStartMs: 1200,
      frameSamples, emit: sink.emit,
    }),
  };
}

describe('vendor chunk boundaries are not platform frame boundaries', () => {
  it('PIN: frames are the platform size regardless of how audio arrived', () => {
    const r = framerRig(4);
    // Three chunks whose sizes share no factor with the frame size.
    r.framer.push({ samples: Int16Array.from([1, 2, 3]) });
    r.framer.push({ samples: Int16Array.from([4, 5]) });
    r.framer.push({ samples: Int16Array.from([6, 7, 8, 9, 10]) });
    r.framer.finish();

    // If a vendor chunking leaked through, sequence numbers would mean
    // something different per vendor and the ordering guarantee would be
    // measured in units only that vendor understood.
    expect(r.frames.map((f) => Array.from(f.samples))).toEqual([
      [1, 2, 3, 4], [5, 6, 7, 8], [9, 10],
    ]);
  });

  it('PIN: sequence is dense from zero and identity is the platform own', () => {
    const r = framerRig(4);
    r.framer.push({ samples: new Int16Array(10).fill(7) });
    r.framer.finish();
    expect(r.frames.map((f) => f.sequence)).toEqual([0, 1, 2]);
    for (const frame of r.frames) {
      expect(frame.segmentId).toBe('seg_1');
      expect(frame.generation).toBe(3);
      expect(frame.segmentStartMs).toBe(1200);
      expect(frame.sampleRate).toBe(16000);
    }
  });

  it('the default frame is 20 ms at 16 kHz, matching the RTP path', () => {
    expect(PLATFORM_FRAME_SAMPLES).toBe(320);
  });
});

describe('finishing is a claim, made exactly once', () => {
  it('PIN: audio that divides evenly still ends with a final frame', () => {
    const r = framerRig(4);
    // Exactly two whole frames. The naive framer drains to empty here and
    // marks nothing final, so a completed sentence becomes indistinguishable
    // from a stream that merely stopped arriving.
    r.framer.push({ samples: new Int16Array(8).fill(1) });
    r.framer.finish();
    expect(r.frames.map((f) => f.final)).toEqual([false, true]);
    expect(r.frames.map((f) => f.samples.length)).toEqual([4, 4]);
  });

  it('PIN: the tail is emitted short rather than padded to a full frame', () => {
    const r = framerRig(4);
    r.framer.push({ samples: new Int16Array(6).fill(1) });
    r.framer.finish();
    // Padding would append silence the speaker never produced, which on a call
    // reads as the other person having stopped talking.
    expect(r.frames.at(-1)?.samples.length).toBe(2);
    expect(r.frames.filter((f) => f.final)).toHaveLength(1);
  });

  it('PIN: silence produces no frame at all', () => {
    const r = framerRig(4);
    expect(r.framer.finish()).toBe(0);
    // A zero-sample final frame would account for speech that never happened.
    expect(r.frames).toHaveLength(0);
  });

  it('PIN: nothing may follow a final frame', () => {
    const r = framerRig(4);
    r.framer.push({ samples: new Int16Array(6).fill(1) });
    r.framer.finish();
    // Admitting late audio would make `final` a suggestion.
    expect(() => r.framer.push({ samples: new Int16Array(4) })).toThrow(/after finish/);
  });

  it('PIN: abandoning emits no final frame and drops the buffered tail', () => {
    const r = framerRig(4);
    r.framer.push({ samples: new Int16Array(6).fill(1) });
    r.framer.abandon();
    expect(r.frames.filter((f) => f.final)).toHaveLength(0);
    expect(r.frames.map((f) => f.samples.length)).toEqual([4]);
  });

  it('finish is idempotent', () => {
    const r = framerRig(4);
    r.framer.push({ samples: new Int16Array(6).fill(1) });
    expect(r.framer.finish()).toBe(2);
    expect(r.framer.finish()).toBe(2);
    expect(r.frames).toHaveLength(2);
  });
});

function deliveryRig() {
  const delivered: TranslatedAudioFrame[] = [];
  const delivery = new TranslatedAudioDelivery({
    cancellationPolicy: 'immediate',
    deliver: (f) => { delivered.push(f); return true; },
  });
  return { delivery, delivered };
}

describe('speaking a segment wires the three parts in the one order that works', () => {
  it('PIN: the generation is opened before the first frame is offered', async () => {
    const r = deliveryRig();
    const outcome = await speakSegment({
      provider: new MockStreamingSynthesisProvider([100, 700, 33]),
      delivery: r.delivery,
      segmentId: 'seg_1', generation: 1, segmentStartMs: 0,
      text: 'hola', targetLanguage: 'es', voiceId: 'v1',
      frameSamples: 320, now: () => 0,
    });

    // Offering before beginGeneration is the silent failure this composition
    // exists to prevent: delivery correctly refuses frames for a segment nobody
    // opened, the sentence never plays, and every part reports success.
    expect(outcome.completed).toBe(true);
    expect(r.delivered.length).toBeGreaterThan(0);
    expect(r.delivered).toHaveLength(outcome.framesEmitted);
    expect(r.delivered.map((f) => f.sequence)).toEqual(
      r.delivered.map((_, index) => index),
    );
    // 833 samples at 320 per frame: two whole frames plus a 193-sample tail.
    expect(r.delivered.map((f) => f.samples.length)).toEqual([320, 320, 193]);
    expect(r.delivered.at(-1)?.final).toBe(true);
  });

  it('PIN: an aborted synthesis never claims the sentence was spoken', async () => {
    // Cut off MID-SENTENCE, with audio already buffered behind a frame
    // boundary. Aborting before any audio exists would prove nothing: there
    // would be no tail for a wrongly-finished framer to mark final.
    const cutOff: StreamingSpeechSynthesisProvider = {
      name: 'cut-off',
      synthesize: async (options: StreamingSynthesisOptions): Promise<StreamingSynthesisResult> => {
        options.onChunk({ samples: new Int16Array(500).fill(3) });
        return { samples: 500, timeToFirstChunkMs: 0, totalMs: 0, aborted: true };
      },
    };
    const r = deliveryRig();
    const outcome = await speakSegment({
      provider: cutOff, delivery: r.delivery,
      segmentId: 'seg_1', generation: 1, segmentStartMs: 0,
      text: 'hola', targetLanguage: 'es', voiceId: 'v1',
      frameSamples: 320, now: () => 0,
    });
    expect(outcome.completed).toBe(false);
    expect(outcome.aborted).toBe(true);
    // One whole frame went out and cannot be recalled. The 180-sample tail is
    // dropped, and nothing is marked final: a sentence cut short did not
    // finish being spoken, and saying it did would tell everything downstream
    // that a truncated translation is a complete one.
    expect(r.delivered.map((f) => f.samples.length)).toEqual([320]);
    expect(r.delivered.filter((f) => f.final)).toHaveLength(0);
  });

  it('PIN: a signal aborted before synthesis starts speaks nothing at all', async () => {
    const r = deliveryRig();
    const controller = new AbortController();
    controller.abort();
    const outcome = await speakSegment({
      provider: new MockStreamingSynthesisProvider([320, 320]),
      delivery: r.delivery,
      segmentId: 'seg_1', generation: 1, segmentStartMs: 0,
      text: 'hola', targetLanguage: 'es', voiceId: 'v1',
      signal: controller.signal, frameSamples: 320, now: () => 0,
    });
    expect(outcome.aborted).toBe(true);
    expect(r.delivered).toHaveLength(0);
  });

  it('PIN: a provider failure is returned, not thrown', async () => {
    const exploding: StreamingSpeechSynthesisProvider = {
      name: 'exploding',
      synthesize: async (options: StreamingSynthesisOptions): Promise<StreamingSynthesisResult> => {
        options.onChunk({ samples: new Int16Array(400).fill(5) });
        throw new Error('vendor 502');
      },
    };
    const r = deliveryRig();
    // One sentence failing on a live call must not take the call with it.
    const outcome = await speakSegment({
      provider: exploding, delivery: r.delivery,
      segmentId: 'seg_1', generation: 1, segmentStartMs: 0,
      text: 'hola', targetLanguage: 'es', voiceId: 'v1',
      frameSamples: 320, now: () => 0,
    });
    expect(outcome.failure).toBe('vendor 502');
    expect(outcome.completed).toBe(false);
    expect(r.delivered.filter((f) => f.final)).toHaveLength(0);
  });

  it('PIN: a second attempt supersedes the first rather than interleaving', async () => {
    const r = deliveryRig();
    await speakSegment({
      provider: new MockStreamingSynthesisProvider([640]),
      delivery: r.delivery,
      segmentId: 'seg_1', generation: 1, segmentStartMs: 0,
      text: 'Tuesday', targetLanguage: 'es', voiceId: 'v1',
      frameSamples: 320, now: () => 0,
    });
    const first = r.delivered.length;
    await speakSegment({
      provider: new MockStreamingSynthesisProvider([640]),
      delivery: r.delivery,
      segmentId: 'seg_1', generation: 2, segmentStartMs: 0,
      text: 'Wednesday', targetLanguage: 'es', voiceId: 'v1',
      frameSamples: 320, now: () => 0,
    });
    const second = r.delivered.slice(first);
    // Generation 2 restarts sequencing from 0 and is delivered on its own
    // terms; nothing from generation 1 is mixed into it.
    expect(second.map((f) => f.sequence)).toEqual([0, 1]);
    expect(new Set(second.map((f) => f.generation))).toEqual(new Set([2]));
  });

  it('records time to first frame, which is the number this wave moves', async () => {
    let clock = 0;
    const r = deliveryRig();
    const outcome = await speakSegment({
      provider: new MockStreamingSynthesisProvider([320, 320]),
      delivery: r.delivery,
      segmentId: 'seg_1', generation: 1, segmentStartMs: 0,
      text: 'hola', targetLanguage: 'es', voiceId: 'v1',
      frameSamples: 320, now: () => (clock += 5),
    });
    expect(outcome.timeToFirstFrameMs).not.toBeNull();
  });
});
