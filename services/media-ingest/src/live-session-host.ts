/** @author masterzee001 */
/**
 * One live stream, whole: audio in, captions and translated speech out.
 *
 * This is what `openStream` hands back, and it is the only place in the live
 * path where the two halves meet. Keeping the join here rather than inside
 * either pipeline means each half stays provable on its own -- transcription
 * without a synthesiser, synthesis without a recogniser -- while the ORDER
 * they run in, which is the part that silently breaks, has one home and a test.
 *
 * TRANSCRIPT EVENTS FAN OUT TWICE, and the two destinations want opposite
 * things:
 *
 *   captions   want partials, because a caption that appears late is worse
 *              than one that gets corrected
 *   speech     wants finals only, because a sentence somebody has heard
 *              cannot be corrected at all
 *
 * So `onCaption` sees everything and the translation pipeline sees finals. The
 * filter lives inside the translation pipeline rather than here, so a future
 * caller cannot forget it.
 */
import type {
  IngressOpen,
  IngressTranslatedAudio,
  RealtimeServiceContext,
} from '@videofy-live/media-ingress-wire';
import type { IngressStreamHandler, IngressStreamSender } from './realtime-ingress-connection.js';
import { LiveStreamPipeline, type LiveStreamPipelineDeps } from './live-stream-pipeline.js';
import {
  LiveTranslationPipeline,
  type LiveTranslationPipelineDeps,
} from './live-translation-pipeline.js';
import type { StreamingSpeechSynthesisProvider } from './streaming-speech-synthesis-provider.js';
import type { StreamingTranscriptionProvider } from './streaming-transcription-provider.js';
import type { TimestampedTranslationProvider } from './translation-provider.js';
import type { TranscriptEvent } from './transcript-event.js';

export interface LiveSessionHostDeps {
  readonly transcription: StreamingTranscriptionProvider;
  readonly translation: TimestampedTranslationProvider;
  /** Null means captions only: nothing is translated into speech. */
  readonly synthesis: StreamingSpeechSynthesisProvider | null;
  readonly mintSegmentId: (open: IngressOpen) => string;
  /**
   * What this stream translates into, decided by the platform per session.
   *
   * Returning null means captions only: a target language with no listener
   * wanting audio must not reach synthesis, and must not silently fall back to
   * a default voice speaking the wrong language.
   */
  readonly speechPlanFor: (
    open: IngressOpen,
  ) => { targetLanguage: string; voiceId: string } | null;
  readonly onCaption?: (event: TranscriptEvent) => void;
  readonly onSpoken?: (segmentId: string, generation: number) => void;
  readonly speech?: LiveStreamPipelineDeps['speech'];
  readonly stabilizationMs?: number;
  readonly maxUtteranceMs?: number;
  readonly frameSamples?: number;
  readonly maxQueuedFrames?: number;
  readonly timers?: LiveStreamPipelineDeps['timers'];
  readonly now?: () => number;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export class LiveSessionHost implements IngressStreamHandler {
  private constructor(
    private readonly transcript: LiveStreamPipeline,
    private readonly speech: LiveTranslationPipeline | null,
    private readonly context: RealtimeServiceContext,
  ) {}

  static async open(
    open: IngressOpen,
    sender: IngressStreamSender,
    deps: LiveSessionHostDeps,
  ): Promise<LiveSessionHost> {
    const plan = deps.speechPlanFor(open);
    let speech: LiveTranslationPipeline | null = null;

    if (plan !== null && deps.synthesis !== null) {
      const translationDeps: LiveTranslationPipelineDeps = {
        sessionId: open.sessionId,
        streamId: open.streamId,
        serviceCategory: open.context.serviceCategory,
        sourceLanguage: open.sourceLanguage ?? 'auto',
        targetLanguage: plan.targetLanguage,
        voiceId: plan.voiceId,
        translation: deps.translation,
        synthesis: deps.synthesis,
        // Straight back down the same socket the audio came up. Nothing about
        // which vendor synthesised it survives this boundary.
        deliver: (frame): boolean =>
          sender.sendTranslatedAudio({
            segmentId: frame.segmentId,
            generation: frame.generation,
            sequence: frame.sequence,
            segmentStartMs: frame.segmentStartMs,
            final: frame.final,
            samples: frame.samples,
          } satisfies IngressTranslatedAudio),
        ...(deps.maxQueuedFrames === undefined ? {} : { maxQueuedFrames: deps.maxQueuedFrames }),
        ...(deps.frameSamples === undefined ? {} : { frameSamples: deps.frameSamples }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.log === undefined ? {} : { log: deps.log }),
      };
      speech = new LiveTranslationPipeline(translationDeps);
    }

    const transcript = await LiveStreamPipeline.open({
      sessionId: open.sessionId,
      streamId: open.streamId,
      context: open.context,
      sourceLanguage: open.sourceLanguage,
      sourceLanguageMode: open.sourceLanguageMode,
      transcription: deps.transcription,
      mintSegmentId: () => deps.mintSegmentId(open),
      onTranscriptEvent: (event) => {
        deps.onCaption?.(event);
        if (speech === null) return;
        // Deliberately not awaited. Transcription must not stall behind
        // translation and synthesis: the next frame of somebody's speech is
        // already arriving, and holding the recogniser to wait for a vendor to
        // finish a sentence would make the whole stream stutter.
        void speech
          .onTranscriptEvent(event)
          .then((record) => {
            if (record !== null) deps.onSpoken?.(record.segmentId, record.generation);
          })
          .catch((error: unknown) => {
            deps.log?.('speech pipeline failed', {
              segmentId: event.segmentId,
              message: error instanceof Error ? error.message : 'unknown',
            });
          });
      },
      ...(deps.speech === undefined ? {} : { speech: deps.speech }),
      ...(deps.stabilizationMs === undefined ? {} : { stabilizationMs: deps.stabilizationMs }),
      ...(deps.maxUtteranceMs === undefined ? {} : { maxUtteranceMs: deps.maxUtteranceMs }),
      ...(deps.timers === undefined ? {} : { timers: deps.timers }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });

    return new LiveSessionHost(transcript, speech, open.context);
  }

  get serviceCategory(): 'call' | 'programme' {
    return this.context.serviceCategory;
  }

  get stats(): LiveStreamPipeline['stats'] {
    return this.transcript.stats;
  }

  /** The socket has room again; release whatever translated audio was held. */
  resume(): void {
    this.speech?.resume();
  }

  async onAudio(frame: Parameters<IngressStreamHandler['onAudio']>[0]): Promise<void> {
    await this.transcript.onAudio(frame);
  }

  async finish(reason: string): Promise<void> {
    // Transcription first: it still owes finals, and those finals are exactly
    // the sentences that still need speaking.
    await this.transcript.finish(reason);
  }

  async abort(reason: string): Promise<void> {
    await this.transcript.abort(reason);
    // Whatever was being spoken for this stream is withdrawn too. Leaving it
    // running would speak a sentence whose transcript was just discarded.
    this.speech?.cancelAll(reason);
  }

  async disconnected(reason: string): Promise<void> {
    await this.transcript.disconnected(reason);
  }
}

/**
 * The `openStream` implementation the ingress server wants.
 *
 * Refuses rather than defaults when it cannot serve a stream, for the reason
 * every refusal in this path exists: a stream that reports itself open and
 * then does nothing is worse than one that never opened, because the sender
 * keeps talking into it.
 */
export function createLiveStreamOpener(deps: LiveSessionHostDeps) {
  return async (
    open: IngressOpen,
    sender: IngressStreamSender,
  ): Promise<IngressStreamHandler | null> => {
    try {
      return await LiveSessionHost.open(open, sender, deps);
    } catch (error) {
      deps.log?.('live stream refused', {
        sessionId: open.sessionId,
        streamId: open.streamId,
        message: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    }
  };
}
