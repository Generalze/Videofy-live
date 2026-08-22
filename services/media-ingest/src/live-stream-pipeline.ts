/** @author masterzee001 */
/**
 * The live path, assembled: ingress frames in, Videofy transcript events out.
 *
 * This is the piece that makes C-AI1.1D's parts into a product. Everything it
 * composes was already proven separately; what did not exist was anything that
 * put them in the one order that works, which is why the composition is a file
 * with tests rather than four lines inside a request handler.
 *
 *     ingress frame
 *       -> SpeechActivityGate      does anybody appear to be talking
 *       -> StreamingSegmentCoordinator   what Videofy calls this utterance
 *       -> streaming STT session   what the words were
 *       -> TranscriptEvent         the platform's own, revisable, final
 *
 * WHAT REPLACES WHAT. The old live path re-transcribed a growing
 * "audio-so-far" window on every partial, so a ten-second sentence was sent
 * and recognised fifty times. Here each frame is sent once and the provider
 * keeps its own state. The partial captions are the provider's real partials
 * rather than a simulation of them.
 *
 * WHO OWNS WHAT, restated because this is where it would be easiest to lose:
 * the gateway owns the timeline and stamps every frame; media-ingest owns the
 * provider session; the platform owns segment identity and finality. A
 * provider `final` is evidence for a boundary, never a boundary.
 *
 * AUDIO IS FORWARDED CONTINUOUSLY, including silence. The chunker dropped
 * silence because it was assembling a file and silence made the file bigger
 * for nothing. A streaming recogniser is the opposite case: it maintains its
 * own acoustic state, and a stream that skips the quiet parts hands it audio
 * that jumps, which is exactly the discontinuity we go to lengths to declare
 * everywhere else. Streaming STT is billed by connection time, so forwarding
 * silence costs nothing extra.
 */
import { SpeechActivityGate, type SpeechActivityOptions } from '@videofy-live/speech-activity';
import type { IngressAudio, RealtimeServiceContext } from '@videofy-live/media-ingress-wire';
import type { IngressStreamHandler } from './realtime-ingress-connection.js';
import {
  StreamingSegmentCoordinator,
  commitPolicyForService,
  type SegmentTimers,
} from './streaming-segment-coordinator.js';
import type {
  StreamingTranscriptionProvider,
  StreamingTranscriptionSession,
} from './streaming-transcription-provider.js';
import type { TranscriptEvent } from './transcript-event.js';

export interface LiveStreamPipelineDeps {
  readonly sessionId: string;
  readonly streamId: string;
  readonly context: RealtimeServiceContext;
  readonly sourceLanguage?: string | undefined;
  readonly sourceLanguageMode?: 'manual' | 'auto-detect' | undefined;
  readonly transcription: StreamingTranscriptionProvider;
  /** Platform-owned identity. Never a vendor value. */
  readonly mintSegmentId: () => string;
  readonly onTranscriptEvent: (event: TranscriptEvent) => void;
  readonly speech?: SpeechActivityOptions;
  readonly stabilizationMs?: number;
  readonly maxUtteranceMs?: number;
  readonly timers?: SegmentTimers;
  readonly now?: () => number;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export interface LiveStreamPipelineStats {
  readonly framesIn: number;
  readonly samplesIn: number;
  readonly discontinuities: number;
  readonly speechStarts: number;
  readonly tooQuiet: number;
  readonly ended: 'finish' | 'abort' | 'disconnected' | null;
}

export class LiveStreamPipeline implements IngressStreamHandler {
  private readonly gate: SpeechActivityGate;
  private readonly coordinator: StreamingSegmentCoordinator;
  private session: StreamingTranscriptionSession | null = null;
  private lastTimestampMs = 0;
  private framesIn = 0;
  private samplesIn = 0;
  private discontinuities = 0;
  private speechStarts = 0;
  private tooQuiet = 0;
  private ended: LiveStreamPipelineStats['ended'] = null;

  private constructor(private readonly deps: LiveStreamPipelineDeps) {
    this.gate = new SpeechActivityGate(deps.speech ?? {});
    this.coordinator = new StreamingSegmentCoordinator({
      sessionId: deps.sessionId,
      streamId: deps.streamId,
      providerName: deps.transcription.name,
      mintSegmentId: deps.mintSegmentId,
      // A call finalises aggressively because somebody is waiting to reply; a
      // programme stabilises because its audience would rather wait than see a
      // caption rewrite itself. Same mechanism, different policy.
      commitPolicy: commitPolicyForService(deps.context.serviceCategory),
      ...(deps.stabilizationMs === undefined ? {} : { stabilizationMs: deps.stabilizationMs }),
      ...(deps.maxUtteranceMs === undefined ? {} : { maxUtteranceMs: deps.maxUtteranceMs }),
      ...(deps.timers === undefined ? {} : { timers: deps.timers }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.log === undefined ? {} : { log: deps.log }),
      onEvent: deps.onTranscriptEvent,
    });
  }

  static async open(deps: LiveStreamPipelineDeps): Promise<LiveStreamPipeline> {
    const pipeline = new LiveStreamPipeline(deps);
    pipeline.session = await deps.transcription.openStream({
      sessionId: deps.sessionId,
      streamId: deps.streamId,
      ...(deps.sourceLanguage === undefined ? {} : { sourceLanguage: deps.sourceLanguage }),
      ...(deps.sourceLanguageMode === undefined
        ? {}
        : { sourceLanguageMode: deps.sourceLanguageMode }),
      // Ask for boundaries where the provider can offer them. They are inputs
      // to our segmentation, never a substitute for it.
      requestEndpointing: true,
      onSignal: (signal) => pipeline.coordinator.noteProviderSignal(signal),
      onError: (error) => {
        deps.log?.('streaming transcription error', { message: error.message });
      },
      onDisconnected: (reason) => {
        // The PROVIDER's transport dropped, not ours. Whatever was open cannot
        // claim to be continuous across the reconnect, and the platform's
        // segment identity survives it because the platform minted it.
        pipeline.discontinuities += 1;
        pipeline.coordinator.noteDiscontinuity(`provider-disconnected: ${reason}`);
        pipeline.gate.reset();
      },
    });
    return pipeline;
  }

  get stats(): LiveStreamPipelineStats {
    return {
      framesIn: this.framesIn,
      samplesIn: this.samplesIn,
      discontinuities: this.discontinuities,
      speechStarts: this.speechStarts,
      tooQuiet: this.tooQuiet,
      ended: this.ended,
    };
  }

  async onAudio(frame: IngressAudio): Promise<void> {
    if (this.ended !== null) return;
    this.framesIn += 1;
    this.samplesIn += frame.samples.length;
    this.lastTimestampMs =
      frame.platformTimestampMs + (frame.samples.length / 16000) * 1000;

    if (frame.discontinuity) {
      this.discontinuities += 1;
      // Order matters: tell the coordinator BEFORE the gate forgets, so a
      // segment that was open is finalised as what was genuinely heard rather
      // than stitched across the hole.
      this.coordinator.noteDiscontinuity('ingress-gap');
      this.gate.reset();
    }

    for (const event of this.gate.push(frame.samples, frame.platformTimestampMs)) {
      if (event.kind === 'speech-start') {
        this.speechStarts += 1;
        this.coordinator.noteSpeechStart(event.platformTimestampMs);
      } else if (event.kind === 'speech-end') {
        this.coordinator.noteSpeechEnd(event.platformTimestampMs);
      } else {
        // Deliberately tells the coordinator nothing.
        //
        // Stated precisely, because it is tempting to credit this line with
        // more than it does: the thing that actually stops a chair creak
        // becoming a caption is the coordinator's empty-text guard, which
        // abandons any segment the provider returned no words for. What this
        // avoids is narrower and still worth avoiding -- reporting a BOUNDARY
        // for audio that was never an utterance, which on a call commits
        // immediately and would cut a real segment short if one were open.
        this.tooQuiet += 1;
      }
    }

    this.coordinator.noteAudio(this.lastTimestampMs, frame.discontinuity);
    await this.session?.pushAudio({
      samples: frame.samples,
      sampleRate: 16000,
      channelCount: 1,
      platformTimestampMs: frame.platformTimestampMs,
      ...(frame.discontinuity ? { discontinuity: true } : {}),
    });
  }

  /** The speaker stopped. Flush the provider and commit what is owed. */
  async finish(reason: string): Promise<void> {
    if (this.ended !== null) return;
    this.ended = 'finish';
    for (const event of this.gate.finish(this.lastTimestampMs)) {
      if (event.kind === 'speech-end') this.coordinator.noteSpeechEnd(event.platformTimestampMs);
    }
    // Flush FIRST: the provider still owes finals, and closing the coordinator
    // before they arrive would commit a sentence missing its last words.
    await this.session?.finish();
    await this.session?.close(reason);
    this.coordinator.close();
    this.deps.log?.('live stream finished', { streamId: this.deps.streamId, reason });
  }

  /** The platform gave up on this stream. Nothing open becomes a transcript. */
  async abort(reason: string): Promise<void> {
    if (this.ended !== null) return;
    this.ended = 'abort';
    await this.session?.close(reason);
    // No flush, no commit. An abandoned utterance that still emitted a final
    // would be translated, spoken, and shown to somebody who was already told
    // it was withdrawn.
    this.coordinator.abandon(reason);
    this.deps.log?.('live stream aborted', { streamId: this.deps.streamId, reason });
  }

  /**
   * The transport went away without either.
   *
   * Treated as FINISH rather than abort, and the reasoning is worth stating:
   * the audio that already arrived was really spoken, and the speaker never
   * withdrew it. Discarding it would silently lose the last sentence of every
   * call that ended by the network dropping -- which is most of them.
   */
  async disconnected(reason: string): Promise<void> {
    if (this.ended !== null) return;
    await this.finish(`transport-dropped: ${reason}`);
    this.ended = 'disconnected';
  }
}
