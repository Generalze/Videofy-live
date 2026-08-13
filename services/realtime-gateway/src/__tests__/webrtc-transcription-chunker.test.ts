import { describe, expect, it } from 'vitest';
import {
  WebRtcTranscriptionChunker,
  WebRtcTranscriptionChunkerError,
  normalizePcmFrame,
  normalizePcmFrameWithDiagnostics,
} from '../webrtc-transcription-chunker.js';

const context = {
  sessionId: 'wrs_demo',
  broadcastId: 'broadcast_demo',
  broadcasterPeerId: 'peer_broadcaster',
  revision: 2,
};

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
