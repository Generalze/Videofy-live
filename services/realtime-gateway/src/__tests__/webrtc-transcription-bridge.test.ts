import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WebRtcTranscriptionBridge,
  wavBufferFromPcm,
  type WebRtcTranscriptionBridgeContext,
  type WebRtcTranscriptionSubmissionClient,
} from '../webrtc-transcription-bridge.js';
import type { WebRtcTranscriptionChunk } from '../webrtc-transcription-chunker.js';

const context: WebRtcTranscriptionBridgeContext = {
  sessionId: 'wrs_demo',
  broadcastId: 'broadcast_demo',
  broadcasterPeerId: 'peer_broadcaster',
  revision: 1,
};

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('WebRtcTranscriptionBridge', () => {
  it('maps ordered chunks to the media-ingest transcription boundary', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      client,
    });

    bridge.handleFrame(context, {
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });

    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));
    expect(client.created).toEqual([context]);
    expect(client.submitted[0]?.chunk).toMatchObject({
      sessionId: 'wrs_demo',
      sequence: 0,
      startMs: 0,
      endMs: 100,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
    });
    const written = await readFile(client.submitted[0]!.sourcePath);
    expect(written.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(written.subarray(8, 12).toString('ascii')).toBe('WAVE');
  });

  it('flushes the final partial chunk and stops the session idempotently', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      client,
    });

    bridge.handleFrame(context, {
      samples: new Int16Array(800),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });
    bridge.endSession(context, 'test stop');
    bridge.endSession(context, 'duplicate stop');

    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));
    expect(client.submitted[0]?.chunk).toMatchObject({
      sequence: 0,
      startMs: 0,
      endMs: 50,
      endOfStream: true,
    });
    expect(client.stopped).toEqual(['wrs_demo']);
  });

  it('retries submission failure without creating duplicate chunks', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient({ failSubmitAttempts: 1 });
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      maxRetries: 1,
      client,
    });

    bridge.handleFrame(context, {
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });

    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));
    expect(client.submitAttempts).toBe(2);
    expect(client.submitted.map((entry) => entry.chunk.sequence)).toEqual([0]);
  });

  it('creates a fresh revision so stale restart audio cannot mix', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      client,
    });
    const restarted = { ...context, revision: 2 };

    bridge.handleFrame(context, {
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });
    bridge.handleFrame(restarted, {
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });

    await vi.waitFor(() => expect(client.submitted).toHaveLength(2));
    expect(client.created.map((entry) => entry.revision).sort()).toEqual([1, 2]);
    expect(client.submitted.map((entry) => `${entry.chunk.revision}:${entry.chunk.sequence}`).sort()).toEqual([
      '1:0',
      '2:0',
    ]);
  });

  it('creates one configured processing session for programme WebRTC transcription', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      client,
    });
    const configuredContext: WebRtcTranscriptionBridgeContext = {
      ...context,
      targetLanguage: 'es',
      targetLanguages: ['es'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'auto-detect',
    };

    bridge.handleFrame(configuredContext, {
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });
    bridge.handleFrame(configuredContext, {
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });

    await vi.waitFor(() => expect(client.submitted).toHaveLength(2));
    expect(client.created).toEqual([configuredContext]);
    expect(client.submitted.map((entry) => entry.sessionId)).toEqual(['wrs_demo', 'wrs_demo']);
  });

  it('uses RTMP HLS external audio instead of silent browser-captured HLS frames', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const external = fakeExternalAudioProcess();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      client,
      createExternalAudioProcess: () => external.process,
    });
    const rtmpContext: WebRtcTranscriptionBridgeContext = {
      ...context,
      externalAudioSource: 'rtmp-hls',
      externalAudioUrl: 'http://127.0.0.1:8888/live/videofy-demo/index.m3u8',
    };

    bridge.handleFrame(rtmpContext, {
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });
    external.writePcm(new Int16Array(1600).fill(4000));

    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));
    expect(client.created).toEqual([rtmpContext]);
    expect(client.submitted[0]?.chunk.sequence).toBe(0);
    expect(client.submitted[0]?.chunk.samples.every((sample) => sample === 0)).toBe(false);
    expect(bridge.getSnapshot(rtmpContext)).toMatchObject({
      externalAudioStarted: true,
      skippedFrameCount: 0,
      failure: null,
    });
  });

  it('skips malformed first frames without interrupting later transcription', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      client,
    });

    bridge.handleFrame(context, {
      samples: new Int16Array([1, 2, 3]),
      sampleRate: 16000,
      channelCount: 2,
      bitsPerSample: 24,
    });
    bridge.handleFrame(context, {
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });

    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));
    expect(bridge.getSnapshot(context)).toMatchObject({
      skippedFrameCount: 1,
      lastSkippedFrameReason: 'WebRTC audio frame sample layout is invalid.',
      failure: null,
    });
    expect(client.submitted[0]?.chunk).toMatchObject({
      sequence: 0,
      discontinuity: true,
    });
  });

  it('rejects bit-depth-mismatched Int16 frames without interrupting later transcription', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      client,
    });

    bridge.handleFrame(context, {
      samples: new Int16Array(1600).fill(4000),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 24,
    });
    bridge.handleFrame(context, {
      samples: new Int16Array(1600).fill(4000),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });

    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));
    expect(bridge.getSnapshot(context)).toMatchObject({
      skippedFrameCount: 1,
      lastSkippedFrameReason:
        'WebRTC audio frame bit depth 24 is unsupported; expected 16-bit int16 PCM.',
      failure: null,
    });
    expect(client.submitted[0]?.chunk).toMatchObject({
      sequence: 0,
      sampleRate: 16000,
      channelCount: 1,
      pcmFormat: 'pcm_s16le',
      discontinuity: true,
    });
  });

  it('releases queue accounting for failed submissions so later chunks still emit', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient({ failSubmitAttempts: 8 });
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      maxRetries: 0,
      client,
    });

    // Default chunker queue limit is 8 chunks; every submission fails, so
    // without failure-path release the ninth chunk could never be created.
    for (let index = 0; index < 8; index++) {
      bridge.handleFrame(context, {
        samples: new Int16Array(1600),
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 16,
      });
    }
    await vi.waitFor(() => expect(client.submitAttempts).toBe(8));
    expect(client.submitted).toHaveLength(0);

    bridge.handleFrame(context, {
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });

    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));
    expect(bridge.getSnapshot(context)).toMatchObject({
      skippedFrameCount: 0,
      queuedChunks: 0,
      queuedBytes: 0,
    });
  });

  it('reports diagnostics and cleans closed sessions after queues drain', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      client,
    });

    bridge.handleFrame(context, {
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });
    bridge.endSession(context, 'test cleanup');

    await vi.waitFor(() => expect(client.stopped).toEqual(['wrs_demo']));
    expect(bridge.getDiagnostics()).toMatchObject({
      sessionCount: 1,
      closedSessionCount: 1,
      queuedChunkCount: 0,
    });
    expect(bridge.cleanupClosedSessions()).toBe(1);
    expect(bridge.getDiagnostics()).toMatchObject({ sessionCount: 0 });
  });
});

function fakeClient(options: { failSubmitAttempts?: number } = {}) {
  let failuresRemaining = options.failSubmitAttempts ?? 0;
  const client: WebRtcTranscriptionSubmissionClient & {
    created: WebRtcTranscriptionBridgeContext[];
    submitted: { sessionId: string; chunk: WebRtcTranscriptionChunk; sourcePath: string }[];
    stopped: string[];
    submitAttempts: number;
  } = {
    created: [],
    submitted: [],
    stopped: [],
    submitAttempts: 0,
    async createSession(input) {
      this.created.push(input);
    },
    async submitChunk(sessionId, chunk, sourcePath) {
      this.submitAttempts += 1;
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('planned submit failure');
      }
      this.submitted.push({ sessionId, chunk, sourcePath });
    },
    async stopSession(sessionId) {
      if (!this.stopped.includes(sessionId)) this.stopped.push(sessionId);
    },
  };
  return client;
}

function fakeExternalAudioProcess() {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(process, {
    stdout,
    stderr,
    stdin: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return {
    process,
    writePcm(samples: Int16Array) {
      stdout.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    },
    close(code = 0) {
      process.emit('close', code);
    },
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'videofy-webrtc-'));
  tempDirs.push(dir);
  return dir;
}

describe('wavBufferFromPcm', () => {
  it('writes playable WAV headers for PCM16 audio', () => {
    const wav = wavBufferFromPcm(new Int16Array(160), 16000, 1);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
  });
});
