/** @author masterzee001 */
/**
 * What the phone's sink hands to the platform.
 *
 * The questions here are the ones AudioTrack cannot answer for itself: is every
 * sample handed over exactly once, in the order it was given, with nothing
 * invented in between, and does the sink stop touching an output it has
 * released. Whether the resulting sound is gapless is AudioTrack's job and
 * needs a handset; see the manual test plan.
 */
import { describe, expect, it } from 'vitest';
import { createNativeTranslatedSink } from '../call/nativeTranslatedSink';
import type { TranslatedPcmBackend } from '../native/translatedPcm';

interface FakeBackend extends TranslatedPcmBackend {
  readonly writes: string[];
  readonly opens: number[];
  closes: number;
  flushes: number;
  /** Every sample the platform was given, concatenated in write order. */
  samples(): number[];
}

function fakeBackend(
  options: { openSucceeds?: boolean; refuseWrites?: boolean; flushMs?: number } = {},
): FakeBackend {
  const writes: string[] = [];
  const opens: number[] = [];
  const backend: FakeBackend = {
    writes,
    opens,
    closes: 0,
    flushes: 0,
    open(sampleRate) {
      opens.push(sampleRate);
      return options.openSucceeds !== false;
    },
    write(pcmBase64) {
      if (options.refuseWrites === true) return -1;
      writes.push(pcmBase64);
      return Buffer.from(pcmBase64, 'base64').length;
    },
    flush() {
      backend.flushes += 1;
      return options.flushMs ?? 0;
    },
    queuedMs: () => 0,
    close() {
      backend.closes += 1;
    },
    samples() {
      const out: number[] = [];
      for (const write of writes) {
        const bytes = Buffer.from(write, 'base64');
        for (let index = 0; index + 1 < bytes.length; index += 2) out.push(bytes.readInt16LE(index));
      }
      return out;
    },
  };
  return backend;
}

describe('createNativeTranslatedSink', () => {
  it('opens no output until there is something to play', () => {
    // A normal-mode call never receives a frame, and an AudioTrack opened for
    // it would hold an output stream for the whole conversation for nothing.
    const backend = fakeBackend();
    const sink = createNativeTranslatedSink(backend);
    expect(backend.opens).toEqual([]);
    sink.play(Int16Array.from([1, 2, 3]), 1);
    expect(backend.opens).toEqual([16000]);
    sink.play(Int16Array.from([4]), 1);
    expect(backend.opens).toEqual([16000]);
  });

  it('hands over every sample once, in the order it was given', () => {
    const backend = fakeBackend();
    const sink = createNativeTranslatedSink(backend);
    sink.play(Int16Array.from([1, 2, 3]), 1);
    sink.play(Int16Array.from([4, 5]), 1);
    sink.play(Int16Array.from([6]), 1);
    expect(backend.samples()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(backend.writes.length).toBe(3);
  });

  it('writes nothing for an empty frame instead of a zero-length buffer', () => {
    const backend = fakeBackend();
    const sink = createNativeTranslatedSink(backend);
    sink.play(new Int16Array(0), 1);
    expect(backend.writes).toEqual([]);
    expect(backend.opens).toEqual([]);
  });

  it('counts only the audio the platform accepted', () => {
    const accepted = createNativeTranslatedSink(fakeBackend());
    // 320 samples at 16 kHz is exactly 20 ms.
    accepted.play(new Int16Array(320), 1);
    expect(accepted.playedMs).toBeCloseTo(20, 6);

    const refused = createNativeTranslatedSink(fakeBackend({ refuseWrites: true }));
    refused.play(new Int16Array(320), 1);
    // A counter that rises while every write is rejected answers "did this
    // phone make a sound" wrongly, in the one direction that matters.
    expect(refused.playedMs).toBe(0);
  });

  it('plays nothing at all when the device has no output to give', () => {
    const backend = fakeBackend({ openSucceeds: false });
    const sink = createNativeTranslatedSink(backend);
    sink.play(Int16Array.from([1, 2]), 1);
    sink.play(Int16Array.from([3, 4]), 1);
    expect(backend.writes).toEqual([]);
    expect(sink.open).toBe(false);
    // Tried once, not once per frame: a failing open is a device fact, not a
    // transient, and retrying it fifty times a second helps nobody.
    expect(backend.opens).toEqual([16000]);
  });

  it('reports the milliseconds the platform says it discarded', () => {
    const backend = fakeBackend({ flushMs: 240 });
    const sink = createNativeTranslatedSink(backend);
    sink.play(Int16Array.from([1, 2]), 1);
    expect(sink.flush()).toBe(240);
    expect(backend.flushes).toBe(1);
  });

  it('discards nothing when nothing was ever opened', () => {
    const backend = fakeBackend({ flushMs: 240 });
    const sink = createNativeTranslatedSink(backend);
    expect(sink.flush()).toBe(0);
    expect(backend.flushes).toBe(0);
  });

  it('releases the output once and stops using it', () => {
    const backend = fakeBackend();
    const sink = createNativeTranslatedSink(backend);
    sink.play(Int16Array.from([1, 2]), 1);
    sink.dispose();
    sink.dispose();
    expect(backend.closes).toBe(1);
    sink.play(Int16Array.from([3, 4]), 1);
    expect(backend.samples()).toEqual([1, 2]);
    expect(sink.flush()).toBe(0);
  });
});
