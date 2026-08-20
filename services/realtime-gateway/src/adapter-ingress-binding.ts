/** @author masterzee001 */
/**
 * Where a transport adapter's audio becomes platform media.
 *
 * This is the piece P6.9 exists for. Until now every Phase 6 adapter — SIP,
 * Zoom, LiveKit — normalized its transport correctly and handed perfect 16 kHz
 * frames to `RecordingMediaAdapterPort`, an in-memory double. This binding is
 * what puts a gateway behind that seam.
 *
 * It supplies the two things `AdapterIngressConnection` deliberately does not
 * decide for itself:
 *
 *   StreamResolver     which session a capability names, and whether this
 *                      participant may be spoken for at all
 *   AdapterMediaSink   what happens to an accepted frame
 *
 * and it answers the second by making adapter audio the FOURTH producer on the
 * one media pipeline — beside the browser broadcast path, the native call path,
 * and whatever comes next. Not a second pipeline. `call-runtime` already proved
 * the pattern; this follows it rather than inventing a parallel one.
 *
 * Two boundaries it must not cross, both of which have cost this project a
 * round already:
 *
 * PRODUCT POLICY IS PLATFORM-OWNED. Target languages, voices, pacing and
 * interpretation configuration are resolved here from route and organisation
 * configuration, never from anything the adapter sent. An adapter that could
 * name a language would be an adapter that knows what the engine is.
 *
 * SESSION IDENTITY IS RESOLVED, NOT ACCEPTED. The capability names the session;
 * nothing the adapter supplies does. `AdapterAuthority.authorize` has no
 * parameter for a session id, so this file could not take the adapter's word
 * for it even if it wanted to.
 */
import type {
  AdapterMediaSink,
  IngressMediaFrame,
  ResolvedStream,
  StreamResolver,
} from '@videofy-live/adapter-ingress';
import type { AdapterWireOutcome, StreamOpen } from '@videofy-live/adapter-wire';
import type { AdapterAuthority } from '@videofy-live/adapter-authority';
import type { VideofySessionId } from '@videofy-live/media-adapter-port/platform';
import type { MediaAudioDataLike } from './media-transcription-chunker.js';
import type {
  MediaSessionMode,
  MediaTranscriptionBridgeContext,
} from './media-transcription-bridge.js';

/**
 * Everything the PLATFORM decides about a session.
 *
 * Deliberately the complete set of things an adapter may not choose. If a field
 * ever appears here that an adapter also supplies, the boundary has moved.
 */
export interface AdapterSessionPolicy {
  readonly targetLanguages?: readonly string[];
  readonly textOnlyLanguages?: readonly string[];
  readonly sourceLanguage?: string;
  readonly sourceLanguageMode?: 'manual' | 'auto-detect';
  readonly voiceIdsByLanguage?: Record<string, string>;
}

export interface AdapterSessionPolicyResolver {
  /**
   * Resolved from route and organisation configuration. The adapter's own
   * reference is passed for correlation and logging ONLY — deciding a language
   * from it would be deciding product behaviour from transport metadata.
   */
  resolve(input: {
    readonly videofySessionId: VideofySessionId;
    readonly routeRef: string;
    readonly adapterId: string;
    readonly adapterSessionRef: string;
  }): Promise<AdapterSessionPolicy>;
}

/** The subset of the bridge this binding drives. Same shape calls use. */
export interface AdapterTranscriptionBridgeLike {
  handleFrame(
    context: MediaTranscriptionBridgeContext,
    data: MediaAudioDataLike,
    receivedAtMs?: number,
  ): void;
  endSession(context: MediaTranscriptionBridgeContext, reason: string): void;
}

export interface AdapterIngressBindingDeps {
  readonly authority: AdapterAuthority;
  readonly policy: AdapterSessionPolicyResolver;
  readonly bridge: AdapterTranscriptionBridgeLike;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

interface BoundStream {
  readonly context: MediaTranscriptionBridgeContext;
}

const LIVE_CONVERSATION: MediaSessionMode = 'live-conversation';

export class AdapterIngressBinding implements StreamResolver, AdapterMediaSink {
  /**
   * Keyed by the adapter's own reference and participant, because that is what
   * an accepted frame carries back. The platform session lives in the context
   * stored here, so it is never re-derived from anything the adapter sent.
   */
  private readonly bound = new Map<string, BoundStream>();
  private readonly log: (line: string, detail?: Record<string, unknown>) => void;

  constructor(private readonly deps: AdapterIngressBindingDeps) {
    const sink = deps.log;
    this.log =
      sink === undefined
        ? () => {}
        : (line, detail) => {
            try {
              sink(line, detail);
            } catch {
              /* a broken reporter must not drop a call */
            }
          };
  }

  /**
   * Decide whether this stream may exist, and what session it belongs to.
   *
   * `push-audio` is the operation asked about deliberately: it is the one that
   * checks participant scope, and a stream is precisely permission to send
   * media for that participant. Asking a weaker question here would let a
   * stream open for someone the platform has never been told about, and P6.8
   * spent a round on the consequence of media arriving for exactly that.
   */
  async resolve(open: StreamOpen): Promise<ResolvedStream | AdapterWireOutcome> {
    const resolved = this.deps.authority.authorize(
      open.sessionCapability,
      'push-audio',
      open.participantId,
    );
    if (typeof resolved === 'string') {
      this.log('adapter stream refused', {
        outcome: resolved,
        adapterSessionRef: open.adapterSessionRef,
      });
      return resolved;
    }

    const policy = await this.deps.policy.resolve({
      videofySessionId: resolved.videofySessionId,
      routeRef: resolved.routeRef,
      adapterId: resolved.adapterId,
      adapterSessionRef: resolved.adapterSessionRef,
    });

    const context: MediaTranscriptionBridgeContext = {
      // The PLATFORM's session, resolved from the capability. The adapter's
      // own reference never becomes this.
      sessionId: resolved.videofySessionId,
      broadcastId: `adaptercast_${resolved.videofySessionId}_${open.participantId}`,
      broadcasterPeerId: adapterPublisherPeerId(open.participantId),
      revision: 1,
      // Declared, not inferred from a session-id prefix. A phone call keeps the
      // newest speech when the pipeline falls behind: the person on the other
      // end is waiting on the sentence being spoken now.
      mediaSessionMode: LIVE_CONVERSATION,
      ...(policy.sourceLanguage === undefined ? {} : { sourceLanguage: policy.sourceLanguage }),
      ...(policy.sourceLanguageMode === undefined
        ? {}
        : { sourceLanguageMode: policy.sourceLanguageMode }),
      ...(policy.targetLanguages === undefined
        ? {}
        : { targetLanguages: [...policy.targetLanguages] }),
      ...(policy.targetLanguages?.[0] === undefined
        ? {}
        : { targetLanguage: policy.targetLanguages[0] }),
      ...(policy.textOnlyLanguages === undefined || policy.textOnlyLanguages.length === 0
        ? {}
        : { textOnlyLanguages: [...policy.textOnlyLanguages] }),
      ...(policy.voiceIdsByLanguage === undefined
        ? {}
        : { voiceIdsByLanguage: policy.voiceIdsByLanguage }),
    };

    this.bound.set(keyFor(resolved.adapterSessionRef, open.participantId), { context });
    return { adapterSessionRef: resolved.adapterSessionRef, participantId: open.participantId };
  }

  /**
   * Hand an accepted frame to the pipeline every other producer already uses.
   *
   * The outcome is returned rather than thrown, so the wire can settle it or
   * dispose of it explicitly. Silence is not a result: on this boundary a frame
   * that vanishes without a disposition is one the sender waits on forever.
   */
  async deliver(frame: IngressMediaFrame): Promise<AdapterWireOutcome> {
    const stream = this.bound.get(keyFor(frame.adapterSessionRef, frame.participantId));
    if (stream === undefined) return 'rejected-stale';
    try {
      this.deps.bridge.handleFrame(
        stream.context,
        {
          samples: frame.samples,
          sampleRate: 16000,
          channelCount: 1,
          bitsPerSample: 16,
          numberOfFrames: frame.samples.length,
        },
        // ARRIVAL, not the adapter's media clock. The chunker measures
        // residence against this, and handing it a media timestamp would make
        // every network hiccup look like the speaker pausing.
        frame.gatewayReceivedAtMs,
      );
      return 'accepted';
    } catch (error) {
      // The chunker refuses when its own bounds are reached. That is a real
      // answer, not a failure to answer, and the sender is told which.
      const message = error instanceof Error ? error.message : 'unknown';
      this.log('adapter frame refused by the media pipeline', { message });
      return 'dropped-backpressure';
    }
  }

  /** Release a stream. Idempotent: a close that arrives twice is ordinary. */
  releaseStream(adapterSessionRef: string, participantId: string, reason: string): void {
    const key = keyFor(adapterSessionRef, participantId);
    const stream = this.bound.get(key);
    if (stream === undefined) return;
    this.bound.delete(key);
    this.deps.bridge.endSession(stream.context, reason);
  }

  /** Every stream of one adapter session, for a hangup. */
  releaseSession(adapterSessionRef: string, reason: string): void {
    for (const [key, stream] of [...this.bound]) {
      if (!key.startsWith(`${adapterSessionRef}\u0000`)) continue;
      this.bound.delete(key);
      this.deps.bridge.endSession(stream.context, reason);
    }
  }

  get boundStreamCount(): number {
    return this.bound.size;
  }
}

/**
 * The publisher identity a participant's audio is attributed to.
 *
 * Mirrors `callPublisherPeerId` rather than reusing it, because a call and an
 * adapter session are different producers that happen to need the same shape —
 * sharing the function would make one of them change when the other did.
 */
export function adapterPublisherPeerId(participantId: string): string {
  return `adapter_pub_${participantId}`;
}

/** NUL-separated, so a participant id containing the separator cannot forge a key. */
function keyFor(adapterSessionRef: string, participantId: string): string {
  return `${adapterSessionRef}\u0000${participantId}`;
}
