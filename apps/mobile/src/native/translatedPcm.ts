/** @author masterzee001 */
/**
 * The streaming PCM output, from JS.
 *
 * WHY A NATIVE AudioTrack AND NOT expo-audio. expo-audio plays a SOURCE -- a
 * URI, an asset, a recording -- and has no API that accepts raw samples. The
 * two ways to reach it from here are both worse than a native track:
 *
 *   a file per utterance  nothing is audible until the last frame of a
 *                         sentence has been synthesised, which throws away the
 *                         entire point of progressive frames. The 19 Sep
 *                         measurement was 305 frames over a 55-second call;
 *                         holding each sentence to its end would add the whole
 *                         synthesis tail to every reply.
 *   a file per frame      ~50 file creations and player loads a second, with a
 *                         player boundary -- so a gap -- every 20 ms. 20 ms
 *                         holes at speech rate are heard as a stutter.
 *
 * A hidden WebView running the existing `createWebAudioTranslatedSink` was the
 * other candidate and was rejected on ROUTING, not on effort: WebView audio
 * does not follow the voice-communication route this call sets (see
 * src/call/audioRoute.ts) and competes for audio focus with the call itself, so
 * translated speech would come out of the wrong speaker while Telecom owns the
 * call.
 *
 * AudioTrack in MODE_STREAM is the primitive Web Audio is built on, and it is a
 * contiguous queue by construction -- which is exactly the property
 * `TranslatedAudioSink.play` asks for. The web sink has to rebuild that
 * property by scheduling against a clock; here it is the default.
 *
 * LOADED OPTIONALLY, like src/native/videofyCall.ts. A dev client or an APK
 * built before this existed has no such functions, and must degrade to "no
 * translated audio on this build" rather than crash a call.
 */
import { requireOptionalNativeModule } from 'expo';

/**
 * What the sink needs from the platform. Narrow on purpose: everything above
 * it is then provable in node against a fake that is honest and small.
 */
export interface TranslatedPcmBackend {
  /** Idempotent. False means this device or build cannot play translated audio. */
  open(sampleRate: number): boolean;
  /** Queue samples. Returns bytes accepted; a negative number means refused. */
  write(pcmBase64: string): number;
  /** Discard what has not been heard yet. Returns milliseconds discarded. */
  flush(): number;
  /** Written but not yet presented, in milliseconds. */
  queuedMs(): number;
  /** Release the track. Safe when never opened. */
  close(): void;
}

interface NativeShape {
  translatedAudioOpen(sampleRate: number): boolean;
  translatedAudioWrite(pcmBase64: string): number;
  translatedAudioFlush(): number;
  translatedAudioQueuedMs(): number;
  translatedAudioClose(): void;
}

/**
 * The real backend, or null when this build cannot provide one.
 *
 * The function check is not paranoia about `requireOptionalNativeModule`: the
 * VideofyCall module has shipped in APKs since the ring work, so the module
 * resolves on an OLD build while these five functions do not exist on it.
 * Calling one would throw inside a live call.
 */
export function nativeTranslatedPcmBackend(): TranslatedPcmBackend | null {
  const native = requireOptionalNativeModule<NativeShape>('VideofyCall');
  if (native === null || typeof native.translatedAudioOpen !== 'function') return null;
  return {
    open: (sampleRate) => native.translatedAudioOpen(sampleRate),
    write: (pcmBase64) => native.translatedAudioWrite(pcmBase64),
    flush: () => native.translatedAudioFlush(),
    queuedMs: () => native.translatedAudioQueuedMs(),
    close: () => native.translatedAudioClose(),
  };
}
