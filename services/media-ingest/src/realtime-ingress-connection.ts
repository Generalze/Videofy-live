/** @author masterzee001 */
/**
 * One realtime ingress connection, as a state machine with no socket in it.
 *
 * Deliberately separated from `ws`, for the reason the codec is: everything
 * worth proving about this seam -- what happens to audio that arrives before a
 * stream is open, what a sequence gap means, whether a dropped transport is
 * distinguishable from a clean finish -- is provable without binding a port. A
 * test that needs a real socket to ask those questions fails for reasons about
 * the network instead of reasons about the contract.
 *
 * THE THREE ENDINGS ARE DIFFERENT, and keeping them apart is most of the point:
 *
 *   FINISH   the speaker stopped talking. Transcribe what is owed.
 *   ABORT    the platform gave up on this stream. Discard what is owed.
 *   dropped  nobody said anything; the transport went away mid-sentence.
 *
 * A pipeline that collapses these will either transcribe audio somebody
 * cancelled or throw away a sentence that was merely interrupted by a
 * reconnect. So the handler is told which one happened, always, exactly once.
 */
import {
  IngressLimits,
  decodeIngressFrame,
  encodeError,
  encodeReady,
  type IngressAudio,
  encodeTranslatedAudio,
  type IngressErrorCode,
  type IngressOpen,
  type IngressTranslatedAudio,
} from '@videofy-live/media-ingress-wire';

/**
 * The way back to the gateway, handed to a stream when it opens.
 *
 * A handler needs this because translated speech is produced here and played
 * there. Passing a sender rather than exposing the socket keeps the handler
 * unable to do anything else with the connection -- it can return audio for
 * its own stream and nothing more.
 */
export interface IngressStreamSender {
  /** False when the socket is backed up; the caller holds the frame. */
  sendTranslatedAudio(frame: IngressTranslatedAudio): boolean;
}

export interface IngressStreamHandler {
  /**
   * Audio in wire order. Awaited, so a slow consumer applies backpressure
   * rather than having frames pile up unbounded behind it.
   */
  onAudio(frame: IngressAudio): Promise<void> | void;
  /** The speaker stopped. Flush and settle. */
  finish(reason: string): Promise<void> | void;
  /** Give up on this stream. Discard what is owed. */
  abort(reason: string): Promise<void> | void;
  /**
   * The transport went away without either. Its own method rather than an
   * `abort` with a special reason string, because the caller's decision
   * genuinely differs: a cancelled stream is finished, and a dropped one may
   * be worth reconnecting and resuming.
   */
  disconnected(reason: string): Promise<void> | void;
}

export interface RealtimeIngressConnectionDeps {
  /**
   * Open a stream, or refuse it.
   *
   * Returning null refuses without explanation to the peer beyond a code --
   * the gateway is first-party, but a stream refused for policy reasons should
   * not leak why to a process that failed to be authorised for it.
   */
  readonly openStream: (
    open: IngressOpen,
    sender: IngressStreamSender,
  ) => Promise<IngressStreamHandler | null>;
  /** False when the socket is backed up, so callers can apply backpressure. */
  readonly send: (frame: Buffer) => boolean;
  readonly close: (reason: string) => void;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

interface StreamState {
  readonly open: IngressOpen;
  readonly handler: IngressStreamHandler;
  lastSequence: number;
  ended: boolean;
}

export class RealtimeIngressConnection {
  private stream: StreamState | null = null;
  private malformed = 0;
  private closed = false;
  /**
   * Set the instant the transport goes, so nothing new is admitted -- while
   * the ENDING still travels through the ordered queue below. The two are
   * separate because frames that already arrived deserve to be processed;
   * only frames that have not arrived should be refused.
   */
  private transportGone = false;
  /**
   * Serialises handler calls. Audio must reach the consumer in wire order even
   * though every handler call is async: without this, two frames delivered
   * concurrently would race and a sentence could be transcribed out of order.
   */
  private pump: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RealtimeIngressConnectionDeps) {}

  get openStreamId(): string | null {
    return this.stream?.open.streamId ?? null;
  }

  /** One inbound message. Never throws: a peer's bad frame is not our crash. */
  handleMessage(raw: Buffer): void {
    if (this.closed || this.transportGone) return;
    const decoded = decodeIngressFrame(raw);
    if (!decoded.ok) {
      this.refuse(decoded.code, decoded.detail);
      return;
    }
    const frame = decoded.frame;
    switch (frame.kind) {
      case 'open':
        this.queue(() => this.handleOpen(frame.open));
        return;
      case 'audio':
        this.queue(() => this.handleAudio(frame.audio));
        return;
      case 'finish':
        this.queue(() => this.handleEnd('finish', frame.finish.streamId, frame.finish.reason));
        return;
      case 'abort':
        this.queue(() => this.handleEnd('abort', frame.abort.streamId, frame.abort.reason));
        return;
      case 'ready':
      case 'error':
        // Server-to-client frames arriving inbound. A peer speaking our half of
        // the protocol is confused, and saying so beats ignoring it.
        this.refuse('malformed-frame', `${frame.kind} is a server frame`);
        return;
    }
  }

  /**
   * The transport went away without FINISH or ABORT.
   *
   * Reported as its own ending. A mid-sentence disconnect is neither a speaker
   * who finished nor a platform that cancelled, and treating it as either
   * loses information the caller needs to decide about a reconnect.
   */
  handleDisconnect(reason: string): void {
    if (this.transportGone) return;
    this.transportGone = true;
    // QUEUED, not immediate. A socket that drops while OPEN is still in the
    // queue would otherwise find no stream, deliver no ending, and leave a
    // handler that `openStream` had already built with nothing ever coming --
    // the P6.8 failure of a seam call that neither completes nor errors.
    this.queue(async () => {
      const stream = this.stream;
      this.closed = true;
      if (stream === null || stream.ended) return;
      stream.ended = true;
      await stream.handler.disconnected(reason);
    });
  }

  private queue(work: () => Promise<void>): void {
    this.pump = this.pump.then(work).catch((error: unknown) => {
      this.deps.log?.('ingress handler failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      this.refuse('internal-failure', 'handler failed');
    });
  }

  /** Awaits the ordered work queue. Tests use it; production does not need it. */
  async drain(): Promise<void> {
    await this.pump;
  }

  private async handleOpen(open: IngressOpen): Promise<void> {
    if (this.stream !== null) {
      // One stream per connection. Multiplexing would need stream ids on every
      // audio frame, and this seam has no use for it: the gateway already
      // holds one connection per call leg.
      this.refuse('stream-already-open', this.stream.open.streamId);
      return;
    }
    const handler = await this.deps.openStream(open, {
      sendTranslatedAudio: (frame) => {
        if (this.closed || this.transportGone) return false;
        return this.deps.send(encodeTranslatedAudio(frame));
      },
    });
    if (handler === null) {
      this.refuse('stream-not-open', 'refused');
      return;
    }
    this.stream = { open, handler, lastSequence: -1, ended: false };
    this.deps.send(encodeReady(open.streamId));
  }

  private async handleAudio(audio: IngressAudio): Promise<void> {
    const stream = this.stream;
    if (stream === null) {
      this.refuse('audio-before-open', 'no stream');
      return;
    }
    if (stream.ended) {
      this.refuse('stream-not-open', 'stream already ended');
      return;
    }
    if (audio.sequence <= stream.lastSequence) {
      // A replayed or reordered frame. Accepting it would splice old audio
      // into the middle of a live sentence.
      this.refuse('sequence-replay', `sequence ${audio.sequence}`);
      return;
    }
    const gap = audio.sequence > stream.lastSequence + 1;
    stream.lastSequence = audio.sequence;
    await stream.handler.onAudio(
      // A GAP IS A DISCONTINUITY whether or not the sender flagged one. The
      // sender knows about audio it dropped on purpose; only the receiver
      // knows about frames that never arrived. A recogniser told that a gap
      // was continuous speech hallucinates across it fluently and wrongly.
      gap && !audio.discontinuity ? { ...audio, discontinuity: true } : audio,
    );
  }

  private async handleEnd(kind: 'finish' | 'abort', streamId: string, reason: string): Promise<void> {
    const stream = this.stream;
    if (stream === null || stream.open.streamId !== streamId || stream.ended) {
      this.refuse('stream-not-open', streamId);
      return;
    }
    stream.ended = true;
    if (kind === 'finish') await stream.handler.finish(reason);
    else await stream.handler.abort(reason);
  }

  private refuse(code: IngressErrorCode, detail: string): void {
    if (this.closed) return;
    this.deps.send(encodeError(code, detail));
    this.malformed += 1;
    this.deps.log?.('ingress frame refused', { code, detail });
    if (this.malformed >= IngressLimits.MALFORMED_MESSAGES_BEFORE_CLOSE) {
      // A peer that cannot speak the protocol should not be able to keep
      // trying forever on our budget.
      this.closed = true;
      this.deps.close(`too many refused frames (${code})`);
    }
  }
}
