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

/**
 * `throwsOn` is the never-compiled Kotlin: the JS module resolves, the function
 * exists, and calling it throws. That is what an APK built without this native
 * track actually does, and it is the state the first device run is in.
 */
type NativeCall = 'open' | 'write' | 'flush' | 'close';

function fakeBackend(
  options: {
    openSucceeds?: boolean;
    refuseWrites?: boolean;
    flushMs?: number;
    throwsOn?: readonly NativeCall[];
  } = {},
): FakeBackend {
  const writes: string[] = [];
  const opens: number[] = [];
  const explode = (call: NativeCall): void => {
    if (options.throwsOn?.includes(call) === true) throw new Error(`native ${call} exploded`);
  };
  const backend: FakeBackend = {
    writes,
    opens,
    closes: 0,
    flushes: 0,
    open(sampleRate) {
      opens.push(sampleRate);
      explode('open');
      return options.openSucceeds !== false;
    },
    write(pcmBase64) {
      explode('write');
      if (options.refuseWrites === true) return -1;
      writes.push(pcmBase64);
      return Buffer.from(pcmBase64, 'base64').length;
    },
    flush() {
      backend.flushes += 1;
      explode('flush');
      return options.flushMs ?? 0;
    },
    queuedMs: () => 0,
    close() {
      backend.closes += 1;
      explode('close');
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

/**
 * A NATIVE FUNCTION THAT THROWS, which is what an APK whose Kotlin never
 * compiled this track does. `play` is called by the shared controller from
 * inside socket.io's synchronous dispatch, so a throw that escapes this file
 * unwinds through the socket handler -- it does not degrade translated audio,
 * it takes the call.
 */
describe('a platform that throws costs the audio, never the call', () => {
  it('survives a write that throws, and says why', () => {
    const backend = fakeBackend({ throwsOn: ['write'] });
    const errors: string[] = [];
    const sink = createNativeTranslatedSink(backend, (error) => errors.push(error));
    expect(() => sink.play(Int16Array.from([1, 2, 3]), 1)).not.toThrow();
    expect(errors).toEqual(['translated audio write threw: native write exploded']);
    // Nothing was heard, so nothing is claimed to have been.
    expect(sink.playedMs).toBe(0);
  });

  it('stops calling a platform that threw instead of retrying it per frame', () => {
    const backend = fakeBackend({ throwsOn: ['write'] });
    const errors: string[] = [];
    const sink = createNativeTranslatedSink(backend, (error) => errors.push(error));
    for (let frame = 0; frame < 5; frame += 1) sink.play(new Int16Array(320), 1);
    // Fifty frames a second, each one reported, would drown the timeline the
    // report exists to be read in. One failure, said once.
    expect(errors).toHaveLength(1);
    // And no OTHER call goes to the platform either. A flush is the one that
    // would: it is reached on every supersession, it is not on the play path,
    // and the sink still counts itself open.
    expect(sink.flush()).toBe(0);
    expect(backend.flushes).toBe(0);
  });

  it('survives an open that throws before a single frame is written', () => {
    const backend = fakeBackend({ throwsOn: ['open'] });
    const errors: string[] = [];
    const sink = createNativeTranslatedSink(backend, (error) => errors.push(error));
    expect(() => sink.play(Int16Array.from([1, 2]), 1)).not.toThrow();
    expect(sink.open).toBe(false);
    expect(backend.writes).toEqual([]);
    expect(errors).toEqual(['translated audio open threw: native open exploded']);
  });

  it('survives a close that throws, because that is the path out of a call', () => {
    const backend = fakeBackend({ throwsOn: ['close'] });
    const errors: string[] = [];
    const sink = createNativeTranslatedSink(backend, (error) => errors.push(error));
    sink.play(Int16Array.from([1, 2]), 1);
    expect(() => sink.dispose()).not.toThrow();
    expect(errors).toEqual(['translated audio close threw: native close exploded']);
  });

  it('still attempts the close after an earlier call threw', () => {
    // A track that refused a write may still exist and still hold an output
    // stream; the latch that stops retrying writes must not skip the release.
    const backend = fakeBackend({ throwsOn: ['write'] });
    const sink = createNativeTranslatedSink(backend, () => undefined);
    sink.play(Int16Array.from([1, 2]), 1);
    sink.dispose();
    expect(backend.closes).toBe(1);
  });

  it('needs no reporter to stay standing', () => {
    // The callback is optional; a sink built without one must still swallow.
    const sink = createNativeTranslatedSink(fakeBackend({ throwsOn: ['write', 'close'] }));
    expect(() => sink.play(Int16Array.from([1, 2]), 1)).not.toThrow();
    expect(() => sink.dispose()).not.toThrow();
  });
});
