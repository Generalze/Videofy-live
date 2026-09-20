/** @author masterzee001 */
/**
 * The phone's end of progressive translated audio.
 *
 * The counterpart of `createWebAudioTranslatedSink`, and deliberately the same
 * shape of file: everything worth proving -- ordering, supersession,
 * cancellation, audibility -- already lives in
 * `ProgressiveTranslatedAudioPlayer` and is proved without a device. What is
 * left here is handing bytes to the platform, and the platform call itself is
 * injected so even that much is measurable in node.
 *
 * CONTIGUITY IS NOT RECONSTRUCTED HERE, and that is the difference from the web
 * sink. Web Audio has no queue, so the browser sink schedules each frame at the
 * exact time the previous one ends. AudioTrack in MODE_STREAM IS a queue: what
 * is written plays after what was written before it, with no gap, unless the
 * queue runs dry. So the whole job of this file is to write every frame once,
 * in the order it is given, and never to reorder, duplicate or pad.
 *
 * WHAT A DRY QUEUE SOUNDS LIKE, and why nothing here tries to hide it. If the
 * network stalls longer than the buffer, AudioTrack underruns and the next
 * frame is late rather than lost. Inserting silence to "keep time" would make a
 * stall sound like a word was spoken and missed; letting it arrive late makes
 * it sound like latency, which is what it is.
 */
import {
  TRANSLATED_AUDIO_SAMPLE_RATE,
  type TranslatedAudioSink,
} from '@videofy-live/call-client-core';
import { pcm16ToBase64 } from './pcmBase64';
import type { TranslatedPcmBackend } from '../native/translatedPcm';

export interface NativeTranslatedSink extends TranslatedAudioSink {
  /**
   * Release the track.
   *
   * `TranslatedAudioSink` has no teardown of its own -- a browser's
   * AudioContext is closed by whoever created it -- so the call's own lifetime
   * owns this. An AudioTrack left open holds an output stream and, on some
   * devices, the audio focus with it.
   */
  dispose(): void;
  /** True once the platform accepted an output. False means nothing can be heard. */
  readonly open: boolean;
}

export function createNativeTranslatedSink(
  backend: TranslatedPcmBackend,
  /**
   * Called with the first platform failure, and only failures. See `attempt`:
   * this is the sink's only way to say that translated audio stopped being
   * possible, because everything above it is a void call inside a socket
   * event.
   */
  onNativeError?: (error: string) => void,
): NativeTranslatedSink {
  /**
   * OPENED ON THE FIRST FRAME, not when the call starts.
   *
   * Same reason the web controller builds its sink lazily: a normal-mode call
   * never receives a frame, and an AudioTrack opened for it would hold an
   * output stream for the whole conversation for nothing.
   */
  let opened: boolean | null = null;
  let playedMs = 0;
  let disposed = false;
  /**
   * Set by the first platform call that THREW, as opposed to one that returned
   * a refusal. A returned `false`/`-1` is the platform answering; a throw means
   * the function on the other side is not the one this file was written
   * against -- the likeliest case being an APK whose Kotlin never compiled this
   * track, where the JS module resolves and its methods do not behave. That
   * does not heal, so it is latched: not calling it again fifty times a second
   * is the same argument by which a `false` from `open` is only tried once.
   */
  let broken = false;

  const failed = (what: string, error: unknown): void => {
    broken = true;
    onNativeError?.(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  };

  /**
   * EVERY CALL INTO THE PLATFORM GOES THROUGH HERE, and none of them may throw.
   *
   * `play` is invoked by the shared controller from inside socket.io's
   * synchronous event dispatch. A throw from native there does not degrade
   * translated audio -- it unwinds through the socket handler, which is the
   * call itself. So a frame that cannot be played is worth exactly a lost
   * frame and a diagnostic, and never the conversation.
   */
  const attempt = <T>(what: string, call: () => T, fallback: T): T => {
    if (broken) return fallback;
    try {
      return call();
    } catch (error) {
      failed(what, error);
      return fallback;
    }
  };

  const ensureOpen = (): boolean => {
    if (disposed || broken) return false;
    if (opened === null) {
      opened = attempt('translated audio open threw', () => backend.open(TRANSLATED_AUDIO_SAMPLE_RATE), false);
    }
    return opened;
  };

  return {
    play(samples: Int16Array, gain: number): void {
      if (samples.length === 0) return;
      if (!ensureOpen()) return;
      const accepted = attempt(
        'translated audio write threw',
        () => backend.write(pcm16ToBase64(samples, gain)),
        -1,
      );
      // A refusal is NOT counted as played. `playedMs` is what a diagnostic
      // reads to answer "did this phone actually make a sound", and a counter
      // that rises while the platform is rejecting every write answers it
      // wrongly in the one direction that matters.
      if (accepted < 0) return;
      playedMs += (samples.length / TRANSLATED_AUDIO_SAMPLE_RATE) * 1000;
    },

    flush(): number {
      // Only what has NOT been heard, which is the backend's number to give:
      // audio already presented is in somebody's ear and cannot be recalled.
      if (opened !== true || disposed) return 0;
      return attempt('translated audio flush threw', () => backend.flush(), 0);
    },

    get playedMs(): number {
      return playedMs;
    },

    get open(): boolean {
      return opened === true;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Closed even when `open` was never called: a backend that failed to open
      // may still hold a partially built track, and close is documented safe.
      //
      // ATTEMPTED EVEN AFTER A THROW, unlike the calls above, and caught here
      // rather than at the call site. `dispose` runs on the path that LEAVES a
      // call; a native throw on teardown must cost the track, not the person's
      // ability to hang up.
      try {
        backend.close();
      } catch (error) {
        failed('translated audio close threw', error);
      }
    },
  };
}
