import { describe, expect, it } from 'vitest';
import {
  WebRtcTranscriptionChunker,
  WebRtcTranscriptionChunkerError,
  normalizePcmFrame,
  normalizePcmFrameWithDiagnostics,
  type WebRtcTranscriptionChunk,
} from '../webrtc-transcription-chunker.js';

const context = {
  sessionId: 'wrs_demo',
  broadcastId: 'broadcast_demo',
  broadcasterPeerId: 'peer_broadcaster',
  revision: 2,
};

/**
 * VAD tuned for 100 ms test frames: one speech frame arms a segment and one
 * silence frame closes it, so a sentence is exactly as long as it is written.
 */
const partialVad = {
  enabled: true,
  mode: 'fallback',
  speechThreshold: 0.01,
  minSpeechMs: 100,
  endSilenceMs: 100,
  maxSegmentMs: 60_000,
} as const;

const speech100Ms = (): Int16Array => new Int16Array(1600).fill(10_000);
const silence100Ms = (): Int16Array => new Int16Array(1600);

function push(chunker: WebRtcTranscriptionChunker, samples: Int16Array): WebRtcTranscriptionChunk[] {
  return chunker.pushFrame({ samples, sampleRate: 16000, channelCount: 1, bitsPerSample: 16 });
}

/** Stands in for the bridge: owns the queue the chunker only accounts for. */
function fakeQueueOwner() {
  const owner = {
    queue: [] as WebRtcTranscriptionChunk[],
    evictionCount: 0,
    take(chunks: WebRtcTranscriptionChunk[]): WebRtcTranscriptionChunk[] {
      owner.queue.push(...chunks);
      return chunks;
    },
    evictOldest(): WebRtcTranscriptionChunk | null {
      const oldest = owner.queue.shift();
      if (!oldest) return null;
      owner.evictionCount += 1;
      return oldest;
    },
  };
  return owner;
}

describe('WebRtcTranscriptionChunker', () => {
  it('normalizes stereo 48 kHz PCM to mono 16 kHz PCM', () => {
    const source = new Int16Array([1000, 3000, 2000, 4000, 3000, 5000]);
    const normalized = normalizePcmFrame({
      samples: source,
      sampleRate: 48000,
      channelCount: 2,
      bitsPerSample: 16,
      numberOfFrames: 3,
    });

    expect(normalized.length).toBe(1);
    expect(normalized[0]).toBe(2000);
  });

  it('normalizes browser Float32 frames with their native 32-bit metadata', () => {
    const floatFrame = normalizePcmFrame({
      samples: new Float32Array([0.5, -0.5]),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 32,
    });

    expect(floatFrame).toEqual(new Int16Array([16384, -16384]));
  });

  it('rejects frames whose declared bit depth does not match their PCM samples', () => {
    expect(() =>
      normalizePcmFrame({
        samples: new Int16Array([1234, -1234]),
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 24,
      }),
    ).toThrow(/bit depth 24 is unsupported/);
    expect(() =>
      normalizePcmFrame({
        samples: new Int16Array([1234, -1234]),
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 32,
      }),
    ).toThrow(/bit depth 32 is unsupported/);

    try {
      normalizePcmFrame({
        samples: new Int16Array([1234, -1234]),
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 24,
      });
      expect.unreachable('expected unsupported-format rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(WebRtcTranscriptionChunkerError);
      expect((error as WebRtcTranscriptionChunkerError).code).toBe('unsupported-format');
    }

    expect(
      normalizePcmFrame({
        samples: new Int16Array([1234, -1234]),
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 16,
      }),
    ).toEqual(new Int16Array([1234, -1234]));
  });

  it('reports PCM diagnostics without logging raw audio', () => {
    const normalized = normalizePcmFrameWithDiagnostics({
      samples: new Float32Array([0, 0.25, -0.25, 1]),
      sampleRate: 32000,
      channelCount: 2,
      bitsPerSample: 32,
      numberOfFrames: 2,
    });

    expect(normalized.samples).toBeInstanceOf(Int16Array);
    expect(normalized.diagnostics).toMatchObject({
      inputSampleRate: 32000,
      inputChannelCount: 2,
      inputBitsPerSample: 32,
      inputSampleType: 'float32',
      normalizedSampleRate: 16000,
      normalizedChannelCount: 1,
      normalizedBitsPerSample: 16,
      silent: false,
      metadataWarnings: [],
    });
    expect(normalized.diagnostics.rms).toBeGreaterThan(0);
    expect(normalized.diagnostics.peak).toBeGreaterThan(0);
  });

  it('creates ordered chunks with preserved sample-count timestamps and final partial flush', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      chunkDurationMs: 100,
    });
    const first = chunker.pushFrame({
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
      numberOfFrames: 1600,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      sequence: 0,
      startMs: 0,
      endMs: 100,
      durationMs: 100,
      endOfStream: false,
    });

    const second = chunker.pushFrame({
      samples: new Int16Array(800),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
      numberOfFrames: 800,
    });
    expect(second).toHaveLength(0);

    const final = chunker.flush();
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      sequence: 1,
      startMs: 100,
      endMs: 150,
      durationMs: 50,
      endOfStream: true,
    });
  });

  it('uses VAD-driven boundaries while preserving programme timestamps and skipped silence', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      vad: {
        enabled: true,
        mode: 'fallback',
        speechThreshold: 0.01,
        minSpeechMs: 100,
        endSilenceMs: 100,
        maxSegmentMs: 1000,
      },
    });
    const silence100Ms = new Int16Array(1600);
    const speech200Ms = new Int16Array(3200).fill(10_000);

    expect(
      chunker.pushFrame({
        samples: silence100Ms,
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 16,
      }),
    ).toHaveLength(0);
    expect(
      chunker.pushFrame({
        samples: speech200Ms,
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 16,
      }),
    ).toHaveLength(0);
    const chunks = chunker.pushFrame({
      samples: silence100Ms,
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      sequence: 0,
      startMs: 100,
      endMs: 400,
      durationMs: 300,
    });
    expect(chunker.snapshot()).toMatchObject({
      vadMode: 'fallback',
      skippedSilenceMs: 100,
    });
  });

  it('reports an honest energy-gate fallback when silero VAD is configured', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      vad: {
        enabled: true,
        mode: 'silero',
        speechThreshold: 0.01,
        minSpeechMs: 100,
        endSilenceMs: 100,
        maxSegmentMs: 1000,
      },
    });

    expect(chunker.snapshot()).toMatchObject({
      vadMode: 'fallback',
      vadRequestedMode: 'silero',
      vadModeFellBack: true,
    });

    expect(
      chunker.pushFrame({
        samples: new Int16Array(3200).fill(10_000),
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 16,
      }),
    ).toHaveLength(0);
    const chunks = chunker.pushFrame({
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });
    expect(chunks).toHaveLength(1);
  });

  it('drops an over-long armed VAD segment instead of growing without bound', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      maxBufferedDurationMs: 300,
      vad: {
        enabled: true,
        mode: 'fallback',
        speechThreshold: 0.01,
        minSpeechMs: 200,
        endSilenceMs: 100,
        maxSegmentMs: 1000,
      },
    });
    const silence100Ms = new Int16Array(1600);
    const speech100Ms = new Int16Array(1600).fill(10_000);
    const push = (samples: Int16Array) =>
      chunker.pushFrame({ samples, sampleRate: 16000, channelCount: 1, bitsPerSample: 16 });

    // Below-minimum speech arms the VAD; trailing silence can never end it,
    // so the buffered segment would previously grow forever.
    expect(push(speech100Ms)).toHaveLength(0);
    for (let index = 0; index < 4; index++) {
      expect(push(silence100Ms)).toHaveLength(0);
    }

    expect(chunker.snapshot()).toMatchObject({ vadDroppedSegmentCount: 1 });
    expect(chunker.snapshot().bufferedDurationMs).toBeLessThanOrEqual(300);
    expect(chunker.snapshot().vadDroppedMs).toBeGreaterThan(0);

    // The chunker keeps working afterwards and flags the discontinuity.
    expect(push(speech100Ms)).toHaveLength(0);
    expect(push(speech100Ms)).toHaveLength(0);
    const chunks = push(silence100Ms);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ discontinuity: true });
  });

  it('clears VAD buffers when chunk creation throws so the next segment starts clean', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      maxQueuedChunks: 1,
      vad: {
        enabled: true,
        mode: 'fallback',
        speechThreshold: 0.01,
        minSpeechMs: 100,
        endSilenceMs: 100,
        maxSegmentMs: 1000,
      },
    });
    const silence100Ms = new Int16Array(1600);
    const speech200Ms = new Int16Array(3200).fill(10_000);
    const push = (samples: Int16Array) =>
      chunker.pushFrame({ samples, sampleRate: 16000, channelCount: 1, bitsPerSample: 16 });

    push(speech200Ms);
    const [firstChunk] = push(silence100Ms);
    expect(firstChunk).toBeDefined();

    push(speech200Ms);
    expect(() => push(silence100Ms)).toThrow(WebRtcTranscriptionChunkerError);
    expect(chunker.snapshot().bufferedDurationMs).toBe(0);

    chunker.ackChunk(firstChunk!);
    push(speech200Ms);
    const chunks = push(silence100Ms);
    expect(chunks).toHaveLength(1);
  });

  it('falls back to fixed chunking when VAD is disabled', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      chunkDurationMs: 100,
      vad: { enabled: false, mode: 'fallback' },
    });

    const chunks = chunker.pushFrame({
      samples: new Int16Array(1600),
      sampleRate: 16000,
      channelCount: 1,
      bitsPerSample: 16,
    });

    expect(chunks).toHaveLength(1);
    expect(chunker.snapshot()).toMatchObject({ vadMode: 'disabled' });
  });

  it('marks discontinuity after a bounded buffer failure', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      chunkDurationMs: 1000,
      maxBufferedDurationMs: 10,
    });

    expect(() =>
      chunker.pushFrame({
        samples: new Int16Array(320),
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 16,
      }),
    ).toThrow(WebRtcTranscriptionChunkerError);
  });

  it('defaults to reject-new: the NEW chunk is refused and the stale backlog is kept', () => {
    const owner = fakeQueueOwner();
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      chunkDurationMs: 100,
      maxQueuedChunks: 2,
      // No policy given: programme behavior must be byte-identical.
      onQueueOverflow: owner.evictOldest,
    });
    const push = () =>
      owner.take(
        chunker.pushFrame({
          samples: new Int16Array(1600),
          sampleRate: 16000,
          channelCount: 1,
          bitsPerSample: 16,
        }),
      );

    push();
    push();
    expect(owner.queue.map((chunk) => chunk.sequence)).toEqual([0, 1]);

    expect(() => push()).toThrow(WebRtcTranscriptionChunkerError);
    // The owner's queue is untouched and the callback was never consulted.
    expect(owner.evictionCount).toBe(0);
    expect(owner.queue.map((chunk) => chunk.sequence)).toEqual([0, 1]);
    expect(chunker.snapshot()).toMatchObject({
      queueOverflowPolicy: 'reject-new',
      queuedChunks: 2,
      evictedChunkCount: 0,
      lastEvictedSequence: null,
    });
  });

  it('evicts the OLDEST queued chunk to admit the newest speech with exact accounting', () => {
    const owner = fakeQueueOwner();
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      chunkDurationMs: 100,
      maxQueuedChunks: 2,
      queueOverflowPolicy: 'evict-oldest',
      onQueueOverflow: owner.evictOldest,
    });
    const push = () =>
      owner.take(
        chunker.pushFrame({
          samples: new Int16Array(1600),
          sampleRate: 16000,
          channelCount: 1,
          bitsPerSample: 16,
        }),
      );

    push();
    push();
    const bytesPerChunk = owner.queue[0]?.byteLength ?? 0;
    expect(chunker.snapshot()).toMatchObject({
      queuedChunks: 2,
      queuedBytes: bytesPerChunk * 2,
    });

    // The third chunk does not fit: the OLDEST is dropped, never the newest.
    expect(() => push()).not.toThrow();
    expect(owner.queue.map((chunk) => chunk.sequence)).toEqual([1, 2]);
    expect(owner.evictionCount).toBe(1);
    // Accounting is exact: still two chunks and two chunks' worth of bytes.
    expect(chunker.snapshot()).toMatchObject({
      queueOverflowPolicy: 'evict-oldest',
      queuedChunks: 2,
      queuedBytes: bytesPerChunk * 2,
      evictedChunkCount: 1,
      lastEvictedSequence: 0,
      evictedMs: 100,
    });
    // The replacement carries the timeline hole the eviction created.
    expect(owner.queue[1]).toMatchObject({ sequence: 2, discontinuity: true });

    // Draining normally leaves accounting back at zero — no drift.
    for (const chunk of owner.queue.splice(0)) chunker.ackChunk(chunk);
    expect(chunker.snapshot()).toMatchObject({ queuedChunks: 0, queuedBytes: 0 });
  });

  it('rejects the new chunk when eviction has nothing left to give up', () => {
    const owner = fakeQueueOwner();
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      chunkDurationMs: 100,
      maxQueuedChunks: 1,
      queueOverflowPolicy: 'evict-oldest',
      onQueueOverflow: owner.evictOldest,
    });
    const push = () =>
      owner.take(
        chunker.pushFrame({
          samples: new Int16Array(1600),
          sampleRate: 16000,
          channelCount: 1,
          bitsPerSample: 16,
        }),
      );

    push();
    // Simulate the only outstanding chunk being IN FLIGHT: it has left the
    // owner's queue but still holds its accounting, so nothing is evictable.
    const inFlight = owner.queue.shift();
    expect(inFlight).toBeDefined();

    expect(() => push()).toThrow(WebRtcTranscriptionChunkerError);
    expect(owner.evictionCount).toBe(0);
    expect(chunker.snapshot()).toMatchObject({ queuedChunks: 1, evictedChunkCount: 0 });

    // Once the in-flight chunk is acked the chunker recovers.
    chunker.ackChunk(inFlight!);
    expect(() => push()).not.toThrow();
    expect(chunker.snapshot()).toMatchObject({ queuedChunks: 1 });
  });

  it('releases accounting for a multi-chunk batch aborted mid-drain', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      chunkDurationMs: 100,
      maxQueuedChunks: 2,
    });

    // One 300 ms frame drains into three 100 ms chunks; the third exceeds the
    // queue limit, so the caller receives nothing and keeps nothing queued.
    expect(() =>
      chunker.pushFrame({
        samples: new Int16Array(4800),
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 16,
      }),
    ).toThrow(WebRtcTranscriptionChunkerError);
    expect(chunker.snapshot()).toMatchObject({ queuedChunks: 0, queuedBytes: 0 });
  });

  it('streams interim partials during a sentence and still ends it with the whole utterance', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      vad: partialVad,
      partialIntervalMs: 300,
    });

    const partials: WebRtcTranscriptionChunk[] = [];
    for (let index = 0; index < 6; index++) partials.push(...push(chunker, speech100Ms()));

    // Two 300 ms partials arrive DURING the sentence, both carrying the
    // sequence the final chunk will use and their own position inside it.
    expect(
      partials.map((chunk) => ({
        sequence: chunk.sequence,
        partial: chunk.partial,
        partialSequence: chunk.partialSequence,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        endOfStream: chunk.endOfStream,
      })),
    ).toEqual([
      { sequence: 0, partial: true, partialSequence: 0, startMs: 0, endMs: 300, endOfStream: false },
      { sequence: 0, partial: true, partialSequence: 1, startMs: 0, endMs: 600, endOfStream: false },
    ]);
    // Each partial is a strict prefix of the segment, from the segment start.
    expect(partials[0]!.samples).toEqual(new Int16Array(4800).fill(10_000));
    expect(partials[1]!.samples.subarray(0, 4800)).toEqual(partials[0]!.samples);

    const finals = push(chunker, silence100Ms());
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ sequence: 0, startMs: 0, endMs: 700, durationMs: 700 });
    expect(finals[0]!.partial).toBeUndefined();
    expect(finals[0]!.partialSequence).toBeUndefined();
    // The final still holds the WHOLE utterance: 600 ms speech + 100 ms silence.
    expect(finals[0]!.samples.length).toBe(11_200);
    expect(finals[0]!.samples.subarray(0, 9600)).toEqual(new Int16Array(9600).fill(10_000));
    expect(chunker.snapshot()).toMatchObject({
      partialIntervalMs: 300,
      partialChunkCount: 2,
      droppedPartialChunkCount: 0,
      lastDroppedPartialReason: null,
    });
  });

  it('emits a final chunk identical to the one it would emit with partials disabled', () => {
    const streaming = new WebRtcTranscriptionChunker({
      ...context,
      vad: partialVad,
      partialIntervalMs: 300,
    });
    const today = new WebRtcTranscriptionChunker({ ...context, vad: partialVad });
    // Two sentences and a mid-sentence cut-off, so the flush path is compared
    // as well as the VAD boundary path.
    const frames = [
      ...Array.from({ length: 6 }, speech100Ms),
      silence100Ms(),
      ...Array.from({ length: 4 }, speech100Ms),
      silence100Ms(),
      ...Array.from({ length: 5 }, speech100Ms),
    ];

    const streamingFinals: WebRtcTranscriptionChunk[] = [];
    const todayFinals: WebRtcTranscriptionChunk[] = [];
    for (const frame of frames) {
      streamingFinals.push(...push(streaming, frame.slice()).filter((chunk) => !chunk.partial));
      todayFinals.push(...push(today, frame.slice()));
    }
    streamingFinals.push(...streaming.flush());
    todayFinals.push(...today.flush());

    expect(todayFinals.map((chunk) => chunk.sequence)).toEqual([0, 1, 2]);
    expect(streamingFinals).toEqual(todayFinals);
    expect(streaming.snapshot().partialChunkCount).toBeGreaterThan(0);
    expect(today.snapshot()).toMatchObject({ partialIntervalMs: 0, partialChunkCount: 0 });
  });

  it('emits no partials by default, so programme chunking is unchanged', () => {
    const chunker = new WebRtcTranscriptionChunker({ ...context, vad: partialVad });

    for (let index = 0; index < 20; index++) {
      expect(push(chunker, speech100Ms())).toHaveLength(0);
    }

    expect(chunker.snapshot()).toMatchObject({ partialIntervalMs: 0, partialChunkCount: 0 });
  });

  it('ignores a partial interval without VAD, where there is no segment to be partway through', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      chunkDurationMs: 100,
      partialIntervalMs: 300,
    });

    const chunks = push(chunker, speech100Ms());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.partial).toBeUndefined();
    expect(chunker.snapshot()).toMatchObject({ partialIntervalMs: 0, partialChunkCount: 0 });
  });

  it('restarts partial numbering per segment without consuming a final sequence', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      vad: partialVad,
      partialIntervalMs: 300,
    });
    const emitted: WebRtcTranscriptionChunk[] = [];
    const speak = (frames: number) => {
      for (let index = 0; index < frames; index++) emitted.push(...push(chunker, speech100Ms()));
      emitted.push(...push(chunker, silence100Ms()));
    };

    speak(6);
    speak(3);

    expect(
      emitted.map((chunk) => `${chunk.sequence}:${chunk.partial ? chunk.partialSequence : 'final'}`),
    ).toEqual(['0:0', '0:1', '0:final', '1:0', '1:final']);
  });

  it('keeps partials out of the queue accounting so they can never crowd out a final', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      maxQueuedChunks: 1,
      vad: partialVad,
      partialIntervalMs: 300,
    });
    const partials: WebRtcTranscriptionChunk[] = [];

    for (let index = 0; index < 6; index++) partials.push(...push(chunker, speech100Ms()));
    expect(partials).toHaveLength(2);
    // Two partials outstanding, and the single queue slot is still free.
    expect(chunker.snapshot()).toMatchObject({ queuedChunks: 0, queuedBytes: 0 });

    const [final] = push(chunker, silence100Ms());
    expect(final).toBeDefined();
    const finalBytes = final!.byteLength;
    expect(chunker.snapshot()).toMatchObject({ queuedChunks: 1, queuedBytes: finalBytes });

    // Acking a partial must not hand back the final's slot.
    chunker.ackChunk(partials[0]!);
    chunker.releaseChunk(partials[1]!);
    expect(chunker.snapshot()).toMatchObject({ queuedChunks: 1, queuedBytes: finalBytes });

    // The queue is full, yet the next sentence still previews: partials never
    // throw queue-limit-exceeded, only the final chunk does.
    const nextPartials: WebRtcTranscriptionChunk[] = [];
    for (let index = 0; index < 6; index++) nextPartials.push(...push(chunker, speech100Ms()));
    expect(nextPartials.map((chunk) => chunk.sequence)).toEqual([1, 1]);
    expect(() => push(chunker, silence100Ms())).toThrow(WebRtcTranscriptionChunkerError);
    expect(chunker.snapshot()).toMatchObject({ queuedChunks: 1, queuedBytes: finalBytes });

    chunker.ackChunk(final!);
    expect(chunker.snapshot()).toMatchObject({ queuedChunks: 0, queuedBytes: 0 });
  });

  it('reports a pending discontinuity on a partial without consuming it', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      vad: partialVad,
      partialIntervalMs: 300,
    });
    chunker.markDiscontinuity();

    const partials: WebRtcTranscriptionChunk[] = [];
    for (let index = 0; index < 6; index++) partials.push(...push(chunker, speech100Ms()));
    expect(partials.map((chunk) => chunk.discontinuity)).toEqual([true, true]);

    // The flag survives the partials and still reaches the final chunk, which
    // is the one media-ingest reads it from.
    const [final] = push(chunker, silence100Ms());
    expect(final).toMatchObject({ discontinuity: true });

    const nextPartials: WebRtcTranscriptionChunk[] = [];
    for (let index = 0; index < 3; index++) nextPartials.push(...push(chunker, speech100Ms()));
    expect(nextPartials.map((chunk) => chunk.discontinuity)).toEqual([false]);
  });

  it('counts partials the owner threw away, and never counts a final as one', () => {
    const chunker = new WebRtcTranscriptionChunker({
      ...context,
      vad: partialVad,
      partialIntervalMs: 300,
    });
    const partials: WebRtcTranscriptionChunk[] = [];
    for (let index = 0; index < 6; index++) partials.push(...push(chunker, speech100Ms()));
    const [final] = push(chunker, silence100Ms());

    chunker.dropPartialChunk(partials[0]!, 'queue-busy');
    chunker.dropPartialChunk(partials[1]!, 'superseded');
    chunker.dropPartialChunk(final!, 'superseded');

    expect(chunker.snapshot()).toMatchObject({
      partialChunkCount: 2,
      droppedPartialChunkCount: 2,
      lastDroppedPartialReason: 'superseded',
      queuedChunks: 1,
    });
  });

  it('rejects malformed or unsupported PCM frames', () => {
    expect(() =>
      normalizePcmFrame({
        samples: new Int16Array([1, 2, 3]),
        sampleRate: 16000,
        channelCount: 2,
        bitsPerSample: 16,
      }),
    ).toThrow('sample layout');

    expect(() =>
      normalizePcmFrame({
        samples: new Float32Array([1, 2]),
        sampleRate: 0,
        channelCount: 1,
        bitsPerSample: 32,
      }),
    ).toThrow('sample rate');
  });
});
