import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HttpWebRtcTranscriptionSubmissionClient,
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

  it('keeps the NEWEST speech for call sessions by evicting the oldest queued chunk', async () => {
    const stagingDir = await tempDir();
    const gate = manualSubmitGate();
    const client = fakeClient({ gate });
    const callContext: WebRtcTranscriptionBridgeContext = {
      ...context,
      sessionId: 'call_demo_participant_1_r2',
      broadcastId: 'callcast_demo_participant_1_r2',
    };
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      maxQueuedChunks: 3,
      client,
    });

    // Chunk 0 is taken in flight and held there; 1 and 2 fill the queue.
    for (let index = 0; index < 3; index++) speak(bridge, callContext);
    await vi.waitFor(() => expect(client.submitAttempts).toBe(1));
    expect(bridge.getSnapshot(callContext)).toMatchObject({ queuedChunks: 3, queueLength: 2 });

    // Chunk 3 does not fit: the OLDEST QUEUED chunk (1) is dropped, not the new
    // one, and the in-flight chunk 0 is left alone.
    speak(bridge, callContext);
    expect(bridge.getSnapshot(callContext)).toMatchObject({
      queueOverflowPolicy: 'evict-oldest',
      queuedChunks: 3,
      queueLength: 2,
      evictedChunkCount: 1,
      lastEvictedSequence: 1,
      // Eviction is not a frame skip: no speech was refused at the input.
      skippedFrameCount: 0,
    });

    gate.release();
    await vi.waitFor(() => expect(client.submitted).toHaveLength(3));
    // The stale chunk 1 never reached media-ingest; the newest chunk 3 did.
    expect(client.submitted.map((entry) => entry.chunk.sequence)).toEqual([0, 2, 3]);
    expect(bridge.getSnapshot(callContext)).toMatchObject({ queuedChunks: 0, queuedBytes: 0 });
    expect(bridge.getSessionCounters('call_demo_participant_1_r2', 1)).toEqual({
      evictedChunkCount: 1,
      skippedFrameCount: 0,
      submissionFailureCount: 0,
    });
    expect(bridge.getDiagnostics()).toMatchObject({ evictedChunkCount: 1 });
  });

  it('keeps programme sessions on reject-new so the recorded timeline stays complete', async () => {
    const stagingDir = await tempDir();
    const gate = manualSubmitGate();
    const client = fakeClient({ gate });
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      maxQueuedChunks: 3,
      client,
    });

    for (let index = 0; index < 3; index++) speak(bridge, context);
    await vi.waitFor(() => expect(client.submitAttempts).toBe(1));
    speak(bridge, context);

    // Byte-identical pre-P6.1C behavior: the NEW chunk is skipped, the backlog
    // is kept, and nothing is evicted.
    expect(bridge.getSnapshot(context)).toMatchObject({
      queueOverflowPolicy: 'reject-new',
      queuedChunks: 3,
      queueLength: 2,
      evictedChunkCount: 0,
      skippedFrameCount: 1,
      lastSkippedFrameReason: 'WebRTC transcription chunk queue limit exceeded.',
    });

    gate.release();
    await vi.waitFor(() => expect(client.submitted).toHaveLength(3));
    expect(client.submitted.map((entry) => entry.chunk.sequence)).toEqual([0, 1, 2]);
  });

  it('anchors each chunk to wall clock so a delivered event can be timed honestly', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      chunkDurationMs: 100,
      client,
    });

    const before = Date.now();
    speak(bridge, context);
    speak(bridge, context);
    await vi.waitFor(() => expect(client.submitted).toHaveLength(2));
    const after = Date.now();

    // A media position inside the second chunk resolves to the second chunk.
    const timing = bridge.lookupChunkTiming('wrs_demo', 1, 150);
    expect(timing).toMatchObject({ sequence: 1, startMs: 100, endMs: 200 });
    expect(timing?.capturedAtMs).toBeGreaterThanOrEqual(before);
    expect(timing?.capturedAtMs).toBeLessThanOrEqual(after);
    expect(timing?.submittedAtMs).toBeGreaterThanOrEqual(timing!.capturedAtMs);

    expect(bridge.lookupChunkTiming('wrs_demo', 1, 0)).toMatchObject({ sequence: 0, startMs: 0 });
    // Unknown session or revision is reported as unknown, never guessed.
    expect(bridge.lookupChunkTiming('wrs_demo', 99, 150)).toBeNull();
    expect(bridge.getSessionCounters('wrs_missing', 1)).toBeNull();
  });

  it('streams interim partials for a call while the sentence is still being spoken', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      client,
      vad: partialVad,
      partialIntervalMs: 300,
    });

    talk(bridge, callContext, 3);
    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));
    expect(client.submitted[0]?.chunk).toMatchObject({
      sequence: 0,
      partial: true,
      partialSequence: 0,
      startMs: 0,
      endMs: 300,
      endOfStream: false,
    });

    talk(bridge, callContext, 3);
    await vi.waitFor(() => expect(client.submitted).toHaveLength(2));
    expect(client.submitted[1]?.chunk).toMatchObject({
      sequence: 0,
      partial: true,
      partialSequence: 1,
      startMs: 0,
      endMs: 600,
    });

    pause(bridge, callContext);
    await vi.waitFor(() => expect(client.submitted).toHaveLength(3));
    const final = client.submitted[2]!.chunk;
    // Same sequence as its partials, and the WHOLE utterance: 600 ms of speech
    // plus the 100 ms pause that closed the segment.
    expect(final).toMatchObject({ sequence: 0, startMs: 0, endMs: 700, durationMs: 700 });
    expect(final.partial).toBeUndefined();
    expect(final.partialSequence).toBeUndefined();
    expect(final.samples.length).toBe(11_200);
    expect(bridge.getSnapshot(callContext)).toMatchObject({
      partialIntervalMs: 300,
      partialChunkCount: 2,
      droppedPartialChunkCount: 0,
      queuedChunks: 0,
      queuedBytes: 0,
    });
  });

  it('never streams partials for programme sessions, whatever the interval', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      client,
      vad: partialVad,
      partialIntervalMs: 300,
    });

    talk(bridge, context, 6);
    pause(bridge, context);

    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));
    expect(client.submitted[0]?.chunk).toMatchObject({ sequence: 0, startMs: 0, endMs: 700 });
    expect(client.submitted[0]?.chunk.partial).toBeUndefined();
    expect(bridge.getSnapshot(context)).toMatchObject({
      partialIntervalMs: 0,
      partialChunkCount: 0,
      droppedPartialChunkCount: 0,
    });
  });

  it('drops a partial instead of queueing it behind work that would delay it', async () => {
    const stagingDir = await tempDir();
    const gate = manualSubmitGate();
    const client = fakeClient({ gate });
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      client,
      vad: partialVad,
      partialIntervalMs: 300,
    });

    // Partial 0 goes in flight and is held there; partial 1 takes the empty
    // queue; partial 2 finds the queue busy and is dropped rather than stacked.
    talk(bridge, callContext, 9);
    await vi.waitFor(() => expect(client.submitAttempts).toBe(1));
    expect(bridge.getSnapshot(callContext)).toMatchObject({
      queueLength: 1,
      partialChunkCount: 3,
      droppedPartialChunkCount: 1,
      lastDroppedPartialReason: 'queue-busy',
      // Partials hold no queue capacity at all, so the accounting a final
      // depends on is untouched.
      queuedChunks: 0,
      queuedBytes: 0,
      skippedFrameCount: 0,
    });

    // The final supersedes the partial still waiting for its segment.
    pause(bridge, callContext);
    expect(bridge.getSnapshot(callContext)).toMatchObject({
      queueLength: 1,
      droppedPartialChunkCount: 2,
      lastDroppedPartialReason: 'superseded',
      queuedChunks: 1,
    });

    gate.release();
    await vi.waitFor(() => expect(client.submitted).toHaveLength(2));
    expect(
      client.submitted.map((entry) => ({
        sequence: entry.chunk.sequence,
        partialSequence: entry.chunk.partial ? entry.chunk.partialSequence : 'final',
        endMs: entry.chunk.endMs,
      })),
    ).toEqual([
      { sequence: 0, partialSequence: 0, endMs: 300 },
      { sequence: 0, partialSequence: 'final', endMs: 1000 },
    ]);
    expect(bridge.getSnapshot(callContext)).toMatchObject({ queuedChunks: 0, queuedBytes: 0 });
  });

  it('drops a queued partial the moment its own final chunk is ready', async () => {
    const stagingDir = await tempDir();
    const gate = manualSubmitGate();
    const client = fakeClient({ gate });
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      client,
      vad: partialVad,
      partialIntervalMs: 300,
    });

    // Sentence one is in flight and held; sentence two previews into the queue.
    talk(bridge, callContext, 2);
    pause(bridge, callContext);
    await vi.waitFor(() => expect(client.submitAttempts).toBe(1));
    talk(bridge, callContext, 3);
    expect(bridge.getSnapshot(callContext)).toMatchObject({
      queueLength: 1,
      partialChunkCount: 1,
      droppedPartialChunkCount: 0,
    });

    pause(bridge, callContext);
    expect(bridge.getSnapshot(callContext)).toMatchObject({
      queueLength: 1,
      droppedPartialChunkCount: 1,
      lastDroppedPartialReason: 'superseded',
    });

    gate.release();
    await vi.waitFor(() => expect(client.submitted).toHaveLength(2));
    expect(
      client.submitted.map((entry) => `${entry.chunk.sequence}:${entry.chunk.partial ?? false}`),
    ).toEqual(['0:false', '1:false']);
    expect(client.submitted[1]?.chunk).toMatchObject({ startMs: 300, endMs: 700 });
  });

  it('never lets a partial delay or evict a final chunk', async () => {
    const stagingDir = await tempDir();
    const gate = manualSubmitGate();
    const client = fakeClient({ gate });
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      client,
      maxQueuedChunks: 2,
      vad: partialVad,
      partialIntervalMs: 300,
    });

    // Final 0 in flight (held), final 1 queued: the queue budget is full.
    talk(bridge, callContext, 2);
    pause(bridge, callContext);
    await vi.waitFor(() => expect(client.submitAttempts).toBe(1));
    talk(bridge, callContext, 2);
    pause(bridge, callContext);
    expect(bridge.getSnapshot(callContext)).toMatchObject({ queuedChunks: 2, queueLength: 1 });

    // A partial arriving now takes nothing from the finals: it is not queued
    // ahead of final 1, and it does not evict anything to make room.
    talk(bridge, callContext, 3);
    expect(bridge.getSnapshot(callContext)).toMatchObject({
      queuedChunks: 2,
      queueLength: 1,
      partialChunkCount: 1,
      droppedPartialChunkCount: 1,
      lastDroppedPartialReason: 'queue-busy',
      evictedChunkCount: 0,
    });

    // Only the next FINAL evicts, and it evicts the oldest FINAL, as before.
    pause(bridge, callContext);
    expect(bridge.getSnapshot(callContext)).toMatchObject({
      queuedChunks: 2,
      evictedChunkCount: 1,
      lastEvictedSequence: 1,
    });

    gate.release();
    await vi.waitFor(() => expect(client.submitted).toHaveLength(2));
    expect(client.submitted.map((entry) => entry.chunk.sequence)).toEqual([0, 2]);
    expect(client.submitted.every((entry) => entry.chunk.partial === undefined)).toBe(true);
    expect(bridge.getSnapshot(callContext)).toMatchObject({ queuedChunks: 0, queuedBytes: 0 });
  });

  it('gives up a queued partial before a real chunk when the queue must make room', async () => {
    const stagingDir = await tempDir();
    const gate = manualSubmitGate();
    const client = fakeClient({ gate });
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      client,
      maxQueuedChunks: 1,
      vad: partialVad,
      partialIntervalMs: 300,
    });

    // The single queue slot is held by final 0, in flight; the queue itself is
    // empty, so the next sentence's preview is admitted into it.
    talk(bridge, callContext, 2);
    pause(bridge, callContext);
    await vi.waitFor(() => expect(client.submitAttempts).toBe(1));
    talk(bridge, callContext, 3);
    expect(bridge.getSnapshot(callContext)).toMatchObject({ queueLength: 1, queuedChunks: 1 });

    // Final 1 needs room. The partial is surrendered first and is NOT reported
    // as evicted speech: nothing that was going to be transcribed was lost.
    pause(bridge, callContext);
    expect(bridge.getSnapshot(callContext)).toMatchObject({
      queueLength: 0,
      queuedChunks: 1,
      evictedChunkCount: 0,
      lastEvictedSequence: null,
      droppedPartialChunkCount: 1,
      lastDroppedPartialReason: 'queue-busy',
      skippedFrameCount: 1,
    });

    gate.release();
    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));
    expect(client.submitted[0]?.chunk).toMatchObject({ sequence: 0, endMs: 300 });
    expect(bridge.getSnapshot(callContext)).toMatchObject({ queuedChunks: 0, queuedBytes: 0 });
  });

  it('treats a failed preview as a missed caption, not as lost speech', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient({ failSubmitAttempts: 1 });
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      client,
      maxRetries: 0,
      vad: partialVad,
      partialIntervalMs: 300,
    });

    talk(bridge, callContext, 3);
    await vi.waitFor(() => expect(client.submitAttempts).toBe(1));
    expect(client.submitted).toHaveLength(0);

    // Two more frames: not enough new speech for a second preview, so the next
    // thing submitted is the final chunk itself.
    talk(bridge, callContext, 2);
    pause(bridge, callContext);
    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));

    // The utterance still arrives whole, and NOT flagged as following a hole:
    // the audio the lost preview carried is inside this very chunk.
    expect(client.submitted[0]?.chunk).toMatchObject({
      sequence: 0,
      startMs: 0,
      endMs: 600,
      discontinuity: false,
    });
    expect(client.submitted[0]?.chunk.samples.length).toBe(9600);
    expect(bridge.getSnapshot(callContext)).toMatchObject({
      failure: null,
      submissionFailureCount: 0,
      partialSubmissionFailureCount: 1,
      lastPartialFailureReason: 'planned submit failure',
    });
    expect(bridge.getDiagnostics()).toMatchObject({ failedSessionCount: 0 });
  });

  it('times a partial on its own clock without corrupting the final chunk entry', async () => {
    const stagingDir = await tempDir();
    const client = fakeClient();
    const bridge = new WebRtcTranscriptionBridge({
      stagingDir,
      client,
      vad: partialVad,
      partialIntervalMs: 300,
    });

    talk(bridge, callContext, 3);
    await vi.waitFor(() => expect(client.submitted).toHaveLength(1));
    const partialTiming = bridge.lookupChunkTiming(callContext.sessionId, 1, 100);
    expect(partialTiming).toMatchObject({
      sequence: 0,
      partialSequence: 0,
      startMs: 0,
      endMs: 300,
    });
    expect(partialTiming?.submittedAtMs).not.toBeNull();

    talk(bridge, callContext, 3);
    pause(bridge, callContext);
    await vi.waitFor(() => expect(client.submitted).toHaveLength(3));

    // The final owns its own entry: sharing `sequence` with its partials must
    // not leave it looking unsubmitted or borrow their capture clock.
    const finalTiming = bridge.lookupChunkTiming(callContext.sessionId, 1, 100);
    expect(finalTiming).toMatchObject({ sequence: 0, partialSequence: null, endMs: 700 });
    expect(finalTiming?.submittedAtMs).not.toBeNull();
    expect(finalTiming?.capturedAtMs).toBeGreaterThanOrEqual(partialTiming!.capturedAtMs);
    expect(finalTiming?.submittedAtMs!).toBeGreaterThanOrEqual(partialTiming!.submittedAtMs!);
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

/** One 100 ms speech frame, i.e. exactly one chunk at chunkDurationMs: 100. */
function speak(bridge: WebRtcTranscriptionBridge, context: WebRtcTranscriptionBridgeContext): void {
  bridge.handleFrame(context, {
    samples: new Int16Array(1600),
    sampleRate: 16000,
    channelCount: 1,
    bitsPerSample: 16,
  });
}

/** `call_` ids are what switch the bridge into call behavior. */
const callContext: WebRtcTranscriptionBridgeContext = {
  ...context,
  sessionId: 'call_demo_participant_1_r2',
  broadcastId: 'callcast_demo_participant_1_r2',
};

/** VAD tuned for 100 ms frames: one silent frame ends the sentence. */
const partialVad = {
  enabled: true,
  mode: 'fallback',
  speechThreshold: 0.01,
  minSpeechMs: 100,
  endSilenceMs: 100,
  maxSegmentMs: 60_000,
} as const;

/** `frames` × 100 ms of speech: audible, so the VAD keeps the segment open. */
function talk(
  bridge: WebRtcTranscriptionBridge,
  target: WebRtcTranscriptionBridgeContext,
  frames: number,
): void {
  for (let index = 0; index < frames; index++) {
    bridge.handleFrame(target, {
      samples: new Int16Array(1600).fill(10_000),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });
  }
}

/** 100 ms of silence, i.e. the pause that closes a VAD segment. */
function pause(
  bridge: WebRtcTranscriptionBridge,
  target: WebRtcTranscriptionBridgeContext,
): void {
  bridge.handleFrame(target, {
    samples: new Int16Array(1600),
    sampleRate: 16000,
    channelCount: 1,
    bitsPerSample: 16,
  });
}

/** Holds the FIRST submission open so the queue can be driven into overflow. */
function manualSubmitGate() {
  let release = (): void => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release: () => release() };
}

function fakeClient(options: { failSubmitAttempts?: number; gate?: { opened: Promise<void> } } = {}) {
  let failuresRemaining = options.failSubmitAttempts ?? 0;
  let gateRemaining = options.gate ? 1 : 0;
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
      if (gateRemaining > 0 && options.gate) {
        gateRemaining -= 1;
        await options.gate.opened;
      }
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

describe('HttpWebRtcTranscriptionSubmissionClient', () => {
  it('sends partial identity on a partial chunk and leaves a final body unchanged', async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      const received: Buffer[] = [];
      request.on('data', (chunk: Buffer) => received.push(chunk));
      request.on('end', () => {
        bodies.push(JSON.parse(Buffer.concat(received).toString('utf8')) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const { port } = server.address() as AddressInfo;
    const client = new HttpWebRtcTranscriptionSubmissionClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 5_000,
    });

    try {
      await client.submitChunk(
        'call_demo',
        { ...chunkFixture(), partial: true, partialSequence: 2, endMs: 900 },
        '/staging/partial.wav',
      );
      await client.submitChunk('call_demo', chunkFixture(), '/staging/final.wav');
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }

    expect(bodies[0]).toMatchObject({
      sequence: 7,
      startMs: 0,
      endMs: 900,
      partial: true,
      partialSequence: 2,
      sourcePath: '/staging/partial.wav',
    });
    // A final chunk's body is exactly what it has always been.
    expect(bodies[1]).not.toHaveProperty('partial');
    expect(bodies[1]).not.toHaveProperty('partialSequence');
    expect(bodies[1]).toMatchObject({ sequence: 7, startMs: 0, endMs: 1_000 });
  });
});

/** A submitted-shaped chunk; the client only reads these fields. */
function chunkFixture(): WebRtcTranscriptionChunk {
  const samples = new Int16Array(16_000);
  return {
    ...context,
    sequence: 7,
    startMs: 0,
    endMs: 1_000,
    durationMs: 1_000,
    sampleRate: 16000,
    channelCount: 1,
    pcmFormat: 'pcm_s16le',
    samples,
    byteLength: samples.byteLength,
    discontinuity: false,
    endOfStream: false,
  };
}

describe('wavBufferFromPcm', () => {
  it('writes playable WAV headers for PCM16 audio', () => {
    const wav = wavBufferFromPcm(new Int16Array(160), 16000, 1);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
  });
});
