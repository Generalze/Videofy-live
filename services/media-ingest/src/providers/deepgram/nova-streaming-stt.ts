/** @author masterzee001 */
/**
 * Deepgram live transcription, normalized into the platform signal contract.
 *
 * EVIDENCE (read 2026-08-22):
 *   wss://api.deepgram.com/v1/listen
 *   encoding accepts `linear16`; parameters include encoding, sample_rate,
 *   channels, model, language, interim_results, endpointing, utterance_end_ms,
 *   vad_events, punctuate
 *   client control messages: Finalize, CloseStream, KeepAlive
 *   server messages: Results, Metadata, UtteranceEnd, SpeechStarted
 *   result flags: is_final, speech_final
 *   -- developers.deepgram.com/reference/speech-to-text-api/listen-streaming
 *   -- developers.deepgram.com/docs/understand-endpointing-interim-results
 *
 * NOT VERIFIED, and therefore configured rather than assumed: the reference
 * lists `sample_rate` without enumerating valid values. 16000 is what the
 * platform produces and what is sent; the credential-gated smoke test is what
 * confirms the service accepts it.
 *
 * THE NORMALIZATION THAT MATTERS. Deepgram's own documentation warns:
 * "Do not use `speech_final: true` alone to capture full transcripts. Long
 * utterances may have multiple `is_final: true` responses before
 * `speech_final: true` is returned." So a naive adapter that forwarded each
 * result as the utterance text would emit the LAST FRAGMENT of a long sentence
 * as though it were the whole thing -- and the platform contract requires
 * CUMULATIVE text per utterance. This adapter therefore accumulates finalized
 * fragments and emits the running total, which is exactly the vendor-shaped
 * knowledge that must not leak past the adapter boundary.
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

/**
 * The `utterance_end_ms` used when a SESSION asks for endpointing and the
 * deployment has not named a value.
 *
 * This exists because the option was dead. `LiveStreamPipeline.open` sets
 * `requestEndpointing: true` on every live session, and no adapter read it --
 * so Nova was never sent `utterance_end_ms`, never sent `vad_events`, and never
 * emitted a single `endpoint` signal in production. The platform's
 * candidate-boundary path was inert while the source said it was asking for
 * boundaries (measured 2026-08-30: 0 endpoint signals across 38 live samples).
 *
 * 1000 ms is the vendor's minimum. It is chosen deliberately low because an
 * endpoint here is only a CANDIDATE: the segment coordinator runs it through
 * the same stabilization window as local VAD, resumed speech cancels it, and a
 * second corroborating signal cannot restart the window. A boundary the
 * platform declines to act on costs nothing; a boundary it never hears about
 * cannot be declined.
 *
 * An explicit `utteranceEndMs` in config still wins -- this is the floor for a
 * deployment that asked for endpointing without naming a number.
 */
export const DEFAULT_UTTERANCE_END_MS = 1000;

/**
 * Does this model accept `keyterm`?
 *
 * Nova-3 does. Nova-2 and earlier take the older `keywords` parameter with
 * different semantics, and an unrecognised parameter is IGNORED rather than
 * rejected -- so a deployment on the wrong model would boost nothing while the
 * console showed the term as consumed. Exported so the capability reported to
 * an operator is derived from the same rule that builds the request, and cannot
 * drift from it.
 */
export function supportsKeyterms(model: string): boolean {
  return /^nova-3/u.test(model.trim().toLowerCase());
}

export interface DeepgramNovaStreamingConfig {
  readonly apiKey: string;
  /** e.g. `nova-3` or `flux-general-en`. Recorded per-model in the registry. */
  readonly model: string;
  readonly baseUrl?: string;
  /** Silence-based endpoint threshold in ms. */
  readonly endpointingMs?: number;
  readonly utteranceEndMs?: number;
  readonly punctuate?: boolean;
  readonly sockets: DeepgramSocketFactory;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export class DeepgramNovaStreamingProvider implements StreamingTranscriptionProvider {
  readonly name: string;

  constructor(private readonly config: DeepgramNovaStreamingConfig) {
    // A Flux model here would connect to /v1 and be parsed with the Nova
    // vocabulary -- a beautifully tested adapter speaking the wrong protocol,
    // producing silence that looks like a quiet speaker. Refused loudly.
    if (config.model.startsWith('flux')) {
      throw new Error(
        `${config.model} is a Flux model and speaks Listen v2 (TurnInfo). ` +
          `Use DeepgramFluxStreamingProvider; /v1/listen will not work for it.`,
      );
    }
    // The MODEL is part of the identity. Two Deepgram models are different
    // products with different jobs, and a benchmark that said only "deepgram"
    // would be uncomparable with the next one.
    this.name = `deepgram:${config.model}`;
  }

  async openStream(options: StreamingTranscriptionOptions): Promise<StreamingTranscriptionSession> {
    return await DeepgramNovaSession.open(this.config, options, this.name);
  }
}

class DeepgramNovaSession implements StreamingTranscriptionSession {
  private socket: DeepgramSocket | null = null;
  private closed = false;
  /** Fragments the vendor has already finalized within the current utterance. */
  private committed: string[] = [];
  private lastInterim = '';

  private constructor(
    private readonly config: DeepgramNovaStreamingConfig,
    private readonly options: StreamingTranscriptionOptions,
    private readonly providerName: string,
  ) {}

  static async open(
    config: DeepgramNovaStreamingConfig,
    options: StreamingTranscriptionOptions,
    providerName: string,
  ): Promise<DeepgramNovaSession> {
    const session = new DeepgramNovaSession(config, options, providerName);
    await session.connect();
    return session;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private buildUrl(): string {
    const base = this.config.baseUrl ?? 'wss://api.deepgram.com/v1/listen';
    const params = new URLSearchParams({
      // Raw PCM exactly as the platform produces it: 16-bit signed little-endian.
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      model: this.config.model,
      // Interim hypotheses are what make realtime captions possible.
      interim_results: 'true',
      punctuate: String(this.config.punctuate ?? true),
    });
    if (this.config.endpointingMs !== undefined) {
      params.set('endpointing', String(this.config.endpointingMs));
    }
    // Asking for UtteranceEnd gives a boundary signal that survives a noisy
    // channel where silence detection alone would not fire. The SESSION may ask
    // for it (`requestEndpointing`) even when the deployment names no value;
    // before this, such a request was silently discarded.
    const utteranceEndMs =
      this.config.utteranceEndMs ??
      (this.options.requestEndpointing === true ? DEFAULT_UTTERANCE_END_MS : undefined);
    if (utteranceEndMs !== undefined) {
      params.set('utterance_end_ms', String(utteranceEndMs));
      params.set('vad_events', 'true');
    }
    if (this.options.sourceLanguage !== undefined && this.options.sourceLanguageMode !== 'auto-detect') {
      params.set('language', this.options.sourceLanguage);
    }

    /*
     * PROGRAMME VOCABULARY as Deepgram keyterms.
     *
     * `keyterm` is a NOVA-3 parameter. Earlier models take the older `keywords`
     * form with different semantics, and sending `keyterm` to them is silently
     * ignored -- which would leave an operator believing a presenter's name was
     * boosted when nothing was. So it is gated on the model actually in use and
     * the capability is reported honestly elsewhere; see
     * `supportsKeyterms` below, which is what the console reads.
     *
     * Repeated, one parameter per term, because that is the wire format.
     */
    if (supportsKeyterms(this.config.model)) {
      for (const term of this.options.keyterms ?? []) {
        if (term.trim() !== '') params.append('keyterm', term);
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
              reject(new Error(`Deepgram closed before opening: ${reason}`));
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
    let message: DeepgramMessage;
    try {
      message = JSON.parse(raw) as DeepgramMessage;
    } catch {
      // Unparseable output is a provider fault, not a platform one. Reported,
      // never allowed to crash the session.
      this.options.onError(new Error('Deepgram sent unparseable JSON'));
      return;
    }

    if (message.type === 'UtteranceEnd') {
      // A boundary observation with no transcript attached. Advisory: the
      // coordinator decides whether it ends the Videofy segment.
      this.options.onSignal({ kind: 'endpoint' });
      return;
    }
    if (message.type === 'SpeechStarted') {
      // Deliberately ignored. Videofy's own VAD decides when a segment opens;
      // acting on this would let the vendor start a platform segment.
      return;
    }
    if (message.type !== undefined && message.type !== 'Results') return;

    const alternative = message.channel?.alternatives?.[0];
    if (alternative === undefined) return;
    const text = (alternative.transcript ?? '').trim();
    const start = message.start ?? null;
    const end =
      message.start !== undefined && message.duration !== undefined
        ? message.start + message.duration
        : null;
    const confidence = alternative.confidence ?? null;

    if (message.is_final !== true) {
      this.lastInterim = text;
      this.options.onSignal({
        kind: 'partial',
        text: this.cumulative(),
        providerStartMs: toMs(start),
        providerEndMs: toMs(end),
        confidence,
      });
      return;
    }

    // `is_final` finalizes THIS FRAGMENT, not the utterance.
    if (text !== '') this.committed.push(text);
    this.lastInterim = '';

    if (message.speech_final === true) {
      const full = this.cumulative();
      this.committed = [];
      this.options.onSignal({
        kind: 'final',
        text: full,
        providerStartMs: toMs(start),
        providerEndMs: toMs(end),
        confidence,
      });
      return;
    }

    // Stable fragment, utterance continuing. Still a partial to the platform.
    this.options.onSignal({
      kind: 'partial',
      text: this.cumulative(),
      providerStartMs: toMs(start),
      providerEndMs: toMs(end),
      confidence,
    });
  }

  /** Everything heard in the current utterance so far, as the contract requires. */
  private cumulative(): string {
    return [...this.committed, this.lastInterim].filter((part) => part !== '').join(' ');
  }

  async pushAudio(frame: StreamingTranscriptionFrame): Promise<void> {
    if (this.closed) throw new Error('pushAudio after close');
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      throw new Error('Deepgram socket is not open');
    }
    if (frame.discontinuity === true) {
      // Tell the provider the audio is not continuous. Without this it happily
      // transcribes across the gap and produces a fluent, confident, wrong
      // sentence joining two unrelated halves.
      socket.send(JSON.stringify({ type: 'Finalize' }));
      this.config.log?.('finalized across a discontinuity', {
        provider: this.providerName,
      });
    }
    socket.send(pcmBytes(frame.samples));
  }

  async finish(): Promise<void> {
    const socket = this.socket;
    if (socket === null || this.closed) return;
    // Flush: ask for whatever the model is still holding.
    socket.send(JSON.stringify({ type: 'Finalize' }));
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    try {
      if (socket.readyState === SOCKET_OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }));
      socket.close();
    } catch {
      /* closing a dead socket is not a failure worth propagating */
    }
    this.config.log?.('deepgram session closed', { provider: this.providerName, reason });
  }
}

function toMs(seconds: number | null): number | null {
  return seconds === null ? null : Math.round(seconds * 1000);
}

/** The vendor's message shape. Confined to this file by design. */
interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: { transcript?: string; confidence?: number }[];
  };
}
