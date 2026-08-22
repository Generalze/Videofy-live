/** @author masterzee001 */
/**
 * Speaking one segment: provider -> framer -> delivery, composed once.
 *
 * The composition is a file of its own because the ORDER of two of these steps
 * is load-bearing and easy to get wrong silently. `beginGeneration` has to
 * happen before the first frame is offered; if it does not, delivery correctly
 * refuses those frames as belonging to a segment nobody opened, the sentence
 * simply never plays, and every component involved reports success. Wiring that
 * can fail that quietly deserves to exist in one place with a test on it.
 *
 * Failures are RETURNED, not thrown. A synthesis failure is one sentence going
 * unspoken on a call that is still running -- the caller needs to decide
 * whether to retry, fall back to another provider, or let the caption stand
 * alone. An exception here would take the session down with the sentence.
 */
import {
  TranslatedAudioFramer,
  type TranslatedAudioFramerDeps,
} from './translated-audio-framer.js';
import type { StreamingSpeechSynthesisProvider } from './streaming-speech-synthesis-provider.js';
import type { TranslatedAudioDelivery } from './translated-audio-delivery.js';

export interface SpeakSegmentInput {
  readonly provider: StreamingSpeechSynthesisProvider;
  readonly delivery: TranslatedAudioDelivery;
  readonly segmentId: string;
  /** Which synthesis attempt this is. Higher supersedes lower. */
  readonly generation: number;
  readonly segmentStartMs: number;
  readonly text: string;
  readonly targetLanguage: string;
  readonly voiceId: string;
  readonly signal?: AbortSignal;
  readonly frameSamples?: TranslatedAudioFramerDeps['frameSamples'];
  readonly now?: () => number;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export interface SpeakSegmentOutcome {
  readonly framesEmitted: number;
  /** Reached a final frame: the sentence was spoken through to its end. */
  readonly completed: boolean;
  readonly aborted: boolean;
  readonly failure: string | null;
  /**
   * Time from the request to the first frame handed to delivery.
   *
   * The number this wave exists to move. Time-to-complete-file was already
   * acceptable; this is what a listener experiences as the pause before the
   * translation starts.
   */
  readonly timeToFirstFrameMs: number | null;
}

export async function speakSegment(input: SpeakSegmentInput): Promise<SpeakSegmentOutcome> {
  const now = input.now ?? Date.now;
  const started = now();
  let timeToFirstFrameMs: number | null = null;

  // BEFORE any frame exists. Opening the generation is what makes this
  // attempt's frames legible to delivery and the previous attempt's stale.
  input.delivery.beginGeneration(input.segmentId, input.generation);

  const framer = new TranslatedAudioFramer({
    segmentId: input.segmentId,
    generation: input.generation,
    segmentStartMs: input.segmentStartMs,
    ...(input.frameSamples === undefined ? {} : { frameSamples: input.frameSamples }),
    emit: (frame) => {
      if (timeToFirstFrameMs === null) timeToFirstFrameMs = now() - started;
      input.delivery.offer(frame);
    },
  });

  let providerError: string | null = null;
  let aborted = false;

  try {
    const result = await input.provider.synthesize({
      text: input.text,
      targetLanguage: input.targetLanguage,
      voiceId: input.voiceId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onChunk: (chunk) => framer.push(chunk),
      onError: (error) => {
        providerError ??= error.message;
      },
    });
    aborted = result.aborted || input.signal?.aborted === true;
  } catch (error) {
    providerError ??= error instanceof Error ? error.message : 'synthesis failed';
  }

  if (providerError !== null || aborted) {
    // No final frame. A sentence that was cut short did not finish being
    // spoken, and marking it final would tell everything downstream that a
    // truncated translation is a complete one.
    framer.abandon();
    input.log?.('segment not spoken through', {
      segmentId: input.segmentId,
      generation: input.generation,
      aborted,
      failure: providerError,
    });
    return {
      framesEmitted: framer.framesEmitted,
      completed: false,
      aborted,
      failure: providerError,
      timeToFirstFrameMs,
    };
  }

  framer.finish();
  return {
    framesEmitted: framer.framesEmitted,
    completed: framer.framesEmitted > 0,
    aborted: false,
    failure: framer.framesEmitted > 0 ? null : 'synthesis produced no audio',
    timeToFirstFrameMs,
  };
}
