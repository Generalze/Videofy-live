import { beforeEach, describe, expect, it } from 'vitest';
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

  it('drops a segment that never contained enough voice, without waiting for the buffer to burst', () => {
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

    // 100 ms of voice arms the VAD but is under the 200 ms minimum. It used to
    // be unable to CLOSE — "not enough speech" blocked closure — so it hoarded
    // silence until the buffer limit threw it away, and a later blip could
    // promote the hoard into an eight-second near-silent chunk.
    //
    // Now it closes on end-silence and is dropped for what it actually is:
    // a segment nobody spoke enough into.
    expect(push(speech100Ms)).toHaveLength(0);
    for (let index = 0; index < 4; index++) {
      expect(push(silence100Ms)).toHaveLength(0);
    }

    expect(chunker.snapshot()).toMatchObject({ vadInsufficientVoicedCount: 1 });
    // Dropped on its own terms, not by running out of buffer.
    expect(chunker.snapshot().vadDroppedSegmentCount).toBe(0);
    expect(chunker.snapshot().bufferedDurationMs).toBeLessThanOrEqual(300);

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
    // Both chunkers share ONE fake clock. With Date.now() the two would drift a
    // millisecond apart whenever the loop straddled a tick, and this deep-equal
    // would fail perhaps one run in a few hundred — the kind of flake that gets
    // "fixed" by loosening the assertion that is doing the actual work here.
    let clock = 1_000_000;
    const nowMs = () => clock;
    const streaming = new WebRtcTranscriptionChunker({
      ...context,
      vad: partialVad,
      partialIntervalMs: 300,
      nowMs,
    });
    const today = new WebRtcTranscriptionChunker({ ...context, vad: partialVad, nowMs });
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
      clock += 100;
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

/**
 * Source-level regression for the defect that made the recogniser invent words.
 *
 * These use REALISTIC waveforms rather than constant-amplitude blocks. The old
 * suite pushed frames far above the gate, so every frame counted as speech and
 * the accounting bug was invisible — the tests stayed green while quiet real
 * speech and near-silent noise were treated identically in production.
 *
 * Production values are used throughout: 0.012 gate, 700 ms end silence,
 * 8000 ms max segment.
 */
describe('VAD segmentation refuses audio nobody spoke into', () => {
  const FRAME = 160; // 10 ms at 16 kHz, the real RTCAudioSink cadence.
  const PRODUCTION_VAD = {
    enabled: true as const,
    mode: 'fallback' as const,
    speechThreshold: 0.012,
    minSpeechMs: 150,
    endSilenceMs: 700,
    maxSegmentMs: 8000,
  };

  function chunkerFor(vad = PRODUCTION_VAD) {
    return new WebRtcTranscriptionChunker({ ...context, vad, maxBufferedDurationMs: 30_000 });
  }

  /**
   * Deterministic noise, seeded identically before every test.
   *
   * Math.random() would make QUIET_VOICE land on either side of the gate by
   * chance — a suite that passes locally and fails in CI once a fortnight,
   * about the one behavior nobody wants to debug from a flake.
   */
  let noise = 0;
  const seedNoise = () => {
    noise = 0x5eed;
  };
  function nextNoise(): number {
    noise = (noise + 0x6d2b79f5) | 0;
    let value = noise;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
  beforeEach(seedNoise);

  /** A 10 ms frame at a given RMS amplitude, with noise rather than a constant. */
  function frame(amplitude: number): Int16Array {
    const samples = new Int16Array(FRAME);
    for (let index = 0; index < FRAME; index += 1) {
      samples[index] = Math.round((nextNoise() * 2 - 1) * amplitude);
    }
    return samples;
  }

  const ROOM_TONE = 120; // ~0.004 RMS: audible room, well under the gate.
  const VOICE = 6000; // ordinary speech.
  // ~0.015 RMS: a soft speaker. Uniform noise at amplitude A has RMS A/√3, and
  // a 160-sample frame's RMS wobbles by ~5.6%, so this sits a few sigma above
  // the 0.012 gate rather than straddling it.
  const QUIET_VOICE = 850;

  function push(chunker: WebRtcTranscriptionChunker, samples: Int16Array) {
    return chunker.pushFrame({ samples, sampleRate: 16000, channelCount: 1, bitsPerSample: 16 });
  }

  function pushMany(chunker: WebRtcTranscriptionChunker, amplitude: number, ms: number) {
    const emitted = [];
    for (let index = 0; index < ms / 10; index += 1) {
      emitted.push(...push(chunker, frame(amplitude)));
    }
    return emitted.filter((chunk) => !chunk.partial);
  }

  it('1. digital silence produces nothing', () => {
    const chunker = chunkerFor();
    expect(pushMany(chunker, 0, 5_000)).toHaveLength(0);
  });

  it('2. a quiet room for ten seconds produces nothing', () => {
    const chunker = chunkerFor();
    expect(pushMany(chunker, ROOM_TONE, 10_000)).toHaveLength(0);
  });

  it('3. a single impulse then silence never reaches the recogniser', () => {
    // A keyboard tap. It may arm a segment; it must never be transcribed.
    const chunker = chunkerFor();
    push(chunker, frame(VOICE));
    expect(pushMany(chunker, ROOM_TONE, 3_000)).toHaveLength(0);
    expect(chunker.snapshot().vadInsufficientVoicedCount).toBeGreaterThan(0);
  });

  it('4. two blips separated by silence do NOT add up to speech', () => {
    // THE regression. Silence between two 10 ms blips used to be promoted into
    // the speech counter, so 500 ms of nothing satisfied minSpeechMs and an
    // eight-second near-silent chunk went to the recogniser.
    const chunker = chunkerFor();
    push(chunker, frame(VOICE));
    pushMany(chunker, ROOM_TONE, 500);
    push(chunker, frame(VOICE));
    const emitted = pushMany(chunker, ROOM_TONE, 1_000);

    expect(emitted).toHaveLength(0);
  });

  it('5. sparse blips for over eight seconds never emit an eight-second chunk', () => {
    // Blips closer together than the 700 ms end-silence, so the segment can
    // never close on silence and runs to the max-duration cap — which is
    // exactly how the observed eight-second fabrications were produced.
    const chunker = chunkerFor();
    const emitted = [];
    for (let round = 0; round < 20; round += 1) {
      emitted.push(...push(chunker, frame(VOICE)));
      emitted.push(...pushMany(chunker, ROOM_TONE, 500));
    }

    expect(emitted.filter((chunk) => !chunk.partial)).toHaveLength(0);
  });

  it('6. a short real answer still gets through', () => {
    // Measured: "Non." is 290 ms of voiced audio, "Oui." 320 ms, "Yes." 380 ms.
    // Every one of them would have been deleted silently by the old 500 ms
    // minimum once the counter stopped absorbing silence.
    const chunker = chunkerFor();
    pushMany(chunker, VOICE, 290);
    const emitted = pushMany(chunker, ROOM_TONE, 800);

    expect(emitted).toHaveLength(1);
  });

  it('7. quiet speech is not mistaken for silence', () => {
    const chunker = chunkerFor();
    pushMany(chunker, QUIET_VOICE, 400);
    const emitted = pushMany(chunker, ROOM_TONE, 800);

    expect(emitted).toHaveLength(1);
  });

  it('8. an ordinary sentence is emitted once', () => {
    const chunker = chunkerFor();
    pushMany(chunker, VOICE, 2_000);
    const emitted = pushMany(chunker, ROOM_TONE, 800);

    expect(emitted).toHaveLength(1);
  });

  it('9. a pause inside a sentence does not become evidence of speech', () => {
    // The pause is kept in the audio so words are not spliced together, but it
    // must not count toward the minimum.
    const chunker = chunkerFor();
    pushMany(chunker, VOICE, 300);
    pushMany(chunker, ROOM_TONE, 300);
    pushMany(chunker, VOICE, 300);
    const emitted = pushMany(chunker, ROOM_TONE, 800);

    expect(emitted).toHaveLength(1);
    // 600 ms of voice, not 900 ms of buffered audio.
    expect(emitted[0]!.samples.length).toBeLessThan(16000 * 1.2);
  });

  it('10. the closing silence is trimmed off the emitted chunk', () => {
    // 700 ms of room tone on the end of every chunk is an invitation to fill it.
    const chunker = chunkerFor();
    pushMany(chunker, VOICE, 1_000);
    const emitted = pushMany(chunker, ROOM_TONE, 800);

    expect(emitted).toHaveLength(1);
    // 1000 ms of speech plus at most a 200 ms post-roll, not 1700 ms.
    expect(emitted[0]!.samples.length).toBeLessThanOrEqual(16000 * 1.25);
  });

  it('11. long real speech still emits at the max-duration cap', () => {
    const chunker = chunkerFor();
    const emitted = pushMany(chunker, VOICE, 9_000);

    expect(emitted.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * Ending a call is not evidence that somebody spoke.
   *
   * The ordinary close path weighs voiced duration AND voiced fraction; flush
   * used to weigh duration alone and emit the segment untrimmed. Since a stream
   * can end at any instant — including inside a noise-armed segment that had
   * not yet reached the max-duration cap — that left the whole defect reachable
   * through the one path nobody thinks to test.
   */
  describe('end of stream obeys the same rule as an ordinary close', () => {
    it('A. sparse blips over several seconds emit nothing when the stream ends', () => {
      // 16 taps of 10 ms = 160 ms voiced, over 4960 ms. That clears the 150 ms
      // absolute minimum — which is all flush used to check — at 3% voiced.
      const chunker = chunkerFor();
      for (let round = 0; round < 16; round += 1) {
        push(chunker, frame(VOICE));
        pushMany(chunker, ROOM_TONE, 300); // under the 700 ms close, so it stays open
      }

      expect(chunker.flush().filter((chunk) => !chunk.partial)).toHaveLength(0);
      expect(chunker.snapshot().vadInsufficientVoicedCount).toBeGreaterThan(0);
    });

    it('B. voiced duration well past the minimum still fails on fraction', () => {
      // 250 ms voiced — nearly a spoken "Non." — but smeared across 4 seconds
      // at 6%. Duration alone cannot tell this from somebody answering.
      const chunker = chunkerFor();
      for (let round = 0; round < 25; round += 1) {
        pushMany(chunker, VOICE, 10);
        pushMany(chunker, ROOM_TONE, 150);
      }

      expect(chunker.flush().filter((chunk) => !chunk.partial)).toHaveLength(0);
    });

    it('C. a short real answer cut off by the hang-up is still delivered', () => {
      // "Non." at 290 ms voiced, then the call ends before the 700 ms silence
      // would have closed the segment. This is the case the fix must not break.
      const chunker = chunkerFor();
      pushMany(chunker, VOICE, 290);
      pushMany(chunker, ROOM_TONE, 300);

      const finals = chunker.flush().filter((chunk) => !chunk.partial);
      expect(finals).toHaveLength(1);
      expect(finals[0]).toMatchObject({ endOfStream: true });
    });

    it('D. a flushed chunk carries at most the 200 ms post-roll', () => {
      const chunker = chunkerFor();
      pushMany(chunker, VOICE, 1_000);
      pushMany(chunker, ROOM_TONE, 690);

      const finals = chunker.flush().filter((chunk) => !chunk.partial);
      expect(finals).toHaveLength(1);
      // 1000 ms of speech plus the post-roll, not 1690 ms of mostly room tone.
      expect(finals[0]!.samples.length).toBeGreaterThan(16_000);
      expect(finals[0]!.samples.length).toBeLessThanOrEqual(Math.round(16_000 * 1.2));
    });

    it('E. a stream that ends during room tone emits nothing at all', () => {
      const chunker = chunkerFor();
      pushMany(chunker, ROOM_TONE, 3_000);

      expect(chunker.flush()).toHaveLength(0);
    });
  });

  /**
   * W2 — the stamped extent must describe the SPEECH, not the bookkeeping.
   *
   * The instrument this replaces stamped one time at segment close and was read
   * downstream as "when the speech ended". Those differ by the end-silence
   * window, and — the part that made it uncorrectable — by a DIFFERENT amount
   * depending on why the segment closed. A constant could have been subtracted
   * out; this could not.
   */
  describe('wall clocks describe the speech, not the close', () => {
    const START = 1_700_000_000_000;

    /** Push `ms` of audio, advancing an injected clock exactly one frame at a time. */
    function speak(
      chunker: WebRtcTranscriptionChunker,
      clock: { at: number },
      amplitude: number,
      ms: number,
    ) {
      const emitted = [];
      for (let index = 0; index < ms / 10; index += 1) {
        clock.at += FRAME_MS;
        emitted.push(
          ...chunker.pushFrame(
            { samples: frame(amplitude), sampleRate: 16000, channelCount: 1, bitsPerSample: 16 },
            clock.at,
          ),
        );
      }
      return emitted.filter((chunk) => !chunk.partial);
    }

    const FRAME_MS = 10;

    function timedChunker(clock: { at: number }) {
      return new WebRtcTranscriptionChunker({
        ...context,
        vad: PRODUCTION_VAD,
        maxBufferedDurationMs: 30_000,
        nowMs: () => clock.at,
      });
    }

    it('stamps the voiced extent to the injected schedule on an end-silence close', () => {
      const clock = { at: START };
      const chunker = timedChunker(clock);

      const speechStart = clock.at;
      speak(chunker, clock, VOICE, 1_000);
      const lastVoiced = clock.at;
      const emitted = speak(chunker, clock, ROOM_TONE, 800);

      expect(emitted).toHaveLength(1);
      const wallClock = emitted[0]!.wallClock!;
      expect(wallClock.closeReason).toBe('end-silence');
      expect(Math.abs(wallClock.firstCapturedSampleAtMs - speechStart)).toBeLessThanOrEqual(10);
      expect(Math.abs(wallClock.lastVoicedSampleAtMs - lastVoiced)).toBeLessThanOrEqual(10);
      expect(Math.abs(wallClock.lastRetainedSampleAtMs - (lastVoiced + 200))).toBeLessThanOrEqual(10);
      // THE BIAS, made visible. The close is a full end-silence window after
      // the speech, and reading the close as the speech end is what put every
      // downstream containment measurement ~500 ms out.
      expect(wallClock.vadClosedAtMs - wallClock.lastVoicedSampleAtMs).toBeGreaterThanOrEqual(690);
    });

    it('stamps it just as accurately on a max-duration close, where the bias is ~0', () => {
      // The reason a single close-stamped timestamp could not be corrected by
      // subtracting a constant: here the close IS the speech end.
      const clock = { at: START };
      const chunker = timedChunker(clock);

      const speechStart = clock.at;
      const emitted = speak(chunker, clock, VOICE, 8_100);

      expect(emitted.length).toBeGreaterThanOrEqual(1);
      const wallClock = emitted[0]!.wallClock!;
      expect(wallClock.closeReason).toBe('max-duration');
      expect(Math.abs(wallClock.firstCapturedSampleAtMs - speechStart)).toBeLessThanOrEqual(10);
      expect(wallClock.vadClosedAtMs - wallClock.lastVoicedSampleAtMs).toBeLessThanOrEqual(10);
      // No trailing silence exists to keep, so none is claimed.
      expect(wallClock.lastRetainedSampleAtMs).toBe(wallClock.lastVoicedSampleAtMs);
    });

    it('stamps a flushed segment and says it was a flush', () => {
      const clock = { at: START };
      const chunker = timedChunker(clock);

      speak(chunker, clock, VOICE, 400);
      const lastVoiced = clock.at;
      speak(chunker, clock, ROOM_TONE, 300);
      const finals = chunker.flush().filter((chunk) => !chunk.partial);

      expect(finals).toHaveLength(1);
      const wallClock = finals[0]!.wallClock!;
      expect(wallClock.closeReason).toBe('flush');
      expect(Math.abs(wallClock.lastVoicedSampleAtMs - lastVoiced)).toBeLessThanOrEqual(10);
    });

    it('starts each segment from its own first voiced frame, not the previous one', () => {
      const clock = { at: START };
      const chunker = timedChunker(clock);

      speak(chunker, clock, VOICE, 400);
      speak(chunker, clock, ROOM_TONE, 800);
      const secondStart = clock.at;
      speak(chunker, clock, VOICE, 400);
      const emitted = speak(chunker, clock, ROOM_TONE, 800);

      expect(emitted).toHaveLength(1);
      expect(
        Math.abs(emitted[0]!.wallClock!.firstCapturedSampleAtMs - secondStart),
      ).toBeLessThanOrEqual(10);
    });

    it('reports no wall clock at all for fixed-interval chunking', () => {
      // Programme chunking has no voiced extent. Reporting one would be exactly
      // the class of invented millisecond this work exists to remove.
      const chunker = new WebRtcTranscriptionChunker({ ...context, chunkDurationMs: 100 });
      const [chunk] = chunker.pushFrame({
        samples: new Int16Array(1600),
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 16,
      });

      expect(chunk!.wallClock).toBeUndefined();
    });
  });
});
