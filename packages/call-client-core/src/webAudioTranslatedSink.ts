/**
 * The browser end of progressive translated audio.
 *
 * Deliberately the only file in this feature that touches an AudioContext, and
 * deliberately short. Everything worth proving -- ordering, supersession,
 * cancellation, audibility -- lives in `ProgressiveTranslatedAudioPlayer` and
 * is proved without a browser. What is left here is scheduling, which cannot
 * be, so it is kept small enough to read in one sitting.
 *
 * WHY NOT AN <audio> ELEMENT. The clip queue uses one, correctly: it plays
 * finished files at URLs. There is no URL here and no file -- frames arrive
 * every 20 ms while the sentence is still being synthesised. An element would
 * need a MediaSource and a container format wrapped around raw PCM, which is
 * three moving parts to avoid the one call Web Audio already provides.
 *
 * CONTIGUITY IS THE WHOLE JOB. Each frame is scheduled to start exactly where
 * the previous one ends, on the AudioContext's own clock. Scheduling every
 * frame at "now" instead would leave a hole wherever the network hiccuped, and
 * 20 ms holes at speech rate are heard as a stutter rather than as latency.
 */
import {
  TRANSLATED_AUDIO_SAMPLE_RATE,
  type TranslatedAudioSink,
} from './progressiveTranslatedAudio';

/** The subset of Web Audio this needs. Narrow, so a fake is honest and small. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  createGain(): GainNodeLike;
  readonly destination: AudioDestinationLike;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
  readonly duration: number;
}

export interface AudioBufferSourceLike {
  buffer: AudioBufferLike | null;
  connect(destination: unknown): void;
  disconnect(): void;
  start(when: number): void;
  stop(when?: number): void;
  /**
   * Typed as `unknown` so a real `AudioBufferSourceNode` is assignable.
   *
   * The DOM signature is `(this: AudioScheduledSourceNode, ev: Event) => any`,
   * which under strict function types is not assignable to a narrower
   * `() => void`. Widening here rather than casting at the call site keeps the
   * cast out of the app, where it would hide a real mismatch next time.
   */
  onended: unknown;
}

export interface GainNodeLike {
  readonly gain: { value: number };
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface AudioDestinationLike {
  readonly maxChannelCount?: number;
}

export interface WebAudioTranslatedSinkOptions {
  readonly context: AudioContextLike;
  /** Where to connect. Defaults to the context destination. */
  readonly destination?: unknown;
  /**
   * Scheduling cushion, in seconds.
   *
   * A frame scheduled for a moment that has already passed is played
   * immediately and out of position. A small lead absorbs the jitter between
   * the socket and the audio clock without adding latency anybody notices.
   */
  readonly leadSeconds?: number;
}

const DEFAULT_LEAD_SECONDS = 0.06;

export function createWebAudioTranslatedSink(
  options: WebAudioTranslatedSinkOptions,
): TranslatedAudioSink {
  const context = options.context;
  const lead = options.leadSeconds ?? DEFAULT_LEAD_SECONDS;
  const destination = options.destination ?? context.destination;
  let scheduledUntil = 0;
  let playedMs = 0;
  let live: AudioBufferSourceLike[] = [];

  return {
    play(samples: Int16Array, gain: number): void {
      if (samples.length === 0) return;
      const buffer = context.createBuffer(1, samples.length, TRANSLATED_AUDIO_SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) {
        // 32768 rather than 32767: the negative range is one larger, and
        // dividing by 32767 clips the loudest negative sample of every frame.
        channel[index] = samples[index]! / 32768;
      }

      const source = context.createBufferSource();
      source.buffer = buffer;
      const gainNode = context.createGain();
      gainNode.gain.value = gain;
      source.connect(gainNode);
      gainNode.connect(destination);

      const startAt = Math.max(context.currentTime + lead, scheduledUntil);
      source.start(startAt);
      scheduledUntil = startAt + buffer.duration;
      playedMs += (samples.length / TRANSLATED_AUDIO_SAMPLE_RATE) * 1000;

      live.push(source);
      source.onended = (): void => {
        live = live.filter((item) => item !== source);
        gainNode.disconnect();
        source.disconnect();
      };
    },

    flush(): number {
      // Only what has NOT been heard. Audio already past `currentTime` is in
      // somebody's ear and cannot be recalled, so it is not counted as
      // discarded -- claiming otherwise would overstate what cancelling does.
      const now = context.currentTime;
      const unheardSeconds = Math.max(0, scheduledUntil - now);
      for (const source of live) {
        try {
          source.stop(now);
        } catch {
          // Already ended. Stopping a finished source throws in some engines
          // and means exactly nothing.
        }
      }
      live = [];
      scheduledUntil = now;
      return Math.round(unheardSeconds * 1000);
    },

    get playedMs(): number {
      return playedMs;
    },
  };
}
