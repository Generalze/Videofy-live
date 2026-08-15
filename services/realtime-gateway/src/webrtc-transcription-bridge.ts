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
  vad?: ConstructorParameters<typeof WebRtcTranscriptionChunker>[0]['vad'];
  client?: WebRtcTranscriptionSubmissionClient;
  ffmpegPath?: string;
  createExternalAudioProcess?: (url: string) => ChildProcessWithoutNullStreams;
}

interface WebRtcTranscriptionSessionState {
  context: WebRtcTranscriptionBridgeContext;
  chunker: WebRtcTranscriptionChunker;
  queue: WebRtcTranscriptionChunk[];
  created: boolean;
  active: boolean;
  closed: boolean;
  stopped: boolean;
  failure: string | null;
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
      const chunks = session.chunker.pushFrame(data);
      for (const chunk of chunks) {
        session.queue.push(chunk);
      }
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
      for (const chunk of session.chunker.flush(true)) {
        session.queue.push(chunk);
      }
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
      skippedFrameCount: session.skippedFrameCount,
      lastSkippedFrameReason: session.lastSkippedFrameReason,
      externalAudioStarted: session.externalAudioStarted,
    };
  }

  getDiagnostics(): {
    sessionCount: number;
    activeSessionCount: number;
    closedSessionCount: number;
    failedSessionCount: number;
    queuedChunkCount: number;
  } {
    const sessions = [...this.sessions.values()];
    return {
      sessionCount: sessions.length,
      activeSessionCount: sessions.filter((session) => session.active && !session.closed).length,
      closedSessionCount: sessions.filter((session) => session.closed).length,
      failedSessionCount: sessions.filter((session) => Boolean(session.failure)).length,
      queuedChunkCount: sessions.reduce((total, session) => total + session.queue.length, 0),
    };
  }

  /** Per-session developer diagnostics: where audio stops flowing, if it does. */
  getSessionDiagnostics(): unknown[] {
    return [...this.sessions.values()].map((session) => ({
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
      chunker: session.chunker.snapshot(),
    }));
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
    const state: WebRtcTranscriptionSessionState = {
      context,
      chunker: new WebRtcTranscriptionChunker({
        ...context,
        chunkDurationMs: this.chunkDurationMs,
        ...(this.maxQueuedChunks ? { maxQueuedChunks: this.maxQueuedChunks } : {}),
        ...(this.maxQueuedBytes ? { maxQueuedBytes: this.maxQueuedBytes } : {}),
        ...(this.vad ? { vad: this.vad } : {}),
      }),
      queue: [],
      created: false,
      active: false,
      closed: false,
      stopped: false,
      failure: null,
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
        const chunks = session.chunker.pushFrame({
          samples: samples.pcm,
          sampleRate: 16000,
          channelCount: 1,
          bitsPerSample: 16,
        });
        for (const chunk of chunks) session.queue.push(chunk);
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
            for (const chunk of session.chunker.pushFrame({
              samples: samples.pcm,
              sampleRate: 16000,
              channelCount: 1,
              bitsPerSample: 16,
            })) session.queue.push(chunk);
          }
        }
        session.closed = true;
        for (const chunk of session.chunker.flush(true)) session.queue.push(chunk);
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
        rms: Number(audio.rms.toFixed(6)),
        peak: Number(audio.peak.toFixed(6)),
        clippedSampleCount: audio.clippedSampleCount,
        silent: audio.silent,
      });
    } catch (error) {
      // The chunk will never be acked; release its queue accounting so the
      // chunker's queuedChunks/queuedBytes limits cannot leak permanently.
      session.chunker.releaseChunk(chunk);
      session.chunker.markDiscontinuity();
      session.failure = error instanceof Error ? error.message : 'WebRTC transcription submission failed.';
      if (sourcePath) await rm(sourcePath, { force: true });
      logger.warn('WebRTC transcription chunk submission failed', {
        sessionId: chunk.sessionId,
        broadcastId: chunk.broadcastId,
        revision: chunk.revision,
        sequence: chunk.sequence,
        message: session.failure,
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
    const filename = `${chunk.sessionId}-rev-${chunk.revision}-chunk-${String(chunk.sequence).padStart(6, '0')}-${randomUUID()}.wav`;
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
