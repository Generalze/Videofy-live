/** @author masterzee001 */
/**
 * The streaming transcription contract.
 *
 * ADDITIVE. `TranscriptionProvider` is unchanged and remains the contract for
 * uploaded programmes and for batch fallbacks, where accuracy, context and cost
 * per hour matter more than time-to-first-token. This is the second execution
 * strategy, not a replacement.
 *
 * WHAT A STREAMING ADAPTER MAY NOT DO, stated as a list because each one is a
 * way vendor semantics leak into the platform:
 *
 *   - it may not mint a segment id
 *   - it may not decide that a segment is final
 *   - it may not supply a revision number
 *   - it may not set the platform timeline
 *
 * `StreamingTranscriptionSignal` carries none of those fields, so an adapter
 * cannot express them even by mistake. What it reports is evidence; the
 * platform's coordinator decides what that evidence means.
 */
import type { ProviderUsage } from './transcript-event.js';

/**
 * One frame of audio on the platform's own terms.
 *
 * NOT a bare `Int16Array`. P6.8 spent three falsification passes on the
 * consequences of conflating transmission order, media time and arrival time,
 * and a streaming STT socket is precisely where those three diverge: the
 * network reorders, the vendor buffers, and the speaker pauses. The frame
 * therefore carries the platform's media clock explicitly, and the vendor's
 * clock never becomes authoritative.
 */
export interface StreamingTranscriptionFrame {
  readonly samples: Int16Array;
  readonly sampleRate: 16000;
  readonly channelCount: 1;
  /** Media time on the canonical platform timeline. */
  readonly platformTimestampMs: number;
  /**
   * True when contiguous audio was lost or deliberately evicted before this
   * frame.
   *
   * Without it a streaming provider silently treats a gap as continuous speech
   * and hallucinates across it -- joining the end of one sentence to the start
   * of another and producing a fluent, confident, wrong transcript. Telling the
   * provider there was a gap is cheaper than detecting the fabrication later.
   */
  readonly discontinuity?: boolean;
}

/**
 * A normalized observation from a streaming provider.
 *
 * `endpoint` is the valuable one and the reason this is a union rather than
 * just partial/final: a provider that detects utterance boundaries is telling
 * the platform something its own VAD may have missed. It is a CANDIDATE
 * BOUNDARY SIGNAL. The platform decides whether to act on it, so the same
 * signal from a different vendor produces the same platform behaviour.
 *
 * TEXT IS CUMULATIVE FOR THE CURRENT UTTERANCE, not a delta. Vendors differ;
 * normalising that difference is the adapter's job, because a coordinator that
 * had to know which vendors send deltas would be a coordinator that knows about
 * vendors.
 */
export type StreamingTranscriptionSignal =
  | {
      readonly kind: 'partial';
      readonly text: string;
      readonly providerStartMs?: number | null;
      readonly providerEndMs?: number | null;
      readonly confidence?: number | null;
      readonly detectedLanguage?: string;
    }
  | {
      readonly kind: 'final';
      readonly text: string;
      readonly providerStartMs?: number | null;
      readonly providerEndMs?: number | null;
      readonly confidence?: number | null;
      readonly detectedLanguage?: string;
      readonly usage?: ProviderUsage;
    }
  | {
      /** The provider believes an utterance ended. Advisory, never binding. */
      readonly kind: 'endpoint';
      readonly providerEndMs?: number | null;
    };

export interface StreamingTranscriptionOptions {
  readonly sessionId: string;
  readonly streamId: string;
  readonly sourceLanguage?: string;
  readonly sourceLanguageMode?: 'manual' | 'auto-detect';
  /** Ask the provider to report utterance boundaries, where it can. */
  readonly requestEndpointing?: boolean;
  readonly onSignal: (signal: StreamingTranscriptionSignal) => void;
  readonly onError: (error: Error) => void;
  /** The transport dropped. The platform decides what that means for a segment. */
  readonly onDisconnected?: (reason: string) => void;
}

/**
 * A live transcription session.
 *
 * Every method is bounded and every outcome explicit, for the reason P6.8
 * established the hard way: a seam call that neither returns nor throws leaves
 * the caller waiting past the point at which anyone still cares about the
 * answer. `close` is idempotent because teardown races are ordinary.
 */
export interface StreamingTranscriptionSession {
  pushAudio(frame: StreamingTranscriptionFrame): Promise<void>;
  /** Flush and await whatever finals the provider still owes. */
  finish(): Promise<void>;
  close(reason: string): Promise<void>;
  readonly isClosed: boolean;
}

export interface StreamingTranscriptionProvider {
  readonly name: string;
  openStream(options: StreamingTranscriptionOptions): Promise<StreamingTranscriptionSession>;
}

/**
 * An in-memory streaming provider that records what it was given and replays a
 * scripted set of signals.
 *
 * Deliberately mirrors `MockTranscriptionProvider` on the batch side. The
 * coordinator's tests drive this rather than a vendor, so the platform's
 * segmentation policy is proved independently of any vendor's behaviour --
 * which is the whole claim this wave is making.
 */
export class MockStreamingTranscriptionProvider implements StreamingTranscriptionProvider {
  readonly name = 'mock-streaming';
  readonly sessions: MockStreamingSession[] = [];

  async openStream(
    options: StreamingTranscriptionOptions,
  ): Promise<StreamingTranscriptionSession> {
    const session = new MockStreamingSession(options);
    this.sessions.push(session);
    return session;
  }
}

export class MockStreamingSession implements StreamingTranscriptionSession {
  readonly frames: StreamingTranscriptionFrame[] = [];
  finishCount = 0;
  closeCount = 0;
  closeReasons: string[] = [];
  private closed = false;

  constructor(private readonly options: StreamingTranscriptionOptions) {}

  get isClosed(): boolean {
    return this.closed;
  }

  async pushAudio(frame: StreamingTranscriptionFrame): Promise<void> {
    if (this.closed) throw new Error('pushAudio after close');
    this.frames.push(frame);
  }

  async finish(): Promise<void> {
    this.finishCount += 1;
  }

  async close(reason: string): Promise<void> {
    // Idempotent: a second close is ordinary, not an error.
    this.closeCount += 1;
    this.closeReasons.push(reason);
    this.closed = true;
  }

  /** Test hook: pretend the vendor said something. */
  emit(signal: StreamingTranscriptionSignal): void {
    this.options.onSignal(signal);
  }

  emitError(error: Error): void {
    this.options.onError(error);
  }

  emitDisconnected(reason: string): void {
    this.options.onDisconnected?.(reason);
  }
}
