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
 * So `onCaption` sees everything and the translation pipelines see finals. The
 * filter lives inside the translation pipeline rather than here, so a future
 * caller cannot forget it.
 *
 * ONE TRANSCRIPTION, SEVERAL LANGUAGES. A conference with Spanish and French
 * listeners transcribes the speaker ONCE and then translates and synthesises
 * once per distinct target language. The earlier shape held a single pipeline
 * chosen from the first configured target, so French was simply never spoken
 * while every component reported success -- the most expensive kind of bug,
 * because nothing looks wrong.
 *
 * GENERATIONS ARE PER LANGUAGE. A Spanish retry must not cancel the French
 * rendering of the same sentence: they are separate attempts at separate
 * outputs that happen to share a segment id. Each pipeline keeps its own
 * counter, and the language travels on every frame so the two never merge
 * downstream.
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
import type { VocabularySnapshotClient } from './vocabulary-snapshot-client.js';
import type { ProgrammePerformanceRegistry } from './programme-performance-registry.js';
import type { TimestampedTranslationProvider } from './translation-provider.js';
import type { TranscriptEvent } from './transcript-event.js';

/** One language this session wants spoken, and the voice to speak it in. */
export interface LiveSpeechPlan {
  readonly targetLanguage: string;
  readonly voiceId: string;
}

/**
 * Which languages a session should be SPOKEN in, from what it was configured
 * with. Pure, so the rule is provable without a running session.
 *
 * Three separate exclusions, each with a different reason, and each one a way
 * a language could otherwise get a voice it should not have:
 *
 *   already planned   ten Spanish listeners are ONE translation and ONE
 *                     synthesis. Per-recipient streams would multiply the
 *                     vendor bill by the size of the audience for no audible
 *                     difference.
 *   text-only         translated for captions and deliberately never spoken.
 *                     Its audience asked for text.
 *   no voice          a language with no voice configured is left out rather
 *                     than given a default one, which for Spanish words would
 *                     be an English voice -- worse than the silence.
 */
/**
 * 0.6 is deliberately cautious for a first setting.
 *
 * Deepgram's own scores sit high on clean speech, so a genuine sentence
 * clears this comfortably; what it stops is the 0.2-0.4 band an energy gate
 * produces from coughs, doors and keyboards. Tune it with real calls rather
 * than by argument -- the log line names the value it refused and by how much.
 */
export const DEFAULT_MIN_SPOKEN_CONFIDENCE = 0.6;

export function planSpeechTargets(input: {
  readonly targetLanguages?: readonly string[] | undefined;
  readonly textOnlyLanguages?: readonly string[] | undefined;
  readonly voiceIdsByLanguage?: Readonly<Record<string, string>> | undefined;
}): LiveSpeechPlan[] {
  const textOnly = new Set(input.textOnlyLanguages ?? []);
  const plans: LiveSpeechPlan[] = [];
  const seen = new Set<string>();
  for (const targetLanguage of input.targetLanguages ?? []) {
    if (seen.has(targetLanguage)) continue;
    if (textOnly.has(targetLanguage)) continue;
    const voiceId = input.voiceIdsByLanguage?.[targetLanguage];
    if (voiceId === undefined) continue;
    seen.add(targetLanguage);
    plans.push({ targetLanguage, voiceId });
  }
  return plans;
}

export interface LiveSessionHostDeps {
  readonly transcription: StreamingTranscriptionProvider;
  readonly translation: TimestampedTranslationProvider;
  /** Null means captions only: nothing is translated into speech. */
  readonly synthesis: StreamingSpeechSynthesisProvider | null;
  readonly mintSegmentId: (open: IngressOpen) => string;
  /**
   * Every language this stream should be SPOKEN in, one plan per distinct
   * language.
   *
   * PLURAL, and that is the point. The singular version returned the first
   * non-text-only target, so a conference with Spanish and French listeners
   * progressively spoke Spanish and silently never spoke French -- while every
   * component reported success, because nothing was broken. It was a contract
   * that could not express the product.
   *
   * An empty list is a real answer: captions only. A language with no voice
   * configured is left out rather than given a default one, which for Spanish
   * words would be an English voice -- worse than the silence it replaced.
   */
  /**
   * Recogniser confidence below which a segment is captioned but not spoken.
   * See LiveTranslationPipelineDeps.minSpokenConfidence.
   */
  readonly minSpokenConfidence?: number | undefined;
  readonly speechPlansFor: (open: IngressOpen) => readonly LiveSpeechPlan[];
  readonly onCaption?: (event: TranscriptEvent) => void;
  readonly onSpoken?: (
    segmentId: string,
    generation: number,
    targetLanguage: string,
  ) => void;
  readonly speech?: LiveStreamPipelineDeps['speech'];
  readonly stabilizationMs?: number;
  readonly maxUtteranceMs?: number;
  readonly frameSamples?: number;
  readonly maxQueuedFrames?: number;
  readonly timers?: LiveStreamPipelineDeps['timers'];
  readonly now?: () => number;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
  /**
   * Where a programme's vocabulary comes from.
   *
   * Absent means this deployment has no vocabulary seam, which is a stated
   * condition rather than an empty word list: the difference between "this
   * programme has no terms" and "we could not find out" is the whole point.
   */
  readonly vocabulary?: VocabularySnapshotClient;
  /**
   * Where this programme's measurements are kept.
   *
   * Absent means nothing is counting, which the console must render as "no
   * samples" rather than as a set of zeroes that would read like a pipeline
   * performing perfectly.
   */
  readonly performance?: ProgrammePerformanceRegistry;
}

export class LiveSessionHost implements IngressStreamHandler {
  private constructor(
    private readonly transcript: LiveStreamPipeline,
    /** Keyed by target language. Empty means captions only. */
    private readonly speech: ReadonlyMap<string, LiveTranslationPipeline>,
    private readonly context: RealtimeServiceContext,
  ) {}

  static async open(
    open: IngressOpen,
    sender: IngressStreamSender,
    deps: LiveSessionHostDeps,
  ): Promise<LiveSessionHost> {
    const plans = deps.synthesis === null ? [] : deps.speechPlansFor(open);
    const synthesis = deps.synthesis;

    /*
     * THE PROGRAMME'S OWN WORDS, FETCHED ONCE AND PINNED.
     *
     * Read here because this is where the recogniser is about to be opened,
     * and a recogniser takes its vocabulary at the handshake: it cannot be
     * handed new terms afterwards. So this snapshot belongs to this session
     * for the whole of its life, and an edit made mid-programme applies to the
     * NEXT one. Saying otherwise would show an operator a version number that
     * nothing was using.
     *
     * A call has no vocabulary and no programme to fetch one for. A programme
     * whose vocabulary could not be READ gets none either -- and is logged as
     * unavailable rather than empty, because those look identical in the terms
     * they produce and mean opposite things.
     */
    const vocabulary = await resolveSessionVocabulary(open, deps);
    /**
     * How many languages this stream will actually be SPOKEN in.
     *
     * Zero is a legitimate state (captions-only) and an invisible failure. A
     * target language with no voice id is skipped silently by
     * planSpeechTargets, so a call could arrive with correct target languages,
     * commit every segment, and still build no translation pipeline at all --
     * which from a participant's seat is captions with silence, identical to
     * broken synthesis.
     */
    deps.log?.('live speech plans resolved', {
      sessionId: open.sessionId,
      synthesisConfigured: deps.synthesis !== null,
      planCount: plans.length,
      languages: plans.map((plan) => plan.targetLanguage),
    });
    const speech = new Map<string, LiveTranslationPipeline>();

    for (const plan of plans) {
      if (synthesis === null) break;
      if (speech.has(plan.targetLanguage)) continue;
      const translationDeps: LiveTranslationPipelineDeps = {
        sessionId: open.sessionId,
        streamId: open.streamId,
        serviceCategory: open.context.serviceCategory,
        sourceLanguage: open.sourceLanguage ?? 'auto',
        targetLanguage: plan.targetLanguage,
        voiceId: plan.voiceId,
        minSpokenConfidence: deps.minSpokenConfidence ?? DEFAULT_MIN_SPOKEN_CONFIDENCE,
        translation: deps.translation,
        synthesis,
        // Straight back down the same socket the audio came up. The LANGUAGE
        // travels with every frame: several pipelines share this socket and a
        // segment id, and the language is the only thing that tells their
        // frames apart.
        deliver: (frame): boolean =>
          sender.sendTranslatedAudio({
            targetLanguage: plan.targetLanguage,
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
        /*
         * Counters, but only for a programme. A direct call has no broadcast
         * to report on, and handing it a recorder would fill the console with
         * rows for conversations nobody is watching.
         */
        ...(deps.performance === undefined || open.context.serviceCategory !== 'programme'
          ? {}
          : {
              performance: deps.performance.for(
                open.context.programme.runId,
                open.sourceLanguage ?? 'en',
                plan.targetLanguage,
              ),
            }),
      };
      speech.set(plan.targetLanguage, new LiveTranslationPipeline(translationDeps));
    }

    const transcript = await LiveStreamPipeline.open({
      sessionId: open.sessionId,
      streamId: open.streamId,
      context: open.context,
      ...(vocabulary.keyterms.length === 0 ? {} : { keyterms: vocabulary.keyterms }),
      sourceLanguage: open.sourceLanguage,
      sourceLanguageMode: open.sourceLanguageMode,
      transcription: deps.transcription,
      mintSegmentId: () => deps.mintSegmentId(open),
      onTranscriptEvent: (event) => {
        deps.onCaption?.(event);
        // ONE final, EVERY language. Fanned out here rather than by
        // transcribing per language: the speaker said the sentence once.
        for (const [targetLanguage, pipeline] of speech) {
          // Deliberately not awaited. Transcription must not stall behind
          // translation and synthesis: the next frame of somebody's speech is
          // already arriving, and holding the recogniser to wait for a vendor
          // to finish a sentence would make the whole stream stutter. Nor may
          // one slow language hold up another.
          void pipeline
            .onTranscriptEvent(event)
            .then((record) => {
              if (record !== null) {
                deps.onSpoken?.(record.segmentId, record.generation, targetLanguage);
              }
            })
            .catch((error: unknown) => {
              deps.log?.('speech pipeline failed', {
                segmentId: event.segmentId,
                targetLanguage,
                message: error instanceof Error ? error.message : 'unknown',
              });
            });
        }
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

  /** Every language this stream is being spoken in. */
  get spokenLanguages(): string[] {
    return [...this.speech.keys()];
  }

  /** The socket has room again; release whatever translated audio was held. */
  resume(): void {
    for (const pipeline of this.speech.values()) pipeline.resume();
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
    // Whatever was being spoken for this stream is withdrawn too, in EVERY
    // language. Leaving one running would speak a sentence whose transcript
    // was just discarded.
    for (const pipeline of this.speech.values()) pipeline.cancelAll(reason);
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

/**
 * The vocabulary this session will run on, and how sure we are of it.
 *
 * Three outcomes, kept apart on purpose: a programme with terms, a programme
 * with none, and a programme whose terms could not be fetched. The last is not
 * the second. A console that showed "vocabulary active" for a failed read
 * would be telling an operator their carefully entered names are in use while
 * the recogniser has never seen them.
 */
async function resolveSessionVocabulary(
  open: IngressOpen,
  deps: LiveSessionHostDeps,
): Promise<{ readonly keyterms: readonly string[]; readonly state: string }> {
  if (open.context.serviceCategory !== 'programme') return { keyterms: [], state: 'not-a-programme' };
  if (deps.vocabulary === undefined) return { keyterms: [], state: 'no-vocabulary-seam' };

  const { programme } = open.context;
  const result = await deps.vocabulary.fetch({
    programmeId: programme.programmeId,
    sourceLanguage: open.sourceLanguage ?? 'en',
    // Resolution differs per direction; the first target is the one the
    // recogniser's own snapshot is taken against.
    targetLanguage: deps.speechPlansFor(open)[0]?.targetLanguage ?? open.sourceLanguage ?? 'en',
  });

  if (result.kind === 'unavailable') {
    // Loud, and never mistaken for an empty vocabulary.
    deps.log?.('programme vocabulary UNAVAILABLE; the recogniser runs without it', {
      sessionId: open.sessionId,
      programmeId: programme.programmeId,
      runId: programme.runId,
      reason: result.reason,
    });
    return { keyterms: [], state: 'unavailable' };
  }

  // Identity only: never the terms themselves.
  deps.log?.('programme vocabulary pinned for this recogniser session', {
    sessionId: open.sessionId,
    programmeId: programme.programmeId,
    runId: programme.runId,
    revision: result.identity.revision,
    termCount: result.identity.termCount,
    fingerprint: result.identity.fingerprint,
  });
  return {
    keyterms: result.kind === 'ready' ? result.keyterms : [],
    state: result.kind,
  };
}
