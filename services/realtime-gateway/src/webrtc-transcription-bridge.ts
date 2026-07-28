import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import type { WebRtcAudioDataLike } from './webrtc-audio-ingest-bridge.js';
import {
  WebRtcTranscriptionChunker,
  WebRtcTranscriptionChunkerError,
  type WebRtcTranscriptionChunk,
} from './webrtc-transcription-chunker.js';
import { logger } from './logger.js';

export interface WebRtcTranscriptionBridgeContext {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
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
}

export class WebRtcTranscriptionBridge {
  private readonly stagingDir: string;
  private readonly chunkDurationMs: number;
  private readonly maxQueuedChunks: number | undefined;
  private readonly maxQueuedBytes: number | undefined;
  private readonly vad: WebRtcTranscriptionBridgeOptions['vad'];
  private readonly maxRetries: number;
  private readonly client: WebRtcTranscriptionSubmissionClient;
  private readonly sessions = new Map<string, WebRtcTranscriptionSessionState>();

  constructor(options: WebRtcTranscriptionBridgeOptions) {
    this.stagingDir = options.stagingDir;
    this.chunkDurationMs = options.chunkDurationMs ?? 15_000;
    this.maxQueuedChunks = options.maxQueuedChunks;
    this.maxQueuedBytes = options.maxQueuedBytes;
    this.vad = options.vad;
    this.maxRetries = options.maxRetries ?? 1;
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

  endSession(context: WebRtcTranscriptionBridgeContext, reason: string): void {
    const session = this.sessions.get(sessionKey(context));
    if (!session || session.closed) return;
    session.closed = true;
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
      logger.debug('WebRTC transcription chunk submitted', {
        sessionId: chunk.sessionId,
        broadcastId: chunk.broadcastId,
        revision: chunk.revision,
        sequence: chunk.sequence,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
      });
    } catch (error) {
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

  private postJson(pathname: string, body: Record<string, unknown>): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const url = new URL(pathname, this.baseUrl);
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(payload.length),
            ...(this.internalAuthToken ? { 'X-Videofy-Internal-Token': this.internalAuthToken } : {}),
          },
          timeout: this.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
              resolvePromise();
              return;
            }
            const message = Buffer.concat(chunks).toString('utf8') || `HTTP ${response.statusCode}`;
            reject(new Error(`Media ingest WebRTC request failed: ${message}`));
          });
        },
      );
      request.on('timeout', () => {
        request.destroy(new Error('Media ingest WebRTC request timed out.'));
      });
      request.on('error', reject);
      request.end(payload);
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
