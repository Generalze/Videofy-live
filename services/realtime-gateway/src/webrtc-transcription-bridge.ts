import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import type { WebRtcAudioDataLike } from './webrtc-audio-ingest-bridge.js';
import type { SourceLanguageMode } from '@videofy-live/shared-types';
import {
  WebRtcTranscriptionChunker,
  WebRtcTranscriptionChunkerError,
  inspectPcm16Samples,
  type WebRtcTranscriptionChunk,
} from './webrtc-transcription-chunker.js';
import { logger } from './logger.js';

/**
 * Media-ingest processing-session ids for P6.1B native calls carry this prefix
 * (`call-runtime.ts` owns the canonical constant). It is duplicated locally on
 * purpose: the bridge is programme-path infrastructure and must not depend on
 * the call runtime, and the prefix is part of the media-ingest id contract
 * rather than of either module.
 */
const CALL_BRIDGE_SESSION_PREFIX = 'call_';

function isCallBridgeSessionId(sessionId: string): boolean {
  return sessionId.startsWith(CALL_BRIDGE_SESSION_PREFIX);
}

/** Recent chunks per bridge session are remembered for at most this many entries. */
const CHUNK_TIMING_HISTORY = 128;

/**
 * Wall-clock anchors for one emitted chunk, so downstream events (which carry
 * media-timeline positions, not wall clocks) can be turned into an honest
 * end-to-end latency number.
 */
export interface WebRtcChunkTiming {
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
   * `Date.now()` at the moment the chunker finished the chunk — i.e. when the
   * last audio sample of that speech segment had arrived at the gateway.
   * Frames arrive in real time, so this is the wall clock of `endMs`.
   */
  capturedAtMs: number;
  /** `Date.now()` when media-ingest accepted the chunk; null until it does. */
  submittedAtMs: number | null;
}

export interface WebRtcTranscriptionBridgeContext {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
  externalAudioSource?: 'rtmp-hls';
  externalAudioUrl?: string;
  targetLanguage?: string;
  targetLanguages?: string[];
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

export interface WebRtcTranscriptionSubmissionClient {
  createSession(input: WebRtcTranscriptionBridgeContext): Promise<void>;
  submitChunk(sessionId: string, chunk: WebRtcTranscriptionChunk, sourcePath: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
}

export interface WebRtcTranscriptionBridgeOptions {
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
  vad?: ConstructorParameters<typeof WebRtcTranscriptionChunker>[0]['vad'];
  client?: WebRtcTranscriptionSubmissionClient;
  ffmpegPath?: string;
  createExternalAudioProcess?: (url: string) => ChildProcessWithoutNullStreams;
}

/** Backpressure bookkeeping shared with the chunker's eviction callback. */
interface WebRtcTranscriptionBackpressureState {
  evictedChunkCount: number;
  lastEvictedSequence: number | null;
}

interface WebRtcTranscriptionSessionState {
  context: WebRtcTranscriptionBridgeContext;
  chunker: WebRtcTranscriptionChunker;
  queue: WebRtcTranscriptionChunk[];
  /** Recent chunk wall-clock anchors, newest last, bounded to CHUNK_TIMING_HISTORY. */
  chunkTimings: WebRtcChunkTiming[];
  backpressure: WebRtcTranscriptionBackpressureState;
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

export class WebRtcTranscriptionBridge {
  private readonly stagingDir: string;
  private readonly chunkDurationMs: number;
  private readonly maxQueuedChunks: number | undefined;
  private readonly maxQueuedBytes: number | undefined;
  private readonly partialIntervalMs: number;
  private readonly vad: WebRtcTranscriptionBridgeOptions['vad'];
  private readonly maxRetries: number;
  private readonly client: WebRtcTranscriptionSubmissionClient;
  private readonly ffmpegPath: string;
  private readonly createExternalAudioProcess: (url: string) => ChildProcessWithoutNullStreams;
  private readonly sessions = new Map<string, WebRtcTranscriptionSessionState>();

  constructor(options: WebRtcTranscriptionBridgeOptions) {
    this.stagingDir = options.stagingDir;
    this.chunkDurationMs = options.chunkDurationMs ?? 5_000;
    this.maxQueuedChunks = options.maxQueuedChunks;
    this.maxQueuedBytes = options.maxQueuedBytes;
    this.partialIntervalMs = Math.max(0, options.partialIntervalMs ?? 1_500);
    this.vad = options.vad;
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
      new HttpWebRtcTranscriptionSubmissionClient({
        baseUrl: options.mediaIngestUrl ?? 'http://localhost:3002',
        timeoutMs: options.requestTimeoutMs ?? 30_000,
        ...(options.internalAuthToken ? { internalAuthToken: options.internalAuthToken } : {}),
      });
  }

  handleFrame(context: WebRtcTranscriptionBridgeContext, data: WebRtcAudioDataLike): void {
    const session = this.getOrCreateSession(context);
    if (session.closed) return;
    if (context.externalAudioSource === 'rtmp-hls' && context.externalAudioUrl) {
      this.startExternalAudio(session);
      return;
    }
    try {
      this.enqueueChunks(session, session.chunker.pushFrame(data));
    } catch (error) {
      if (!(error instanceof WebRtcTranscriptionChunkerError)) throw error;
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

  endSession(context: WebRtcTranscriptionBridgeContext, reason: string): void {
    const session = this.sessions.get(sessionKey(context));
    if (!session || session.closed) return;
    session.closed = true;
    if (session.externalAudioProcess) {
      session.externalAudioProcess.kill('SIGTERM');
      session.externalAudioProcess = null;
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

  getSnapshot(context: WebRtcTranscriptionBridgeContext) {
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
  lookupChunkTiming(sessionId: string, revision: number, mediaMs: number): WebRtcChunkTiming | null {
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

  private getOrCreateSession(context: WebRtcTranscriptionBridgeContext): WebRtcTranscriptionSessionState {
    const key = sessionKey(context);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    // The queue and the backpressure counters are built first so the chunker's
    // eviction callback can close over them without a back-reference.
    const queue: WebRtcTranscriptionChunk[] = [];
    const backpressure: WebRtcTranscriptionBackpressureState = {
      evictedChunkCount: 0,
      lastEvictedSequence: null,
    };
    const state: WebRtcTranscriptionSessionState = {
      context,
      chunker: new WebRtcTranscriptionChunker({
        ...context,
        chunkDurationMs: this.chunkDurationMs,
        ...(this.maxQueuedChunks ? { maxQueuedChunks: this.maxQueuedChunks } : {}),
        ...(this.maxQueuedBytes ? { maxQueuedBytes: this.maxQueuedBytes } : {}),
        ...(this.vad ? { vad: this.vad } : {}),
        // A live call keeps the NEWEST speech: under sustained talking the
        // stale backlog is dropped rather than the sentence just spoken.
        // Programme sessions keep the pre-P6.1C reject-new behavior exactly.
        ...(isCallBridgeSessionId(context.sessionId)
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
    };
    this.sessions.set(key, state);
    return state;
  }

  /**
   * Hand the chunker the oldest chunk still waiting in this session's queue so
   * it can release that chunk's accounting and admit the newest one. Returns
   * null when nothing is left to give up (everything outstanding is in flight),
   * which makes the chunker reject the new chunk as `reject-new` would.
   */
  private evictOldestQueuedChunk(
    context: WebRtcTranscriptionBridgeContext,
    queue: WebRtcTranscriptionChunk[],
    backpressure: WebRtcTranscriptionBackpressureState,
  ): WebRtcTranscriptionChunk | null {
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
    session: WebRtcTranscriptionSessionState,
    chunks: WebRtcTranscriptionChunk[],
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
    session: WebRtcTranscriptionSessionState,
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

  private processQueue(session: WebRtcTranscriptionSessionState): void {
    if (session.active || session.queue.length === 0) return;
    session.active = true;
    void this.processNext(session).finally(() => {
      session.active = false;
      if (session.queue.length > 0) this.processQueue(session);
      else this.maybeStopSession(session);
    });
  }

  private startExternalAudio(session: WebRtcTranscriptionSessionState): void {
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

  private async processNext(session: WebRtcTranscriptionSessionState): Promise<void> {
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

  private maybeStopSession(session: WebRtcTranscriptionSessionState): void {
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
    chunk: WebRtcTranscriptionChunk,
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

  private async writeStagedChunk(chunk: WebRtcTranscriptionChunk): Promise<string> {
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

export class HttpWebRtcTranscriptionSubmissionClient
  implements WebRtcTranscriptionSubmissionClient
{
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly internalAuthToken: string | undefined;

  constructor(options: { baseUrl: string; timeoutMs: number; internalAuthToken?: string }) {
    this.baseUrl = new URL(options.baseUrl);
    this.timeoutMs = options.timeoutMs;
    this.internalAuthToken = options.internalAuthToken;
  }

  async createSession(input: WebRtcTranscriptionBridgeContext): Promise<void> {
    await this.postJson('/internal/webrtc/sessions', {
      sessionId: input.sessionId,
      broadcastId: input.broadcastId,
      broadcasterPeerId: input.broadcasterPeerId,
      revision: input.revision,
      ...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
      ...(input.targetLanguages ? { targetLanguages: input.targetLanguages } : {}),
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
    chunk: WebRtcTranscriptionChunk,
    sourcePath: string,
  ): Promise<void> {
    await this.postJson(`/internal/webrtc/sessions/${encodeURIComponent(sessionId)}/chunks`, {
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
    await this.postJson(`/internal/webrtc/sessions/${encodeURIComponent(sessionId)}/stop`, {});
  }

  /**
   * Remove a retired `call_` session from media-ingest entirely. A 404 means
   * the session is already gone ({removed:false}) — a defined, benign outcome
   * for this idempotent cleanup, so it resolves rather than rejecting.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.send(
      'DELETE',
      `/internal/webrtc/sessions/${encodeURIComponent(sessionId)}`,
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

function sessionKey(context: WebRtcTranscriptionBridgeContext): string {
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
