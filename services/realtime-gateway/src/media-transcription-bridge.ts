import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import type { MediaAudioDataLike } from './media-transcription-chunker.js';
import type { SourceLanguageMode } from '@videofy-live/shared-types';
import {
  MediaTranscriptionChunker,
  MediaTranscriptionChunkerError,
  inspectPcm16Samples,
  type MediaChunkWallClock,
  type MediaTranscriptionChunk,
} from './media-transcription-chunker.js';
import { LiveIngressSender } from './live-ingress-sender.js';
import {
  requiresOperatorAttention,
  resolveLivePath,
  type LivePathDecision,
  type LivePathProfile,
} from './live-path-policy.js';
import {
  isProgrammeRunIdentity,
  type IngressTranslatedAudio,
  type ProgrammeRunIdentity,
  type RealtimeServiceContext,
} from '@videofy-live/media-ingress-wire';
import { logger } from './logger.js';

/**
 * Media-ingest processing-session ids for P6.1B native calls carry this prefix
 * (`call-runtime.ts` owns the canonical constant). It is duplicated locally on
 * purpose: the bridge is programme-path infrastructure and must not depend on
 * the call runtime, and the prefix is part of the media-ingest id contract
 * rather than of either module.
 */
/**
 * What KIND of media a session carries, and therefore how it must behave when
 * the pipeline falls behind.
 *
 * This used to be inferred from `sessionId.startsWith('call_')`. That worked
 * for exactly as long as there were two producers and one of them happened to
 * name its sessions with a prefix — and it silently gave PROGRAMME behaviour to
 * anything that did not, which for a live phone call means keeping a stale
 * backlog in preference to the sentence being spoken now.
 *
 * A naming convention is not a policy. Every producer declares what it is:
 *
 *   programme          a broadcast timeline that must stay complete
 *   live-conversation  a call, where the newest speech is what someone is
 *                      waiting to hear
 *
 * The mode is deliberately higher-level than the knobs it selects. Producers
 * say what they ARE; the bridge decides what that means. That is the same
 * boundary that keeps target languages and voices out of transport adapters.
 */
export type MediaSessionMode = 'programme' | 'live-conversation';

/**
 * The platform's service context for this session.
 *
 * DERIVED FROM THE DECLARED MODE, never from a transport or a session name.
 * Every producer already declares `mediaSessionMode`, and everything that
 * reaches this bridge is live by construction: uploaded programmes are
 * excluded upstream by `shouldUseMediaTranscriptionForProgrammeSource`, and
 * take the batch path with their complete file.
 *
 * Returned as the discriminated context the registry uses, so downstream never
 * has to infer "this arrived on a socket, so it is probably live" -- the
 * inference that decided policy by transport before P6.9.
 */
export function serviceContextForMode(
  mode: MediaSessionMode,
  programme?: ProgrammeRunIdentity | undefined,
): RealtimeServiceContext | null {
  if (mode === 'live-conversation') return { serviceCategory: 'call', mediaMode: 'live' };
  /*
   * A PROGRAMME WITHOUT ITS RUN IDENTITY DOES NOT OPEN.
   *
   * Null rather than a context with a placeholder tenant. Ingest would accept
   * the stream, transcribe it perfectly, and belong to nobody: no vocabulary,
   * no timeline partition, no way to tell two runs of one channel apart. The
   * caller refuses to open instead, which is loud, rather than broadcasting
   * something that half works.
   */
  if (programme === undefined || !isProgrammeRunIdentity(programme)) return null;
  return { serviceCategory: 'programme', mediaMode: 'live', programme };
}

/**
 * The one place a mode becomes queue behaviour. Adding a producer means
 * declaring its mode, never editing this function.
 */
function isLiveConversation(context: { mediaSessionMode: MediaSessionMode }): boolean {
  return context.mediaSessionMode === 'live-conversation';
}

/**
 * Frames held while a live stream is still being acknowledged.
 *
 * 50 frames is about a second at 20 ms. Enough to cover a local handshake
 * without turning a gateway that cannot reach media-ingest into one that
 * accumulates every call's audio in memory.
 */
const LIVE_INGRESS_PREOPEN_FRAMES = 50;

/**
 * Where live audio goes, and what comes back.
 *
 * Optional on the bridge: when it is absent the chunker path runs exactly as
 * before, which is what the batch and upload routes still want. Its presence is
 * the cutover switch, and it is a dependency rather than a flag so a
 * misconfigured deployment fails at construction instead of at the first call.
 */
export interface RealtimeIngressBinding {
  readonly url: string;
  readonly token?: string | undefined;
  readonly onTranslatedAudio?: (
    context: MediaTranscriptionBridgeContext,
    frame: IngressTranslatedAudio,
  ) => void;
  /** Injected in tests, like `createExternalAudioProcess`; production omits it. */
  readonly createSender?: (
    options: Parameters<typeof LiveIngressSender.open>[0],
  ) => Promise<LiveIngressSender>;
}

/** Recent chunks per bridge session are remembered for at most this many entries. */
const CHUNK_TIMING_HISTORY = 128;

/**
 * Wall-clock anchors for one emitted chunk, so downstream events (which carry
 * media-timeline positions, not wall clocks) can be turned into an honest
 * end-to-end latency number.
 */
export interface MediaChunkTiming {
  sequence: number;
  /**
   * Which chunk of `sequence` this entry belongs to: the partial's own
   * `partialSequence`, or null for the final chunk. Partials share their
   * final's `sequence`, so `(sequence, partialSequence)` is the identity that
   * keeps a partial's submission from being written onto the final's entry.
   */
  partialSequence: number | null;
  /** Chunk media-timeline window, exactly as submitted to media-ingest. */
  startMs: number;
  endMs: number;
  /**
   * `Date.now()` at the moment the chunker HANDED OVER the chunk.
   *
   * Historically documented as "when the last audio sample of that speech
   * segment had arrived", which it is not: a VAD segment is handed over after
   * its end-silence window has elapsed, so this sits up to `endSilenceMs` later
   * than the speech it describes, and by a different amount depending on why
   * the segment closed. Kept for the existing latency figures, which measure
   * gateway-to-delivery and are unaffected.
   *
   * Anything asking WHEN SOMEBODY SPOKE must read `wallClock` instead. W2 added
   * it precisely because this field cannot answer that question, and every
   * containment measurement built on it inherited a ~500 ms bias in the
   * direction that understates overlap.
   */
  capturedAtMs: number;
  /** `Date.now()` when media-ingest accepted the chunk; null until it does. */
  submittedAtMs: number | null;
  /** W2: true voiced extent and close reason. Absent for non-VAD chunking. */
  wallClock: MediaChunkWallClock | null;
}

export interface MediaTranscriptionBridgeContext {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
  /**
   * REQUIRED, and required on purpose. Making it optional would let a new
   * producer forget it and silently inherit programme behaviour on a live
   * call — which is precisely how the prefix inference failed. The compiler
   * now asks every producer the question instead.
   */
  mediaSessionMode: MediaSessionMode;
  /**
   * Which broadcast this is, resolved from authoritative server state.
   *
   * Required in practice for a programme and meaningless for a call, which is
   * why the WIRE type makes it part of the programme variant and this internal
   * context leaves it optional: the strictness belongs at the boundary that
   * crosses services, and the opener above fails closed without it.
   */
  programme?: ProgrammeRunIdentity;
  externalAudioSource?: 'rtmp-hls';
  externalAudioUrl?: string;
  targetLanguage?: string;
  targetLanguages?: string[];
  /**
   * W5: the subset of `targetLanguages` translated for captions but NEVER
   * synthesized — no current listener wants generated audio in them, so they
   * must not reach the default-voice fallback either.
   */
  textOnlyLanguages?: string[];
  sourceLanguage?: string;
  sourceLanguageMode?: SourceLanguageMode;
  /** Per-target standard voice overrides (P6.1B calls); media-ingest validates values. */
  voiceIdsByLanguage?: Record<string, string>;
  /**
   * Whose voice may be spoken (P6.3), when the speaker has enrolled one.
   *
   * The owner, never a resolved personal voice: media-ingest looks up the
   * current usable profile per utterance. Carried privately to media-ingest and
   * never emitted to a room, a snapshot or a log.
   */
  voiceOwnerId?: string;
  generatedAudioPacing?: 'natural' | 'fit-window';
}

export interface MediaTranscriptionSubmissionClient {
  createSession(input: MediaTranscriptionBridgeContext): Promise<void>;
  submitChunk(sessionId: string, chunk: MediaTranscriptionChunk, sourcePath: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
}

export interface MediaTranscriptionBridgeOptions {
  mediaIngestUrl?: string;
  stagingDir: string;
  chunkDurationMs?: number;
  requestTimeoutMs?: number;
  internalAuthToken?: string;
  maxRetries?: number;
  maxQueuedChunks?: number;
  maxQueuedBytes?: number;
  /**
   * Interim partial-chunk interval for CALL sessions only (default 1500 ms).
   * Programme sessions never emit partials: their recorded timeline is the
   * product, and a partial is a preview of audio the final chunk repeats.
   * Set to 0 to turn partials off for calls too.
   */
  partialIntervalMs?: number;
  vad?: ConstructorParameters<typeof MediaTranscriptionChunker>[0]['vad'];
  client?: MediaTranscriptionSubmissionClient;
  ffmpegPath?: string;
  createExternalAudioProcess?: (url: string) => ChildProcessWithoutNullStreams;
  /**
   * Cut the live path over to the realtime ingress.
   *
   * When set, `call/live` and `programme/live` audio streams as frames and no
   * WAV partial is ever written. When absent the chunker path runs exactly as
   * it did, which is what the batch and upload routes still need.
   */
  realtimeIngress?: RealtimeIngressBinding;
  /**
   * Which runtime profile this gateway is serving.
   *
   * Decides what an absent realtime ingress means: development keeps the
   * chunker, a commercial call refuses rather than silently running batch.
   * Defaults to `development-demo`, the only value for which falling back is
   * unambiguously right.
   */
  livePathProfile?: LivePathProfile;
}

/** Backpressure bookkeeping shared with the chunker's eviction callback. */
interface MediaTranscriptionBackpressureState {
  evictedChunkCount: number;
  lastEvictedSequence: number | null;
}

interface MediaTranscriptionSessionState {
  context: MediaTranscriptionBridgeContext;
  chunker: MediaTranscriptionChunker;
  /** Live path. Null until the stream is acknowledged, or forever if unused. */
  liveIngress: LiveIngressSender | null;
  liveIngressOpening: Promise<void> | null;
  /**
   * Audio captured while the stream was still being acknowledged.
   *
   * Bounded, and deliberately small: this covers the handful of frames between
   * the first packet and READY. Growing it would trade a lost half-second at
   * the very start of a call for unbounded memory on every call that fails to
   * connect.
   */
  liveIngressPending: MediaAudioDataLike[];
  liveIngressFailure: string | null;
  queue: MediaTranscriptionChunk[];
  /** Recent chunk wall-clock anchors, newest last, bounded to CHUNK_TIMING_HISTORY. */
  chunkTimings: MediaChunkTiming[];
  backpressure: MediaTranscriptionBackpressureState;
  created: boolean;
  active: boolean;
  closed: boolean;
  stopped: boolean;
  failure: string | null;
  submissionFailureCount: number;
  /** Previews that never reached media-ingest; kept apart from real speech loss. */
  partialSubmissionFailureCount: number;
  lastPartialFailureReason: string | null;
  skippedFrameCount: number;
  lastSkippedFrameReason: string | null;
  externalAudioStarted: boolean;
  externalAudioProcess: ChildProcessWithoutNullStreams | null;
  externalAudioRemainder: Buffer;
  externalAudioStderr: string;
}

export class MediaTranscriptionBridge {
  private readonly stagingDir: string;
  private readonly chunkDurationMs: number;
  private readonly maxQueuedChunks: number | undefined;
  private readonly maxQueuedBytes: number | undefined;
  private readonly partialIntervalMs: number;
  private readonly vad: MediaTranscriptionBridgeOptions['vad'];
  private readonly maxRetries: number;
  private readonly client: MediaTranscriptionSubmissionClient;
  private readonly ffmpegPath: string;
  private readonly createExternalAudioProcess: (url: string) => ChildProcessWithoutNullStreams;
  /** Present means the live path is cut over; absent keeps the chunker route. */
  private readonly realtimeIngress: RealtimeIngressBinding | null;
  /** Decides what an ABSENT realtime ingress means. See `live-path-policy`. */
  private readonly livePathProfile: LivePathProfile;
  /** Sessions refused by policy, so a repeat frame does not re-log forever. */
  private readonly refusedSessions = new Set<string>();
  private readonly sessions = new Map<string, MediaTranscriptionSessionState>();

  constructor(options: MediaTranscriptionBridgeOptions) {
    this.stagingDir = options.stagingDir;
    this.chunkDurationMs = options.chunkDurationMs ?? 5_000;
    this.maxQueuedChunks = options.maxQueuedChunks;
    this.maxQueuedBytes = options.maxQueuedBytes;
    this.partialIntervalMs = Math.max(0, options.partialIntervalMs ?? 1_500);
    this.vad = options.vad;
    this.realtimeIngress = options.realtimeIngress ?? null;
    this.livePathProfile = options.livePathProfile ?? 'development-demo';
    this.maxRetries = options.maxRetries ?? 1;
    this.ffmpegPath = options.ffmpegPath ?? process.env['FFMPEG_PATH'] ?? 'ffmpeg';
    this.createExternalAudioProcess =
      options.createExternalAudioProcess ?? ((url) => spawn(this.ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-i',
        url,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        's16le',
        'pipe:1',
      ]));
    this.client =
      options.client ??
      new HttpMediaTranscriptionSubmissionClient({
        baseUrl: options.mediaIngestUrl ?? 'http://localhost:3002',
        timeoutMs: options.requestTimeoutMs ?? 30_000,
        ...(options.internalAuthToken ? { internalAuthToken: options.internalAuthToken } : {}),
      });
  }

  /**
   * @param receivedAtMs Gateway wall clock at which this frame arrived, which
   * the media peer registry already stamps. Passed through so the chunker's
   * voiced extent describes when the audio landed rather than when it was
   * processed.
   */
  handleFrame(
    context: MediaTranscriptionBridgeContext,
    data: MediaAudioDataLike,
    receivedAtMs?: number,
  ): void {
    const session = this.getOrCreateSession(context);
    if (session.closed) return;
    if (context.externalAudioSource === 'rtmp-hls' && context.externalAudioUrl) {
      this.startExternalAudio(session);
      return;
    }
    // THE CUTOVER. When a realtime ingress is configured, live audio goes
    // straight out as frames and never becomes a WAV file on a shared disk.
    // The chunker path below remains for the batch/upload route, which
    // genuinely wants a finished file.
    const livePath = this.livePathFor(context);
    if (livePath.kind === 'refuse') {
      // FAIL CLOSED. Dropping the frame is the point: a commercial call must
      // not quietly become a batch pipeline because a URL was left unset.
      this.noteRefusedLivePath(context, livePath);
      return;
    }
    if (this.realtimeIngress !== null) {
      this.pushLive(session, data);
      return;
    }
    try {
      this.enqueueChunks(session, session.chunker.pushFrame(data, receivedAtMs));
    } catch (error) {
      if (!(error instanceof MediaTranscriptionChunkerError)) throw error;
      session.chunker.markDiscontinuity();
      session.skippedFrameCount += 1;
      session.lastSkippedFrameReason = error.message;
      logger.warn('WebRTC transcription frame skipped', {
        sessionId: context.sessionId,
        broadcastId: context.broadcastId,
        revision: context.revision,
        code: error.code,
        message: error.message,
      });
      return;
    }
    this.processQueue(session);
  }

  /** End every bridge session (any revision) that belongs to the given processing session. */
  endSessionsForSessionId(sessionId: string, reason: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.context.sessionId !== sessionId || session.closed) continue;
      this.endSession(session.context, reason);
    }
  }

  endSession(context: MediaTranscriptionBridgeContext, reason: string): void {
    const session = this.sessions.get(sessionKey(context));
    if (!session || session.closed) return;
    session.closed = true;
    if (session.externalAudioProcess) {
      session.externalAudioProcess.kill('SIGTERM');
      session.externalAudioProcess = null;
    }
    if (this.realtimeIngress !== null) {
      // FINISH, not abort: the speaker really said this and never withdrew it.
      // Aborting would silently lose the last sentence of every call.
      void (session.liveIngressOpening ?? Promise.resolve()).then(() =>
        session.liveIngress?.finish(reason),
      );
      this.maybeStopSession(session);
      return;
    }
    try {
      this.enqueueChunks(session, session.chunker.flush(true));
      this.processQueue(session);
    } catch (error) {
      session.failure = error instanceof Error ? error.message : 'WebRTC transcription flush failed.';
      logger.warn('WebRTC transcription bridge flush failed', {
        sessionId: context.sessionId,
        broadcastId: context.broadcastId,
        revision: context.revision,
        reason,
        message: session.failure,
      });
    }
    this.maybeStopSession(session);
  }

  getSnapshot(context: MediaTranscriptionBridgeContext) {
    const session = this.sessions.get(sessionKey(context));
    if (!session) return null;
    return {
      ...session.chunker.snapshot(),
      queueLength: session.queue.length,
      active: session.active,
      closed: session.closed,
      failure: session.failure,
      submissionFailureCount: session.submissionFailureCount,
      partialSubmissionFailureCount: session.partialSubmissionFailureCount,
      lastPartialFailureReason: session.lastPartialFailureReason,
      skippedFrameCount: session.skippedFrameCount,
      lastSkippedFrameReason: session.lastSkippedFrameReason,
      lastEvictedSequence: session.backpressure.lastEvictedSequence,
      externalAudioStarted: session.externalAudioStarted,
    };
  }

  /**
   * Wall-clock anchors for the chunk that produced a downstream event.
   *
   * Media-ingest events carry media-timeline positions inside the chunk they
   * came from (segment timestamps are clamped to their chunk's window), and
   * chunks cover disjoint, increasing windows. The newest chunk whose window
   * starts at or before `mediaMs` is therefore the one that produced the
   * event. Returns null when the chunk is no longer in the bounded history or
   * the session is unknown.
   *
   * Partials break the disjointness on purpose: every partial of an utterance
   * shares its final's `startMs`. Newest-wins then resolves to the newest
   * entry emitted for that utterance so far — the final once it exists, and
   * the latest partial before that. Both are honest anchors for a caption that
   * can only have come from that utterance; which of an utterance's partials
   * produced a given caption is not knowable here, so it is not guessed.
   */
  lookupChunkTiming(sessionId: string, revision: number, mediaMs: number): MediaChunkTiming | null {
    const session = this.sessions.get(`${sessionId}:${revision}`);
    if (!session) return null;
    for (let index = session.chunkTimings.length - 1; index >= 0; index--) {
      const timing = session.chunkTimings[index];
      if (timing && timing.startMs <= mediaMs) return { ...timing };
    }
    return null;
  }

  /** Per-session backpressure/failure counters, keyed without a full context. */
  getSessionCounters(
    sessionId: string,
    revision: number,
  ): { evictedChunkCount: number; skippedFrameCount: number; submissionFailureCount: number } | null {
    const session = this.sessions.get(`${sessionId}:${revision}`);
    if (!session) return null;
    return {
      evictedChunkCount: session.backpressure.evictedChunkCount,
      skippedFrameCount: session.skippedFrameCount,
      submissionFailureCount: session.submissionFailureCount,
    };
  }

  getDiagnostics(): {
    sessionCount: number;
    activeSessionCount: number;
    closedSessionCount: number;
    failedSessionCount: number;
    queuedChunkCount: number;
    evictedChunkCount: number;
  } {
    const sessions = [...this.sessions.values()];
    return {
      sessionCount: sessions.length,
      activeSessionCount: sessions.filter((session) => session.active && !session.closed).length,
      closedSessionCount: sessions.filter((session) => session.closed).length,
      failedSessionCount: sessions.filter((session) => Boolean(session.failure)).length,
      queuedChunkCount: sessions.reduce((total, session) => total + session.queue.length, 0),
      evictedChunkCount: sessions.reduce(
        (total, session) => total + session.backpressure.evictedChunkCount,
        0,
      ),
    };
  }

  /** Per-session developer diagnostics: where audio stops flowing, if it does. */
  getSessionDiagnostics(): unknown[] {
    return [...this.sessions.values()].map((session) => {
      const chunker = session.chunker.snapshot();
      return {
        sessionId: session.context.sessionId,
        revision: session.context.revision,
        created: session.created,
        active: session.active,
        closed: session.closed,
        stopped: session.stopped,
        failure: session.failure,
        queueLength: session.queue.length,
        skippedFrameCount: session.skippedFrameCount,
        lastSkippedFrameReason: session.lastSkippedFrameReason,
        submissionFailureCount: session.submissionFailureCount,
        // Recency-preserving backpressure: how much stale queued speech was
        // dropped so the newest speech could still be transcribed.
        evictedChunkCount: session.backpressure.evictedChunkCount,
        lastEvictedSequence: session.backpressure.lastEvictedSequence,
        // Streaming partial captions: how many previews went out, and how many
        // were superseded before they could (normal under load, not loss).
        partialChunkCount: chunker.partialChunkCount,
        droppedPartialChunkCount: chunker.droppedPartialChunkCount,
        lastDroppedPartialReason: chunker.lastDroppedPartialReason,
        partialSubmissionFailureCount: session.partialSubmissionFailureCount,
        lastPartialFailureReason: session.lastPartialFailureReason,
        chunker,
      };
    });
  }

  cleanupClosedSessions(): number {
    let cleaned = 0;
    for (const [key, session] of [...this.sessions]) {
      if (!session.closed || session.active || session.queue.length > 0) continue;
      this.sessions.delete(key);
      cleaned++;
    }
    return cleaned;
  }

  private getOrCreateSession(context: MediaTranscriptionBridgeContext): MediaTranscriptionSessionState {
    const key = sessionKey(context);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    // The queue and the backpressure counters are built first so the chunker's
    // eviction callback can close over them without a back-reference.
    const queue: MediaTranscriptionChunk[] = [];
    const backpressure: MediaTranscriptionBackpressureState = {
      evictedChunkCount: 0,
      lastEvictedSequence: null,
    };
    const state: MediaTranscriptionSessionState = {
      context,
      chunker: new MediaTranscriptionChunker({
        ...context,
        chunkDurationMs: this.chunkDurationMs,
        ...(this.maxQueuedChunks ? { maxQueuedChunks: this.maxQueuedChunks } : {}),
        ...(this.maxQueuedBytes ? { maxQueuedBytes: this.maxQueuedBytes } : {}),
        ...(this.vad ? { vad: this.vad } : {}),
        // A live call keeps the NEWEST speech: under sustained talking the
        // stale backlog is dropped rather than the sentence just spoken.
        // Programme sessions keep the pre-P6.1C reject-new behavior exactly.
        ...(isLiveConversation(context)
          ? {
              queueOverflowPolicy: 'evict-oldest' as const,
              onQueueOverflow: () =>
                this.evictOldestQueuedChunk(context, queue, backpressure),
              // Streaming partial captions: a call needs words on screen while
              // the sentence is still being spoken. Programme sessions get no
              // partials at all, so their emission stays byte-identical.
              ...(this.partialIntervalMs > 0
                ? { partialIntervalMs: this.partialIntervalMs }
                : {}),
            }
          : {}),
      }),
      queue,
      chunkTimings: [],
      backpressure,
      created: false,
      active: false,
      closed: false,
      stopped: false,
      failure: null,
      submissionFailureCount: 0,
      partialSubmissionFailureCount: 0,
      lastPartialFailureReason: null,
      skippedFrameCount: 0,
      lastSkippedFrameReason: null,
      externalAudioStarted: false,
      externalAudioProcess: null,
      externalAudioRemainder: Buffer.alloc(0),
      externalAudioStderr: '',
      liveIngress: null,
      liveIngressOpening: null,
      liveIngressPending: [],
      liveIngressFailure: null,
    };
    this.sessions.set(key, state);
    if (this.realtimeIngress !== null) this.startLiveIngress(state);
    return state;
  }

  /** What this session's live audio should do. Cheap; called per frame. */
  livePathFor(context: MediaTranscriptionBridgeContext): LivePathDecision {
    return resolveLivePath({
      profile: this.livePathProfile,
      mediaSessionMode: context.mediaSessionMode,
      realtimeConfigured: this.realtimeIngress !== null,
    });
  }

  private noteRefusedLivePath(
    context: MediaTranscriptionBridgeContext,
    decision: LivePathDecision,
  ): void {
    const key = sessionKey(context);
    if (this.refusedSessions.has(key)) return;
    this.refusedSessions.add(key);
    logger.error('live path refused by policy', {
      sessionId: context.sessionId,
      broadcastId: context.broadcastId,
      mediaSessionMode: context.mediaSessionMode,
      profile: this.livePathProfile,
      reason: decision.kind === 'refuse' ? decision.reason : '',
    });
  }

  private startLiveIngress(session: MediaTranscriptionSessionState): void {
    const ingress = this.realtimeIngress;
    if (ingress === null || session.liveIngressOpening !== null) return;
    const context = session.context;
    const openSender = ingress.createSender ?? ((o) => LiveIngressSender.open(o));
    /*
     * THE SESSION RECORD TRAVELS FIRST. The ingress `open` carries no target
     * languages; they ride only in the /internal/media/sessions record --
     * which, on the pure live path, nothing else ever created: the lazy
     * create in processNext belongs to the batch chunker the live path
     * replaced. Media-ingest resolved its speech plans at open against a
     * session that did not exist, planned zero languages, and a fully
     * configured live programme transcribed perfectly while translating
     * nothing. Creating the record before the sender opens is what makes the
     * plan resolution see the operator's languages.
     */
    session.liveIngressOpening = (async () => {
      if (!session.created) {
        await this.client.createSession(session.context);
        session.created = true;
      }
    })()
      .then(() => {
      const serviceContext = serviceContextForMode(context.mediaSessionMode, context.programme);
      if (serviceContext === null) {
        logger.warn('live ingress refused: a programme stream has no run identity', {
          sessionId: context.sessionId,
          broadcastId: context.broadcastId,
        });
        return;
      }
      return openSender({
      url: ingress.url,
      token: ingress.token,
      sessionId: context.sessionId,
      streamId: context.broadcastId,
      context: serviceContext,
      sourceLanguage: context.sourceLanguage,
      sourceLanguageMode: context.sourceLanguageMode,
      onTranslatedAudio: (frame) => ingress.onTranslatedAudio?.(context, frame),
      log: (line, detail) => logger.debug(line, { ...detail, sessionId: context.sessionId }),
    });
    })
      .then((sender: LiveIngressSender | undefined) => {
        // Undefined means the open was refused above -- a programme with no
        // run identity -- and there is no sender to adopt.
        if (sender === undefined) return;
        if (session.closed) {
          void sender.abort('session closed before the stream opened');
          return;
        }
        session.liveIngress = sender;
        // Whatever was captured while we were connecting is real audio that
        // was really spoken. It goes first, in order, before anything new.
        for (const pending of session.liveIngressPending) sender.pushFrame(pending);
        session.liveIngressPending = [];
      })
      .catch((error: unknown) => {
        session.liveIngressFailure =
          error instanceof Error ? error.message : 'live ingress failed to open';
        session.liveIngressPending = [];
        logger.error('live ingress failed to open', {
          sessionId: context.sessionId,
          broadcastId: context.broadcastId,
          message: session.liveIngressFailure,
        });
      });
  }

  private pushLive(session: MediaTranscriptionSessionState, data: MediaAudioDataLike): void {
    if (session.liveIngressFailure !== null) return;
    const sender = session.liveIngress;
    if (sender === null) {
      if (session.liveIngressPending.length < LIVE_INGRESS_PREOPEN_FRAMES) {
        session.liveIngressPending.push(data);
      } else if (session.liveIngressPending.length === LIVE_INGRESS_PREOPEN_FRAMES) {
        // Say so once. A silently truncated start reads as "we captured
        // everything" to whoever debugs the missing first word later.
        session.liveIngressPending.push(data);
        logger.warn('live ingress pre-open buffer full; dropping the oldest captured audio', {
          sessionId: session.context.sessionId,
          frames: session.liveIngressPending.length,
        });
        session.liveIngressPending.shift();
      } else {
        session.liveIngressPending.shift();
        session.liveIngressPending.push(data);
      }
      return;
    }
    if (!sender.pushFrame(data)) {
      session.skippedFrameCount += 1;
      session.lastSkippedFrameReason = 'live ingress declined the frame';
    }
  }

  /**
   * Hand the chunker the oldest chunk still waiting in this session's queue so
   * it can release that chunk's accounting and admit the newest one. Returns
   * null when nothing is left to give up (everything outstanding is in flight),
   * which makes the chunker reject the new chunk as `reject-new` would.
   */
  private evictOldestQueuedChunk(
    context: MediaTranscriptionBridgeContext,
    queue: MediaTranscriptionChunk[],
    backpressure: MediaTranscriptionBackpressureState,
  ): MediaTranscriptionChunk | null {
    // Partials hold no queue accounting, so handing one back would free
    // nothing. Throw them away first — they are the cheapest thing in the
    // queue to lose — and only then give up a real chunk.
    const chunker = this.sessions.get(sessionKey(context))?.chunker;
    while (queue[0]?.partial) {
      const partial = queue.shift()!;
      chunker?.dropPartialChunk(partial, 'queue-busy');
    }
    const oldest = queue.shift();
    if (!oldest) return null;
    backpressure.evictedChunkCount += 1;
    backpressure.lastEvictedSequence = oldest.sequence;
    logger.warn('WebRTC transcription queue evicted the oldest chunk to keep the newest speech', {
      sessionId: context.sessionId,
      broadcastId: context.broadcastId,
      revision: context.revision,
      evictedSequence: oldest.sequence,
      evictedDurationMs: oldest.durationMs,
      queueLengthAfterEviction: queue.length,
      evictedChunkCount: backpressure.evictedChunkCount,
    });
    return oldest;
  }

  /**
   * Queue freshly emitted chunks and stamp each one with the wall clock at
   * which its audio finished arriving, so a delivered caption or generated
   * clip can later be reported with an honest end-to-end latency.
   */
  private enqueueChunks(
    session: MediaTranscriptionSessionState,
    chunks: MediaTranscriptionChunk[],
  ): void {
    const capturedAtMs = Date.now();
    for (const chunk of chunks) {
      if (chunk.partial) {
        // A partial is worth submitting only if it can go out NOW. Anything
        // already waiting would delay it past the point where a newer partial
        // (or the final itself) supersedes it, and queueing it behind a final
        // would push that final's caption later — which is the one thing a
        // preview must never do. So: drop it, don't queue it.
        if (session.queue.length > 0) {
          session.chunker.dropPartialChunk(chunk, 'queue-busy');
          continue;
        }
      } else {
        // The final chunk carries this segment's whole utterance, so every
        // partial of that segment still waiting is now obsolete.
        this.dropSupersededPartials(session, chunk.sequence);
      }
      session.queue.push(chunk);
      session.chunkTimings.push({
        sequence: chunk.sequence,
        partialSequence: chunk.partial ? (chunk.partialSequence ?? 0) : null,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        capturedAtMs,
        submittedAtMs: null,
        wallClock: chunk.wallClock ?? null,
      });
    }
    if (session.chunkTimings.length > CHUNK_TIMING_HISTORY) {
      session.chunkTimings.splice(0, session.chunkTimings.length - CHUNK_TIMING_HISTORY);
    }
  }

  /**
   * Discard queued partials that the final chunk for `sequence` has made
   * obsolete. Their timing entries are left in place: a partial that was
   * already submitted can still produce a caption, and history is bounded
   * anyway.
   */
  private dropSupersededPartials(
    session: MediaTranscriptionSessionState,
    sequence: number,
  ): void {
    if (session.queue.length === 0) return;
    const kept = session.queue.filter((queued) => {
      if (!queued.partial || queued.sequence > sequence) return true;
      session.chunker.dropPartialChunk(queued, 'superseded');
      return false;
    });
    if (kept.length === session.queue.length) return;
    // The queue array identity is closed over by the eviction callback, so it
    // is rewritten in place rather than replaced.
    session.queue.splice(0, session.queue.length, ...kept);
  }

  private processQueue(session: MediaTranscriptionSessionState): void {
    if (session.active || session.queue.length === 0) return;
    session.active = true;
    void this.processNext(session).finally(() => {
      session.active = false;
      if (session.queue.length > 0) this.processQueue(session);
      else this.maybeStopSession(session);
    });
  }

  private startExternalAudio(session: MediaTranscriptionSessionState): void {
    if (session.externalAudioStarted || session.closed) return;
    const url = session.context.externalAudioUrl;
    if (!url) return;
    session.externalAudioStarted = true;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.createExternalAudioProcess(url);
    } catch (error) {
      session.failure = error instanceof Error ? error.message : 'RTMP HLS audio extraction failed to start.';
      logger.warn('RTMP HLS audio extraction failed to start', {
        sessionId: session.context.sessionId,
        broadcastId: session.context.broadcastId,
        revision: session.context.revision,
        message: session.failure,
      });
      return;
    }
    session.externalAudioProcess = child;
    child.stdout.on('data', (data: Buffer) => {
      if (session.closed) return;
      const samples = pcm16BufferToSamples(Buffer.concat([session.externalAudioRemainder, data]));
      session.externalAudioRemainder = samples.remainder;
      if (samples.pcm.length === 0) return;
      try {
        this.enqueueChunks(
          session,
          session.chunker.pushFrame({
            samples: samples.pcm,
            sampleRate: 16000,
            channelCount: 1,
            bitsPerSample: 16,
          }),
        );
        this.processQueue(session);
      } catch (error) {
        session.chunker.markDiscontinuity();
        session.failure = error instanceof Error ? error.message : 'RTMP HLS audio chunking failed.';
        logger.warn('RTMP HLS audio frame skipped', {
          sessionId: session.context.sessionId,
          broadcastId: session.context.broadcastId,
          revision: session.context.revision,
          message: session.failure,
        });
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      session.externalAudioStderr = `${session.externalAudioStderr}${data.toString('utf8')}`.slice(-4000);
    });
    child.on('error', (error) => {
      session.failure = error.message;
      logger.warn('RTMP HLS audio extraction process failed', {
        sessionId: session.context.sessionId,
        broadcastId: session.context.broadcastId,
        revision: session.context.revision,
        message: error.message,
      });
    });
    child.on('close', (code) => {
      if (session.externalAudioProcess === child) session.externalAudioProcess = null;
      if (session.closed) return;
      try {
        if (session.externalAudioRemainder.length > 0) {
          const samples = pcm16BufferToSamples(session.externalAudioRemainder);
          session.externalAudioRemainder = samples.remainder;
          if (samples.pcm.length > 0) {
            this.enqueueChunks(
              session,
              session.chunker.pushFrame({
                samples: samples.pcm,
                sampleRate: 16000,
                channelCount: 1,
                bitsPerSample: 16,
              }),
            );
          }
        }
        session.closed = true;
        this.enqueueChunks(session, session.chunker.flush(true));
      } catch (error) {
        session.failure = error instanceof Error ? error.message : 'RTMP HLS audio flush failed.';
      }
      if (code !== 0 && session.queue.length === 0) {
        session.failure =
          session.externalAudioStderr.trim() ||
          `RTMP HLS audio extraction exited with code ${code ?? 'unknown'}.`;
      }
      this.processQueue(session);
      this.maybeStopSession(session);
    });
    logger.info('RTMP HLS audio extraction started', {
      sessionId: session.context.sessionId,
      broadcastId: session.context.broadcastId,
      revision: session.context.revision,
    });
  }

  private async processNext(session: MediaTranscriptionSessionState): Promise<void> {
    const chunk = session.queue.shift();
    if (!chunk) return;
    let sourcePath: string | null = null;
    try {
      if (!session.created) {
        await this.client.createSession(session.context);
        session.created = true;
      }
      sourcePath = await this.writeStagedChunk(chunk);
      await this.submitWithRetry(session.context.sessionId, chunk, sourcePath);
      session.chunker.ackChunk(chunk);
      // Partials share their final's sequence, so the entry has to be matched
      // on both halves of the identity or a partial's submission would be
      // written onto the final's timing entry (and vice versa).
      const chunkPartialSequence = chunk.partial ? (chunk.partialSequence ?? 0) : null;
      const timing = session.chunkTimings.find(
        (entry) =>
          entry.sequence === chunk.sequence && entry.partialSequence === chunkPartialSequence,
      );
      if (timing) timing.submittedAtMs = Date.now();
      const audio = inspectPcm16Samples(chunk.samples);
      logger.debug('WebRTC transcription chunk submitted', {
        sessionId: chunk.sessionId,
        broadcastId: chunk.broadcastId,
        revision: chunk.revision,
        sequence: chunk.sequence,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        sampleRate: chunk.sampleRate,
        channelCount: chunk.channelCount,
        pcmFormat: chunk.pcmFormat,
        durationMs: chunk.durationMs,
        ...(chunk.partial ? { partial: true, partialSequence: chunk.partialSequence ?? 0 } : {}),
        rms: Number(audio.rms.toFixed(6)),
        peak: Number(audio.peak.toFixed(6)),
        clippedSampleCount: audio.clippedSampleCount,
        silent: audio.silent,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'WebRTC transcription submission failed.';
      // The chunk will never be acked; release its queue accounting so the
      // chunker's queuedChunks/queuedBytes limits cannot leak permanently.
      // (A partial holds no accounting, so this is a no-op for one.)
      session.chunker.releaseChunk(chunk);
      if (chunk.partial) {
        // A lost preview costs nothing: the final chunk still carries this
        // audio and will still be submitted. So it is not a hole in the
        // timeline, not speech the pipeline dropped, and not a failed session
        // — only a caption that waits for the pause it would have waited for
        // anyway. Recorded on its own counter to keep those numbers honest.
        session.partialSubmissionFailureCount += 1;
        session.lastPartialFailureReason = message;
      } else {
        session.chunker.markDiscontinuity();
        session.submissionFailureCount += 1;
        session.failure = message;
      }
      if (sourcePath) await rm(sourcePath, { force: true });
      logger.warn('WebRTC transcription chunk submission failed', {
        sessionId: chunk.sessionId,
        broadcastId: chunk.broadcastId,
        revision: chunk.revision,
        sequence: chunk.sequence,
        ...(chunk.partial ? { partial: true, partialSequence: chunk.partialSequence ?? 0 } : {}),
        message,
      });
    }
  }

  private maybeStopSession(session: MediaTranscriptionSessionState): void {
    if (!session.closed || session.active || session.queue.length > 0 || session.stopped) return;
    session.stopped = true;
    if (!session.created) return;
    void this.client.stopSession(session.context.sessionId).catch((error: unknown) => {
      logger.warn('WebRTC transcription session stop failed', {
        sessionId: session.context.sessionId,
        revision: session.context.revision,
        message: error instanceof Error ? error.message : 'unknown stop failure',
      });
    });
  }

  private async submitWithRetry(
    sessionId: string,
    chunk: MediaTranscriptionChunk,
    sourcePath: string,
  ): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.client.submitChunk(sessionId, chunk, sourcePath);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('WebRTC transcription submission failed.');
  }

  private async writeStagedChunk(chunk: MediaTranscriptionChunk): Promise<string> {
    await mkdir(this.stagingDir, { recursive: true });
    // Partials share their final's sequence, so the staged name says which one
    // it is; the uuid keeps them unique either way.
    const partialSuffix = chunk.partial
      ? `-partial-${String(chunk.partialSequence ?? 0).padStart(3, '0')}`
      : '';
    const filename = `${chunk.sessionId}-rev-${chunk.revision}-chunk-${String(chunk.sequence).padStart(6, '0')}${partialSuffix}-${randomUUID()}.wav`;
    const sourcePath = resolve(this.stagingDir, filename);
    await writeFile(sourcePath, wavBufferFromPcm(chunk.samples, chunk.sampleRate, chunk.channelCount));
    return sourcePath;
  }
}

export class HttpMediaTranscriptionSubmissionClient
  implements MediaTranscriptionSubmissionClient
{
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly internalAuthToken: string | undefined;

  constructor(options: { baseUrl: string; timeoutMs: number; internalAuthToken?: string }) {
    this.baseUrl = new URL(options.baseUrl);
    this.timeoutMs = options.timeoutMs;
    this.internalAuthToken = options.internalAuthToken;
  }

  async createSession(input: MediaTranscriptionBridgeContext): Promise<void> {
    await this.postJson('/internal/media/sessions', {
      sessionId: input.sessionId,
      broadcastId: input.broadcastId,
      broadcasterPeerId: input.broadcasterPeerId,
      revision: input.revision,
      ...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
      ...(input.targetLanguages ? { targetLanguages: input.targetLanguages } : {}),
      ...(input.textOnlyLanguages && input.textOnlyLanguages.length > 0
        ? { textOnlyLanguages: input.textOnlyLanguages }
        : {}),
      ...(input.sourceLanguage ? { sourceLanguage: input.sourceLanguage } : {}),
      ...(input.sourceLanguageMode ? { sourceLanguageMode: input.sourceLanguageMode } : {}),
      ...(input.generatedAudioPacing ? { generatedAudioPacing: input.generatedAudioPacing } : {}),
      ...(input.voiceIdsByLanguage && Object.keys(input.voiceIdsByLanguage).length > 0
        ? { voiceIdsByLanguage: input.voiceIdsByLanguage }
        : {}),
      ...(input.voiceOwnerId ? { voiceOwnerId: input.voiceOwnerId } : {}),
    });
  }

  async submitChunk(
    sessionId: string,
    chunk: MediaTranscriptionChunk,
    sourcePath: string,
  ): Promise<void> {
    await this.postJson(`/internal/media/sessions/${encodeURIComponent(sessionId)}/chunks`, {
      sequence: chunk.sequence,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      sampleRate: chunk.sampleRate,
      channelCount: chunk.channelCount,
      pcmFormat: chunk.pcmFormat,
      discontinuity: chunk.discontinuity,
      endOfStream: chunk.endOfStream,
      // Only partials carry these: a final chunk's body stays exactly what it
      // has always been, so nothing about the programme path changes.
      ...(chunk.partial ? { partial: true, partialSequence: chunk.partialSequence ?? 0 } : {}),
      mimeType: 'audio/wav',
      sizeBytes: chunk.byteLength + 44,
      sourcePath,
    });
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.postJson(`/internal/media/sessions/${encodeURIComponent(sessionId)}/stop`, {});
  }

  /**
   * Remove a retired `call_` session from media-ingest entirely. A 404 means
   * the session is already gone ({removed:false}) — a defined, benign outcome
   * for this idempotent cleanup, so it resolves rather than rejecting.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.send(
      'DELETE',
      `/internal/media/sessions/${encodeURIComponent(sessionId)}`,
      null,
      [404],
    );
  }

  private postJson(pathname: string, body: Record<string, unknown>): Promise<void> {
    return this.send('POST', pathname, body);
  }

  private send(
    method: 'POST' | 'DELETE',
    pathname: string,
    body: Record<string, unknown> | null,
    acceptedStatusCodes: number[] = [],
  ): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const payload = body === null ? null : Buffer.from(JSON.stringify(body));
      const url = new URL(pathname, this.baseUrl);
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          method,
          headers: {
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
              : {}),
            ...(this.internalAuthToken ? { 'X-Videofy-Internal-Token': this.internalAuthToken } : {}),
          },
          timeout: this.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const statusCode = response.statusCode ?? 0;
            if (
              (statusCode >= 200 && statusCode < 300) ||
              acceptedStatusCodes.includes(statusCode)
            ) {
              resolvePromise();
              return;
            }
            const message = Buffer.concat(chunks).toString('utf8') || `HTTP ${statusCode}`;
            reject(new Error(`Media ingest WebRTC request failed: ${message}`));
          });
        },
      );
      request.on('timeout', () => {
        request.destroy(new Error('Media ingest WebRTC request timed out.'));
      });
      request.on('error', reject);
      if (payload) {
        request.end(payload);
      } else {
        request.end();
      }
    });
  }
}

export function wavBufferFromPcm(samples: Int16Array, sampleRate: number, channelCount: number): Buffer {
  const header = Buffer.alloc(44);
  const dataBytes = samples.byteLength;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channelCount * 2, 28);
  header.writeUInt16LE(channelCount * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

function sessionKey(context: MediaTranscriptionBridgeContext): string {
  return `${context.sessionId}:${context.revision}`;
}

function pcm16BufferToSamples(buffer: Buffer): { pcm: Int16Array; remainder: Buffer } {
  const byteLength = buffer.length - (buffer.length % 2);
  const pcm = new Int16Array(byteLength / 2);
  for (let index = 0; index < pcm.length; index++) {
    pcm[index] = buffer.readInt16LE(index * 2);
  }
  return {
    pcm,
    remainder: byteLength === buffer.length ? Buffer.alloc(0) : buffer.subarray(byteLength),
  };
}
