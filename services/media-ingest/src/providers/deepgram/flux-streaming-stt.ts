/** @author masterzee001 */
/**
 * Deepgram Flux — Listen v2, turn-based. A DIFFERENT PROTOCOL from Nova.
 *
 * This file exists because the first C-AI1.1C pass got it wrong. A summary page
 * described Flux as supporting streaming and batch, so the registry recorded
 * `batch: 'yes'` and the one generic streaming adapter defaulted every model to
 * `/v1/listen`. The Flux-specific documentation says otherwise, and the failure
 * would have been quiet: a well-tested adapter connected to the wrong endpoint,
 * parsing a vocabulary the server never sends, producing no transcripts at all
 * — which on a phone call looks exactly like a speaker who said nothing.
 *
 * The lesson is not "read more pages". It is that a VENDOR SUMMARY IS NOT A
 * PROTOCOL SPECIFICATION, and the cell it justifies is only as narrow as the
 * page it came from.
 *
 * EVIDENCE (read 2026-08-22):
 *   wss://api.deepgram.com/v2/listen?model=flux-general-en
 *   streaming only; the Flux documentation describes no batch path
 *   encodings include `linear16`; sample_rate 16000 supported AND recommended
 *   `encoding` and `sample_rate` are REQUIRED for raw audio
 *   80 ms chunks "strongly recommended for optimal model performance and latency"
 *   eot_threshold 0.5-0.9 (default 0.7); eager_eot_threshold 0.3-0.9 (no default);
 *   eot_timeout_ms 500-60000 (default 5000); language_hint (multi model only)
 *   server: TurnInfo { type, request_id, sequence_id, event, turn_index,
 *     transcript, words[], end_of_turn_confidence, audio_window_start,
 *     audio_window_end }
 *   events: StartOfTurn, Update, EagerEndOfTurn, TurnResumed, EndOfTurn
 *   words[]: { word, confidence, start, end }
 *   client: binary media; a close-stream control message. No KeepAlive in v2.
 *   -- developers.deepgram.com/docs/flux/quickstart
 *   -- developers.deepgram.com/reference/speech-to-text/listen-flux
 *
 * STILL UNVERIFIED: the exact JSON body of the close-stream control message.
 * The reference names the message but the pages read did not show its payload,
 * so `{"type":"CloseStream"}` is sent and the smoke test is what confirms it.
 * Closing is best-effort anyway; the socket close is what actually ends the
 * stream.
 */
import {
  SOCKET_OPEN,
  pcmBytes,
  type DeepgramSocket,
  type DeepgramSocketFactory,
} from './transport.js';
import type {
  StreamingTranscriptionFrame,
  StreamingTranscriptionOptions,
  StreamingTranscriptionProvider,
  StreamingTranscriptionSession,
} from '../../streaming-transcription-provider.js';

/** 16 kHz mono: 80 ms is 1280 samples. The vendor's recommended send size. */
export const FLUX_RECOMMENDED_FRAME_SAMPLES = 1280;

export interface DeepgramFluxStreamingConfig {
  readonly apiKey: string;
  /** `flux-general-en` or `flux-general-multi`. */
  readonly model: string;
  readonly baseUrl?: string;
  /** 0.5-0.9, vendor default 0.7. Higher waits longer before declaring a turn over. */
  readonly eotThreshold?: number;
  /** 500-60000, vendor default 5000. */
  readonly eotTimeoutMs?: number;
  /**
   * OFF BY DEFAULT, and deliberately so.
   *
   * Eager end-of-turn is a latency-versus-false-start trade the vendor makes
   * explicit. A false start on this platform does not mean a wasted API call --
   * it means beginning to SPEAK a translation while the person is still
   * correcting themselves, and spoken audio cannot be recalled. Enabling it is
   * a separate design and certification exercise; until then the parameter is
   * not sent and the event, if it somehow arrives, is treated as speculative.
   */
  readonly eagerEotThreshold?: number;
  /** Multilingual model only. */
  readonly languageHint?: string;
  /** Samples per send. Defaults to the vendor's recommended 80 ms. */
  readonly frameSamples?: number;
  readonly sockets: DeepgramSocketFactory;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

/**
 * WHY A FLUX SESSION CAN BE REFUSED FOR ITS LANGUAGE.
 *
 * Flux takes no `language` parameter. Listen v2 accepts `language_hint`, and
 * only on a *multi* model; a single-language model such as `flux-general-en`
 * transcribes whatever it is given AS ENGLISH. The adapter used to ignore
 * `options.sourceLanguage` entirely, and the consequence was measured on
 * 2026-08-30: a session declaring `sourceLanguage: 'yo'` opened successfully
 * and returned fluent English, and `'zz-not-a-language'` opened too.
 *
 * That is the exact failure this platform exists to refuse -- a vendor
 * answering a Nigerian language with confident, wrong output and every success
 * signal intact. Nova refuses the same request with HTTP 400 at connect, so the
 * two adapters failed in OPPOSITE directions on identical input. This makes
 * Flux fail the same way Nova does: closed, before a byte of audio is accepted.
 *
 * `auto-detect` is a deliberate exemption. A session that has not claimed a
 * language is not making a claim the adapter can contradict.
 */
function assertFluxCanServeLanguage(model: string, options: StreamingTranscriptionOptions): void {
  const requested = options.sourceLanguage?.trim().toLowerCase();
  if (requested === undefined || requested === '') return;
  if (options.sourceLanguageMode === 'auto-detect') return;
  // A multi model carries the request through as `language_hint`.
  if (model.includes('multi')) return;
  // Single-language Flux models are named for the language they serve:
  // `flux-general-en` serves English. Accept the bare tag and any region of it.
  const served = model.split('-').pop() ?? '';
  const base = requested.split(/[-_]/)[0] ?? requested;
  if (served !== '' && base === served) return;
  throw new Error(
    `Deepgram Flux model ${model} cannot transcribe "${options.sourceLanguage}". ` +
      `Listen v2 has no per-session language parameter for a single-language model, ` +
      `so this session would be transcribed as "${served || 'the model default'}" and ` +
      `returned as if it were correct. Use a *-multi Flux model, or deepgram-nova.`,
  );
}

export class DeepgramFluxStreamingProvider implements StreamingTranscriptionProvider {
  readonly name: string;

  constructor(private readonly config: DeepgramFluxStreamingConfig) {
    if (!config.model.startsWith('flux')) {
      // The mirror of the guard in the Nova adapter. Pointing Nova at /v2 would
      // fail just as silently in the other direction.
      throw new Error(
        `${config.model} is not a Flux model. Listen v2 serves Flux only; ` +
          `use DeepgramNovaStreamingProvider for /v1 models.`,
      );
    }
    this.name = `deepgram:${config.model}`;
  }

  async openStream(options: StreamingTranscriptionOptions): Promise<StreamingTranscriptionSession> {
    // Before the socket, not after: a refused language must cost no audio and
    // no vendor call, exactly as Nova's connect-time 400 does.
    assertFluxCanServeLanguage(this.config.model, options);
    return await DeepgramFluxSession.open(this.config, options, this.name);
  }
}

class DeepgramFluxSession implements StreamingTranscriptionSession {
  private socket: DeepgramSocket | null = null;
  private closed = false;
  /**
   * Adapter-local packetizer.
   *
   * Flux prefers 80 ms sends; Videofy's internal frame cadence is its own
   * business and must not be reshaped by a vendor's preference. So the
   * accumulation happens HERE, inside the vendor boundary, and the platform
   * keeps sending whatever size it likes.
   */
  private pending: number[] = [];
  private readonly frameSamples: number;

  private constructor(
    private readonly config: DeepgramFluxStreamingConfig,
    private readonly options: StreamingTranscriptionOptions,
    private readonly providerName: string,
  ) {
    this.frameSamples = config.frameSamples ?? FLUX_RECOMMENDED_FRAME_SAMPLES;
  }

  static async open(
    config: DeepgramFluxStreamingConfig,
    options: StreamingTranscriptionOptions,
    providerName: string,
  ): Promise<DeepgramFluxSession> {
    const session = new DeepgramFluxSession(config, options, providerName);
    await session.connect();
    return session;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Exposed for tests: how many samples are held back awaiting a full packet. */
  get bufferedSamples(): number {
    return this.pending.length;
  }

  private buildUrl(): string {
    // v2, never v1. The endpoints are not interchangeable.
    const base = this.config.baseUrl ?? 'wss://api.deepgram.com/v2/listen';
    const params = new URLSearchParams({
      model: this.config.model,
      // Both required for raw audio, per the quickstart.
      encoding: 'linear16',
      sample_rate: '16000',
    });
    if (this.config.eotThreshold !== undefined) {
      params.set('eot_threshold', String(this.config.eotThreshold));
    }
    if (this.config.eotTimeoutMs !== undefined) {
      params.set('eot_timeout_ms', String(this.config.eotTimeoutMs));
    }
    if (this.config.eagerEotThreshold !== undefined) {
      params.set('eager_eot_threshold', String(this.config.eagerEotThreshold));
    }
    if (this.config.model.includes('multi')) {
      // The SESSION's declared language outranks the deployment default: a
      // deployment-wide hint that silently overrode a per-call language is the
      // same defect in a quieter form.
      const hint =
        this.options.sourceLanguageMode === 'auto-detect'
          ? this.config.languageHint
          : (this.options.sourceLanguage?.trim() || undefined) ?? this.config.languageHint;
      if (hint !== undefined) {
        params.set('language_hint', hint);
      }
    }
    return `${base}?${params.toString()}`;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.socket = this.config.sockets(
        this.buildUrl(),
        { Authorization: `Token ${this.config.apiKey}` },
        {
          onOpen: () => {
            if (settled) return;
            settled = true;
            resolve();
          },
          onMessage: (data) => this.onMessage(data),
          onClose: (reason) => {
            this.closed = true;
            if (!settled) {
              settled = true;
              reject(new Error(`Deepgram Flux closed before opening: ${reason}`));
              return;
            }
            this.options.onDisconnected?.(reason);
          },
          onError: (error) => {
            if (!settled) {
              settled = true;
              reject(error);
              return;
            }
            this.options.onError(error);
          },
        },
      );
    });
  }

  private onMessage(raw: string): void {
    let message: FluxMessage;
    try {
      message = JSON.parse(raw) as FluxMessage;
    } catch {
      this.options.onError(new Error('Deepgram Flux sent unparseable JSON'));
      return;
    }
    if (message.type !== 'TurnInfo') return;

    const text = (message.transcript ?? '').trim();
    const startMs = toMs(message.audio_window_start);
    const endMs = toMs(message.audio_window_end);
    const confidence = message.end_of_turn_confidence ?? null;

    switch (message.event) {
      case 'StartOfTurn':
        // IGNORED, exactly as `SpeechStarted` is on the Nova side. Videofy's own
        // VAD decides when a platform segment opens; acting on this would let
        // the vendor mint a segment through the door C-AI1.1B closed.
        return;

      case 'Update':
        this.options.onSignal({
          kind: 'partial',
          text,
          providerStartMs: startMs,
          providerEndMs: endMs,
          confidence,
        });
        return;

      case 'EagerEndOfTurn':
        // SPECULATIVE. Emitted as a partial and never as a boundary, so it can
        // update captions and can NEVER trigger irreversible synthesis. The
        // vendor's own framing is a latency/false-start trade, and a false start
        // here is audible.
        this.config.log?.('flux eager end-of-turn treated as speculative', {
          provider: this.providerName,
          turn: message.turn_index,
        });
        this.options.onSignal({
          kind: 'partial',
          text,
          providerStartMs: startMs,
          providerEndMs: endMs,
          confidence,
        });
        return;

      case 'TurnResumed':
        // The eager guess was wrong and speech continued. A partial here also
        // supersedes any boundary the coordinator was waiting on, which is
        // precisely the stale-boundary case it already handles.
        this.options.onSignal({
          kind: 'partial',
          text,
          providerStartMs: startMs,
          providerEndMs: endMs,
          confidence,
        });
        return;

      case 'EndOfTurn':
        // A provider OBSERVATION that the turn ended. Videofy still decides
        // whether its segment is final; that is the whole ruling.
        this.options.onSignal({
          kind: 'final',
          text,
          providerStartMs: startMs,
          providerEndMs: endMs,
          confidence,
        });
        return;

      default:
        return;
    }
  }

  async pushAudio(frame: StreamingTranscriptionFrame): Promise<void> {
    if (this.closed) throw new Error('pushAudio after close');
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      throw new Error('Deepgram Flux socket is not open');
    }
    // Order is preserved by construction: samples are appended and drained from
    // the front in whole packets.
    for (const sample of frame.samples) this.pending.push(sample);
    this.drain(false);
  }

  /** Send whole packets; `flush` also sends a short trailing one. */
  private drain(flush: boolean): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) return;
    while (this.pending.length >= this.frameSamples) {
      const chunk = this.pending.splice(0, this.frameSamples);
      socket.send(pcmBytes(Int16Array.from(chunk)));
    }
    if (flush && this.pending.length > 0) {
      const chunk = this.pending.splice(0, this.pending.length);
      socket.send(pcmBytes(Int16Array.from(chunk)));
    }
  }

  async finish(): Promise<void> {
    if (this.closed) return;
    // Trailing audio is flushed rather than discarded: the last part-packet is
    // the end of somebody's sentence.
    this.drain(true);
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    this.pending = [];
    if (socket === null) return;
    try {
      if (socket.readyState === SOCKET_OPEN) {
        // Exact payload unverified; the socket close below is what actually
        // ends the stream, so this is best-effort courtesy.
        socket.send(JSON.stringify({ type: 'CloseStream' }));
      }
      socket.close();
    } catch {
      /* closing a dead socket is not a failure worth propagating */
    }
    this.config.log?.('flux session closed', { provider: this.providerName, reason });
  }
}

function toMs(seconds: number | undefined): number | null {
  return seconds === undefined ? null : Math.round(seconds * 1000);
}

/** The v2 vocabulary. Confined to this file by design. */
interface FluxMessage {
  type?: string;
  event?: 'StartOfTurn' | 'Update' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn';
  turn_index?: number;
  transcript?: string;
  words?: { word?: string; confidence?: number; start?: number; end?: number }[];
  end_of_turn_confidence?: number;
  audio_window_start?: number;
  audio_window_end?: number;
}
