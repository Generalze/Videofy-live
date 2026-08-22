/** @author masterzee001 */
/**
 * The gateway's live audio path: normalise, stamp, send.
 *
 * Replaces, for `call/live` and `programme/live`, the chunker's route of
 * buffering audio into a WAV file and announcing it over HTTP. What made that
 * route wrong was never its code, which is careful; it was that it required a
 * finished file. A finished file means a shared disk between two services and
 * a whole utterance re-sent for every partial.
 *
 * THE MEDIA CLOCK IS COUNTED, NOT READ. `platformTimestampMs` advances by the
 * number of samples that have actually been sent, so it is a position on the
 * platform timeline rather than a reading of the wall clock at the moment a
 * frame happened to arrive. Those two agree right up until the network delays
 * a packet or the sender batches three frames together -- which is to say, they
 * agree until the moment the distinction starts to matter. P6.8 spent three
 * falsification passes learning to keep them apart.
 *
 * NORMALISATION IS THE CHUNKER'S, imported rather than reimplemented. There is
 * exactly one definition in this repository of what a Videofy PCM frame is,
 * and a second one written for the live path would differ in some rounding
 * detail nobody would find for a year.
 */
import { normalizePcmFrameWithDiagnostics, type MediaAudioDataLike } from './media-transcription-chunker.js';
import { RealtimeIngressClient, type RealtimeIngressClientOptions } from './realtime-ingress-client.js';
import type { IngressTranslatedAudio, RealtimeServiceContext } from '@videofy-live/media-ingress-wire';

const SAMPLE_RATE = 16000;

export interface LiveIngressSenderOptions {
  readonly url: string;
  readonly token?: string | undefined;
  readonly sessionId: string;
  readonly streamId: string;
  readonly context: RealtimeServiceContext;
  readonly sourceLanguage?: string | undefined;
  readonly sourceLanguageMode?: 'manual' | 'auto-detect' | undefined;
  readonly onTranslatedAudio?: (frame: IngressTranslatedAudio) => void;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
  /** Injected in tests; production builds a real client. */
  readonly createClient?: (options: RealtimeIngressClientOptions) => RealtimeIngressClient;
}

export interface LiveIngressSenderStats {
  readonly framesSent: number;
  readonly samplesSent: number;
  readonly droppedForBackpressure: number;
  readonly malformedFrames: number;
  readonly translatedFramesIn: number;
  readonly mediaPositionMs: number;
}

export class LiveIngressSender {
  private samplesSent = 0;
  private framesSent = 0;
  private malformedFrames = 0;
  private pendingDiscontinuity = false;
  private closed = false;

  private constructor(
    private readonly client: RealtimeIngressClient,
    private readonly options: LiveIngressSenderOptions,
  ) {}

  static async open(options: LiveIngressSenderOptions): Promise<LiveIngressSender> {
    const clientOptions: RealtimeIngressClientOptions = {
      url: options.url,
      sessionId: options.sessionId,
      streamId: options.streamId,
      context: options.context,
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.sourceLanguage === undefined ? {} : { sourceLanguage: options.sourceLanguage }),
      ...(options.sourceLanguageMode === undefined
        ? {}
        : { sourceLanguageMode: options.sourceLanguageMode }),
      ...(options.onTranslatedAudio === undefined
        ? {}
        : { onTranslatedAudio: options.onTranslatedAudio }),
      ...(options.log === undefined ? {} : { log: options.log }),
    };
    const client = (options.createClient ?? ((o) => new RealtimeIngressClient(o)))(clientOptions);
    // Resolves on READY, not on socket-open: a stream that was refused would
    // otherwise take audio and drop it while everything reported success.
    await client.open();
    return new LiveIngressSender(client, options);
  }

  get stats(): LiveIngressSenderStats {
    return {
      framesSent: this.framesSent,
      samplesSent: this.samplesSent,
      droppedForBackpressure: this.client.accounting.droppedForBackpressure,
      malformedFrames: this.malformedFrames,
      translatedFramesIn: this.client.accounting.translatedFramesIn,
      mediaPositionMs: this.mediaPositionMs,
    };
  }

  private get mediaPositionMs(): number {
    return (this.samplesSent / SAMPLE_RATE) * 1000;
  }

  /**
   * One captured frame.
   *
   * A malformed frame is COUNTED AND SKIPPED rather than thrown, and the next
   * good frame is marked discontinuous. Throwing here would take down a call
   * because one packet arrived with a sample rate nobody expected, and
   * pretending the audio was continuous across the hole would let the
   * recogniser join two unrelated half-sentences.
   */
  pushFrame(data: MediaAudioDataLike): boolean {
    if (this.closed) return false;
    let samples: Int16Array;
    try {
      samples = normalizePcmFrameWithDiagnostics(data).samples;
    } catch (error) {
      this.malformedFrames += 1;
      this.pendingDiscontinuity = true;
      this.options.log?.('live ingress frame skipped', {
        streamId: this.options.streamId,
        message: error instanceof Error ? error.message : 'unknown',
      });
      return false;
    }

    const startedAtMs = this.mediaPositionMs;
    const sent = this.client.sendAudio(samples, startedAtMs, this.pendingDiscontinuity);
    // The media clock advances for audio that was CAPTURED, whether or not the
    // socket took it. Stalling it on a drop would compress the timeline and
    // make later speech appear earlier than it was spoken.
    this.samplesSent += samples.length;
    if (sent) {
      this.framesSent += 1;
      this.pendingDiscontinuity = false;
    } else {
      this.pendingDiscontinuity = true;
    }
    return sent;
  }

  /** Audio was lost upstream; say so rather than splicing across it. */
  markDiscontinuity(): void {
    this.pendingDiscontinuity = true;
  }

  /** The speaker stopped. Ask for what is owed, then let the socket go. */
  async finish(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client.finish(reason);
    await this.client.close();
  }

  /** The platform gave up on this stream. Nothing owed is wanted. */
  async abort(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client.abort(reason);
    await this.client.close();
  }
}
