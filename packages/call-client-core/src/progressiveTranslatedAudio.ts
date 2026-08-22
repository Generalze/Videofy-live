/**
 * Playing translated speech while the sentence is still being made.
 *
 * The clip queue this sits beside plays FINISHED files: one URL per utterance,
 * fetched, decoded, played. That is the right shape for a programme somebody
 * uploaded and the wrong shape for a conversation, because a listener cannot
 * hear the first half of a sentence until the second half has been synthesised.
 * This consumes frames instead, and the first one is audible while the rest are
 * still being generated.
 *
 * IT IS NOT A REPLACEMENT FOR THE CLIP QUEUE. Both exist, for the same reason
 * batch and streaming transcription both exist: an uploaded programme genuinely
 * has a complete file, and pretending otherwise would make the simple case
 * harder for no benefit.
 *
 * WHAT THE PLATFORM DECIDES AND THIS OBEYS. Ordering, supersession and
 * cancellation are decided upstream and expressed in the frame itself --
 * `segmentId`, `generation`, `sequence`, `final`. Nothing here re-derives them
 * from arrival order, because arrival order is exactly what a network reorders.
 * A frame carrying an older generation than one already heard is dropped: the
 * platform has moved on, and playing it would say a sentence the speaker
 * withdrew.
 *
 * AUDIBILITY IS A SEPARATE QUESTION FROM ORDER, and both have to be answered.
 * `resolveSpeakerAudioMix` already decides whether translated audio may be
 * heard at all for a given listener and speaker -- translated, interpretation
 * or original -- and local mute and volume sit on top. A frame that is
 * correctly ordered and currently inaudible is DISCARDED rather than queued:
 * holding it would mean unmuting replays a sentence from the past.
 */

/** 16 kHz mono PCM16: the engine format, and the only thing this accepts. */
export const TRANSLATED_AUDIO_SAMPLE_RATE = 16000;

export interface ProgressiveTranslatedAudioFrame {
  readonly sessionId: string;
  /**
   * WHICH LANGUAGE this frame is.
   *
   * One utterance produces an independent stream per target language, all
   * sharing a `segmentId`. Ordering and supersession are therefore scoped to
   * (targetLanguage, segmentId) -- keyed on the segment alone, the Spanish and
   * French renderings of one sentence would each look like an out-of-order
   * duplicate of the other, and a listener would hear neither.
   */
  readonly targetLanguage: string;
  readonly segmentId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly segmentStartMs: number;
  readonly final: boolean;
  readonly sampleRate: number;
  readonly channelCount: number;
  /** Little-endian PCM16, base64. */
  readonly pcmBase64: string;
}

/**
 * Where decoded audio actually goes.
 *
 * Injected so every property above is provable without a browser, an
 * AudioContext, or a speaker. The browser implementation lives in
 * `createWebAudioTranslatedSink`, which is deliberately thin: it is the part
 * that cannot be tested this way, so it is kept small enough to read.
 */
export interface TranslatedAudioSink {
  /**
   * Schedule samples to play immediately after whatever is already scheduled.
   *
   * Contiguity is the sink's job and it matters: scheduling each frame "now"
   * would leave a gap wherever the network hiccuped, and 20 ms gaps at speech
   * rate sound like a stutter rather than like latency.
   */
  play(samples: Int16Array, gain: number): void;
  /** Drop everything not yet audible. Returns milliseconds discarded. */
  flush(): number;
  /** Milliseconds already handed to the output and unrecoverable. */
  readonly playedMs: number;
}

export type TranslatedFrameDisposition =
  | 'played'
  | 'dropped-inaudible'
  | 'dropped-superseded'
  | 'dropped-out-of-order'
  | 'dropped-duplicate'
  | 'dropped-cancelled'
  | 'dropped-malformed';

export interface ProgressiveTranslatedAudioState {
  readonly framesPlayed: number;
  readonly framesDropped: number;
  readonly activeSegmentId: string | null;
  readonly activeGeneration: number | null;
  readonly playedMs: number;
}

export interface ProgressiveTranslatedAudioOptions {
  readonly sink: TranslatedAudioSink;
  /**
   * May translated audio be heard right now?
   *
   * Takes the frame so a caller can answer per speaker: `resolveSpeakerAudioMix`
   * returns `translatedAudible`, and local mute belongs here too.
   */
  readonly isAudible: (frame: ProgressiveTranslatedAudioFrame) => boolean;
  /** Listener volume, 0..1, multiplied into the sink gain. */
  readonly volume?: () => number;
  readonly onDisposition?: (
    disposition: TranslatedFrameDisposition,
    frame: ProgressiveTranslatedAudioFrame,
  ) => void;
  readonly onStateChange?: (state: ProgressiveTranslatedAudioState) => void;
}

interface SegmentPlayback {
  generation: number;
  lastPlayed: number;
  seen: Set<number>;
  cancelled: boolean;
}

/**
 * The key a stream is ordered under.
 *
 * NUL separator, written as an escape: neither a language tag nor a segment id
 * can contain one, so the split is unambiguous by construction.
 */
function streamKey(frame: ProgressiveTranslatedAudioFrame): string {
  return `${frame.targetLanguage}\u0000${frame.segmentId}`;
}

export function decodePcm16Base64(base64: string): Int16Array {
  const binary = typeof atob === 'function' ? atob(base64) : bufferDecode(base64);
  const bytes = binary.length;
  if (bytes % 2 !== 0) {
    // Half a sample. Truncating shifts every later sample by one byte and the
    // rest of the sentence decodes as noise rather than speech.
    throw new Error('translated audio payload has an odd byte length');
  }
  const samples = new Int16Array(bytes / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    // Little-endian, stated rather than inherited from the host.
    const value = low | (high << 8);
    samples[index] = value >= 0x8000 ? value - 0x10000 : value;
  }
  return samples;
}

function bufferDecode(base64: string): string {
  // Node, for tests and server-side acceptance. Browsers take the atob path.
  const globalBuffer = (globalThis as { Buffer?: { from(v: string, e: string): { toString(e: string): string } } })
    .Buffer;
  if (globalBuffer === undefined) throw new Error('no base64 decoder available');
  return globalBuffer.from(base64, 'base64').toString('binary');
}

export class ProgressiveTranslatedAudioPlayer {
  /** Keyed by (targetLanguage, segmentId). See the frame's own doc. */
  private readonly segments = new Map<string, SegmentPlayback>();
  private framesPlayed = 0;
  private framesDropped = 0;
  private active: { segmentId: string; generation: number; key: string } | null = null;

  constructor(private readonly options: ProgressiveTranslatedAudioOptions) {}

  get state(): ProgressiveTranslatedAudioState {
    return {
      framesPlayed: this.framesPlayed,
      framesDropped: this.framesDropped,
      activeSegmentId: this.active?.segmentId ?? null,
      activeGeneration: this.active?.generation ?? null,
      playedMs: this.options.sink.playedMs,
    };
  }

  accept(frame: ProgressiveTranslatedAudioFrame): TranslatedFrameDisposition {
    if (
      frame.sampleRate !== TRANSLATED_AUDIO_SAMPLE_RATE ||
      frame.channelCount !== 1 ||
      !Number.isInteger(frame.sequence) ||
      frame.sequence < 0
    ) {
      // A frame in a format this player cannot render is refused rather than
      // resampled: guessing would make the wrong pitch sound like a bug in
      // synthesis, which is a long way from where the problem actually is.
      return this.settle('dropped-malformed', frame);
    }

    const key = streamKey(frame);
    const existing = this.segments.get(key);
    if (existing !== undefined && frame.generation < existing.generation) {
      // The platform has moved on. Playing this would speak a sentence the
      // speaker already withdrew.
      return this.settle('dropped-superseded', frame);
    }
    if (existing !== undefined && frame.generation > existing.generation) {
      // A newer attempt at the same sentence. Whatever of the old one has not
      // reached the speaker yet is abandoned, so the two cannot interleave.
      this.options.sink.flush();
      this.segments.set(key, {
        generation: frame.generation,
        lastPlayed: -1,
        seen: new Set(),
        cancelled: false,
      });
    }
    if (existing === undefined) {
      this.segments.set(key, {
        generation: frame.generation,
        lastPlayed: -1,
        seen: new Set(),
        cancelled: false,
      });
    }
    const state = this.segments.get(key)!;
    if (state.cancelled) return this.settle('dropped-cancelled', frame);
    if (state.seen.has(frame.sequence)) return this.settle('dropped-duplicate', frame);

    // ORDER IS ENFORCED, NOT ASSUMED. A frame that would jump a gap is dropped
    // rather than queued: on a live call, holding audio to wait for a frame
    // that may never arrive costs more than the syllable it would recover.
    if (frame.sequence !== state.lastPlayed + 1) {
      state.seen.add(frame.sequence);
      return this.settle('dropped-out-of-order', frame);
    }

    let samples: Int16Array;
    try {
      samples = decodePcm16Base64(frame.pcmBase64);
    } catch {
      return this.settle('dropped-malformed', frame);
    }

    state.seen.add(frame.sequence);
    state.lastPlayed = frame.sequence;

    if (!this.options.isAudible(frame)) {
      // Correctly ordered and currently inaudible. DISCARDED, not queued:
      // holding it would mean unmuting replays a sentence from the past.
      return this.settle('dropped-inaudible', frame);
    }

    const volume = this.options.volume?.() ?? 1;
    const gain = Math.max(0, Math.min(1, volume));
    if (gain === 0) return this.settle('dropped-inaudible', frame);

    this.active = { segmentId: frame.segmentId, generation: frame.generation, key };
    this.options.sink.play(samples, gain);
    this.framesPlayed += 1;
    this.emit();
    this.options.onDisposition?.('played', frame);
    if (frame.final) this.active = null;
    return 'played';
  }

  /**
   * Stop a segment.
   *
   * Returns milliseconds discarded, and only that: audio already handed to the
   * output is gone, and reporting it as cancelled would claim a control over
   * sound in somebody's ear that nothing has.
   */
  cancel(segmentId: string, targetLanguage?: string): number {
    // Without a language this withdraws the utterance in every language, which
    // is what a superseded sentence means. With one it stops a single
    // rendering.
    for (const [key, state] of this.segments) {
      const matches =
        targetLanguage === undefined
          ? key.endsWith(`\u0000${segmentId}`)
          : key === `${targetLanguage}\u0000${segmentId}`;
      if (matches) state.cancelled = true;
    }
    if (this.active?.segmentId !== segmentId) return 0;
    if (targetLanguage !== undefined && this.active.key !== `${targetLanguage}\u0000${segmentId}`) {
      return 0;
    }
    this.active = null;
    const discarded = this.options.sink.flush();
    this.emit();
    return discarded;
  }

  /** Everything stops: the call ended, or the listener left. */
  cancelAll(): number {
    for (const state of this.segments.values()) state.cancelled = true;
    this.active = null;
    const discarded = this.options.sink.flush();
    this.emit();
    return discarded;
  }

  private settle(
    disposition: TranslatedFrameDisposition,
    frame: ProgressiveTranslatedAudioFrame,
  ): TranslatedFrameDisposition {
    this.framesDropped += 1;
    this.options.onDisposition?.(disposition, frame);
    this.emit();
    return disposition;
  }

  private emit(): void {
    this.options.onStateChange?.(this.state);
  }
}
