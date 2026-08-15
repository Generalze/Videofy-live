import type { WebRtcAudioDataLike } from './webrtc-audio-ingest-bridge.js';
import { logger } from './logger.js';

export const WEBRTC_TRANSCRIPTION_SAMPLE_RATE = 16000;
export const WEBRTC_TRANSCRIPTION_CHANNEL_COUNT = 1;
export const WEBRTC_TRANSCRIPTION_PCM_FORMAT = 'pcm_s16le';

export interface WebRtcTranscriptionChunkerContext {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
}

export interface WebRtcTranscriptionChunk {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
  sequence: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  sampleRate: 16000;
  channelCount: 1;
  pcmFormat: 'pcm_s16le';
  samples: Int16Array;
  byteLength: number;
  discontinuity: boolean;
  endOfStream: boolean;
}

export interface WebRtcAudioPcmDiagnostics {
  inputSampleRate: number;
  inputChannelCount: number;
  inputBitsPerSample: number | null;
  inputSampleType: 'int16' | 'float32';
  inputSampleCount: number;
  inputDurationMs: number;
  normalizedSampleRate: 16000;
  normalizedChannelCount: 1;
  normalizedBitsPerSample: 16;
  normalizedSampleCount: number;
  normalizedDurationMs: number;
  rms: number;
  peak: number;
  clippedSampleCount: number;
  silent: boolean;
  metadataWarnings: string[];
}

export interface NormalizedWebRtcPcmFrame {
  samples: Int16Array;
  diagnostics: WebRtcAudioPcmDiagnostics;
}

/**
 * What happens when a new chunk does not fit inside the queue limits.
 *
 * - `reject-new` (default): the NEW chunk is refused with
 *   `queue-limit-exceeded` and the existing backlog is kept. Correct for
 *   programme media, where the recorded timeline must stay complete.
 * - `evict-oldest`: the OLDEST chunk still waiting in the owner's queue is
 *   dropped to make room for the new one. Correct for a live call, where the
 *   newest speech is what the other person is waiting to hear; a stale backlog
 *   is worth less than the sentence just spoken.
 */
export type WebRtcTranscriptionQueueOverflowPolicy = 'reject-new' | 'evict-oldest';

export interface WebRtcTranscriptionChunkerOptions extends WebRtcTranscriptionChunkerContext {
  chunkDurationMs?: number;
  maxBufferedDurationMs?: number;
  maxQueuedChunks?: number;
  maxQueuedBytes?: number;
  vad?: WebRtcVadOptions;
  /** Defaults to `reject-new`, i.e. byte-identical to the pre-P6.1C behavior. */
  queueOverflowPolicy?: WebRtcTranscriptionQueueOverflowPolicy;
  /**
   * Required for `evict-oldest`. The chunker owns the queue ACCOUNTING
   * (queuedChunks/queuedBytes) but not the queue itself, so eviction is
   * cooperative: the chunker asks the owner to hand back the oldest chunk it
   * still holds, then releases that chunk's accounting itself. Return null
   * when the owner has nothing left to give up (everything outstanding is
   * already in flight), in which case the new chunk is rejected as before.
   */
  onQueueOverflow?: () => WebRtcTranscriptionChunk | null;
}

export interface WebRtcVadOptions {
  enabled: boolean;
  mode: 'silero' | 'fallback';
  speechThreshold?: number;
  endSilenceMs?: number;
  minSpeechMs?: number;
  maxSegmentMs?: number;
}

export class WebRtcTranscriptionChunkerError extends Error {
  constructor(
    readonly code:
      | 'closed'
      | 'malformed-frame'
      | 'unsupported-format'
      | 'buffer-limit-exceeded'
      | 'queue-limit-exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'WebRtcTranscriptionChunkerError';
  }
}

export class WebRtcTranscriptionChunker {
  private readonly context: WebRtcTranscriptionChunkerContext;
  private readonly chunkSamples: number;
  private readonly maxBufferedSamples: number;
  private readonly maxQueuedChunks: number;
  private readonly maxQueuedBytes: number;
  private readonly queueOverflowPolicy: WebRtcTranscriptionQueueOverflowPolicy;
  private readonly onQueueOverflow: (() => WebRtcTranscriptionChunk | null) | null;
  private evictedChunkCount = 0;
  private evictedSampleCount = 0;
  private lastEvictedSequence: number | null = null;
  private buffer = new Int16Array(0);
  private emittedChunkCount = 0;
  private emittedSampleCount = 0;
  private queuedChunks = 0;
  private queuedBytes = 0;
  private nextDiscontinuity = false;
  private closed = false;
  private readonly vad: Required<WebRtcVadOptions> | null;
  private readonly vadRequestedMode: WebRtcVadOptions['mode'] | null;
  private vadSpeechFrames: Int16Array[] = [];
  private vadSpeechSampleCount = 0;
  private vadSpeechStartSample: number | null = null;
  private vadSilenceFrames: Int16Array[] = [];
  private vadSilenceSampleCount = 0;
  private vadDroppedSegmentCount = 0;
  private vadDroppedSampleCount = 0;
  private inputSampleCount = 0;
  private skippedSilenceSamples = 0;

  constructor(options: WebRtcTranscriptionChunkerOptions) {
    this.context = {
      sessionId: options.sessionId,
      broadcastId: options.broadcastId,
      broadcasterPeerId: options.broadcasterPeerId,
      revision: options.revision,
    };
    this.chunkSamples = Math.max(
      1,
      Math.round(((options.chunkDurationMs ?? 5_000) / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE),
    );
    this.maxBufferedSamples = Math.round(
      ((options.maxBufferedDurationMs ?? 30_000) / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE,
    );
    this.maxQueuedChunks = options.maxQueuedChunks ?? 8;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 8 * 1024 * 1024;
    // Eviction needs a cooperating owner; without one the policy would silently
    // do nothing, so fall back to the honest, documented reject-new behavior.
    this.queueOverflowPolicy =
      options.queueOverflowPolicy === 'evict-oldest' && options.onQueueOverflow
        ? 'evict-oldest'
        : 'reject-new';
    this.onQueueOverflow =
      this.queueOverflowPolicy === 'evict-oldest' ? (options.onQueueOverflow ?? null) : null;
    this.vadRequestedMode = options.vad?.enabled ? options.vad.mode : null;
    if (this.vadRequestedMode === 'silero') warnSileroUnavailableOnce();
    this.vad = options.vad?.enabled
      ? {
          enabled: true,
          // Silero is not implemented yet; be honest and use the energy gate.
          mode: 'fallback',
          speechThreshold: options.vad.speechThreshold ?? 0.012,
          endSilenceMs: options.vad.endSilenceMs ?? 650,
          minSpeechMs: options.vad.minSpeechMs ?? 180,
          maxSegmentMs: options.vad.maxSegmentMs ?? 8_000,
        }
      : null;
  }

  pushFrame(data: WebRtcAudioDataLike): WebRtcTranscriptionChunk[] {
    if (this.closed) {
      throw new WebRtcTranscriptionChunkerError('closed', 'WebRTC transcription chunker is closed.');
    }
    const { samples: normalized } = normalizePcmFrameWithDiagnostics(data);
    if (this.vad) return this.pushVadFrame(normalized);
    this.appendSamples(normalized);
    return this.drain(false);
  }

  flush(endOfStream = true): WebRtcTranscriptionChunk[] {
    if (this.vad) return this.flushVad(endOfStream);
    if (this.closed && this.buffer.length === 0) return [];
    const chunks = this.buffer.length > 0 ? [this.createChunk(this.buffer, endOfStream)] : [];
    this.buffer = new Int16Array(0);
    this.closed = true;
    return chunks;
  }

  markDiscontinuity(): void {
    this.nextDiscontinuity = true;
  }

  ackChunk(chunk: WebRtcTranscriptionChunk): void {
    this.queuedChunks = Math.max(0, this.queuedChunks - 1);
    this.queuedBytes = Math.max(0, this.queuedBytes - chunk.byteLength);
  }

  /** Release queue accounting for a chunk whose submission failed and will not be retried. */
  releaseChunk(chunk: WebRtcTranscriptionChunk): void {
    this.ackChunk(chunk);
  }

  snapshot() {
    const vadBufferedSamples = this.vadSpeechSampleCount + this.vadSilenceSampleCount;
    return {
      sessionId: this.context.sessionId,
      broadcastId: this.context.broadcastId,
      revision: this.context.revision,
      bufferedDurationMs: Math.round(
        ((this.buffer.length + vadBufferedSamples) / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000,
      ),
      queuedChunks: this.queuedChunks,
      queuedBytes: this.queuedBytes,
      emittedChunkCount: this.emittedChunkCount,
      queueOverflowPolicy: this.queueOverflowPolicy,
      evictedChunkCount: this.evictedChunkCount,
      evictedMs: Math.round((this.evictedSampleCount / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
      lastEvictedSequence: this.lastEvictedSequence,
      vadMode: this.vad?.mode ?? 'disabled',
      vadRequestedMode: this.vadRequestedMode ?? 'disabled',
      vadModeFellBack: this.vadRequestedMode === 'silero',
      vadDroppedSegmentCount: this.vadDroppedSegmentCount,
      vadDroppedMs: Math.round((this.vadDroppedSampleCount / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
      skippedSilenceMs: Math.round((this.skippedSilenceSamples / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
      closed: this.closed,
    };
  }

  private pushVadFrame(samples: Int16Array): WebRtcTranscriptionChunk[] {
    const startSample = this.inputSampleCount;
    this.inputSampleCount += samples.length;
    const vad = this.vad;
    if (!vad) return [];
    if (
      this.vadSpeechSampleCount + this.vadSilenceSampleCount + samples.length >
      this.maxBufferedSamples
    ) {
      this.dropVadSegment();
    }
    const isSpeech = frameEnergy(samples) >= vad.speechThreshold;
    if (isSpeech) {
      if (this.vadSpeechStartSample === null) {
        this.vadSpeechStartSample = startSample;
      }
      if (this.vadSilenceSampleCount > 0) {
        this.vadSpeechFrames.push(...this.vadSilenceFrames);
        this.vadSpeechSampleCount += this.vadSilenceSampleCount;
        this.vadSilenceFrames = [];
        this.vadSilenceSampleCount = 0;
      }
      this.vadSpeechFrames.push(samples);
      this.vadSpeechSampleCount += samples.length;
    } else if (this.vadSpeechStartSample === null) {
      this.skippedSilenceSamples += samples.length;
      return [];
    } else {
      this.vadSilenceFrames.push(samples);
      this.vadSilenceSampleCount += samples.length;
    }

    const segmentLength = this.vadSpeechSampleCount + this.vadSilenceSampleCount;
    const endSilenceSamples = Math.round((vad.endSilenceMs / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE);
    const maxSegmentSamples = Math.round((vad.maxSegmentMs / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE);
    const minSpeechSamples = Math.round((vad.minSpeechMs / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE);
    if (
      this.vadSpeechStartSample !== null &&
      this.vadSpeechSampleCount >= minSpeechSamples &&
      (this.vadSilenceSampleCount >= endSilenceSamples || segmentLength >= maxSegmentSamples)
    ) {
      const segment = joinFrames([...this.vadSpeechFrames, ...this.vadSilenceFrames], segmentLength);
      const segmentStartSample = this.vadSpeechStartSample;
      // Reset before createChunk so a queue-limit throw leaves the next frame clean.
      this.resetVadBuffers();
      return [this.createChunk(segment, false, segmentStartSample)];
    }
    return [];
  }

  private flushVad(endOfStream: boolean): WebRtcTranscriptionChunk[] {
    if (this.closed && this.vadSpeechSampleCount === 0 && this.vadSilenceSampleCount === 0) return [];
    const segmentStartSample = this.vadSpeechStartSample;
    const speechSampleCount = this.vadSpeechSampleCount;
    const segmentLength = speechSampleCount + this.vadSilenceSampleCount;
    const frames = [...this.vadSpeechFrames, ...this.vadSilenceFrames];
    // Reset before createChunk so a queue-limit throw leaves the chunker cleanly closed.
    this.resetVadBuffers();
    this.closed = true;
    if (segmentStartSample === null || speechSampleCount === 0) return [];
    return [this.createChunk(joinFrames(frames, segmentLength), endOfStream, segmentStartSample)];
  }

  private dropVadSegment(): void {
    const droppedSamples = this.vadSpeechSampleCount + this.vadSilenceSampleCount;
    if (droppedSamples > 0) {
      this.vadDroppedSegmentCount += 1;
      this.vadDroppedSampleCount += droppedSamples;
      logger.warn('WebRTC transcription VAD segment dropped after exceeding buffer limit', {
        sessionId: this.context.sessionId,
        broadcastId: this.context.broadcastId,
        revision: this.context.revision,
        droppedMs: Math.round((droppedSamples / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
        droppedSegmentCount: this.vadDroppedSegmentCount,
      });
    }
    this.resetVadBuffers();
    this.nextDiscontinuity = true;
  }

  private resetVadBuffers(): void {
    this.vadSpeechStartSample = null;
    this.vadSpeechFrames = [];
    this.vadSpeechSampleCount = 0;
    this.vadSilenceFrames = [];
    this.vadSilenceSampleCount = 0;
  }

  private appendSamples(samples: Int16Array): void {
    if (this.buffer.length + samples.length > this.maxBufferedSamples) {
      this.nextDiscontinuity = true;
      throw new WebRtcTranscriptionChunkerError(
        'buffer-limit-exceeded',
        'WebRTC transcription audio buffer duration limit exceeded.',
      );
    }
    const next = new Int16Array(this.buffer.length + samples.length);
    next.set(this.buffer, 0);
    next.set(samples, this.buffer.length);
    this.buffer = next;
  }

  private drain(endOfStream: boolean): WebRtcTranscriptionChunk[] {
    const chunks: WebRtcTranscriptionChunk[] = [];
    try {
      while (this.buffer.length >= this.chunkSamples) {
        const samples = this.buffer.slice(0, this.chunkSamples);
        this.buffer = this.buffer.slice(this.chunkSamples);
        chunks.push(this.createChunk(samples, endOfStream && this.buffer.length === 0));
      }
    } catch (error) {
      // A throw aborts the WHOLE batch: callers discard the returned array, so
      // chunks already created in it never reach the owner's queue and will
      // never be acked. Release their accounting here or queuedChunks/
      // queuedBytes drift upward permanently.
      for (const chunk of chunks) this.releaseChunk(chunk);
      throw error;
    }
    return chunks;
  }

  /**
   * Reserve queue accounting for one more chunk, applying the overflow policy.
   * Throws `queue-limit-exceeded` when the chunk cannot be admitted.
   */
  private admitChunk(byteLength: number): void {
    if (this.fitsInQueue(byteLength)) return;
    if (this.onQueueOverflow) {
      while (!this.fitsInQueue(byteLength)) {
        const evicted = this.onQueueOverflow();
        // Nothing left to give up (the remaining chunks are already in flight):
        // fall through and reject the new chunk exactly as reject-new would.
        if (!evicted) break;
        this.releaseChunk(evicted);
        this.evictedChunkCount += 1;
        this.evictedSampleCount += evicted.samples.length;
        this.lastEvictedSequence = evicted.sequence;
        // The evicted audio never reaches media-ingest, so the submitted
        // timeline now has a hole: flag the replacement chunk accordingly.
        this.nextDiscontinuity = true;
      }
      if (this.fitsInQueue(byteLength)) return;
    }
    this.nextDiscontinuity = true;
    throw new WebRtcTranscriptionChunkerError(
      'queue-limit-exceeded',
      'WebRTC transcription chunk queue limit exceeded.',
    );
  }

  private fitsInQueue(byteLength: number): boolean {
    return (
      this.queuedChunks + 1 <= this.maxQueuedChunks &&
      this.queuedBytes + byteLength <= this.maxQueuedBytes
    );
  }

  private createChunk(
    samples: Int16Array,
    endOfStream: boolean,
    explicitStartSample?: number,
  ): WebRtcTranscriptionChunk {
    const byteLength = samples.byteLength;
    this.admitChunk(byteLength);
    const startSample = explicitStartSample ?? this.emittedSampleCount;
    const endSample = startSample + samples.length;
    const startMs = Math.round((startSample / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000);
    const endMs = Math.round((endSample / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000);
    const chunk: WebRtcTranscriptionChunk = {
      ...this.context,
      sequence: this.emittedChunkCount,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      sampleRate: WEBRTC_TRANSCRIPTION_SAMPLE_RATE,
      channelCount: WEBRTC_TRANSCRIPTION_CHANNEL_COUNT,
      pcmFormat: WEBRTC_TRANSCRIPTION_PCM_FORMAT,
      samples,
      byteLength,
      discontinuity: this.nextDiscontinuity,
      endOfStream,
    };
    this.nextDiscontinuity = false;
    this.emittedChunkCount += 1;
    this.emittedSampleCount = Math.max(this.emittedSampleCount, endSample);
    this.queuedChunks += 1;
    this.queuedBytes += byteLength;
    return chunk;
  }
}

export function normalizePcmFrame(data: WebRtcAudioDataLike): Int16Array {
  return normalizePcmFrameWithDiagnostics(data).samples;
}

export function normalizePcmFrameWithDiagnostics(data: WebRtcAudioDataLike): NormalizedWebRtcPcmFrame {
  if (!(data.samples instanceof Int16Array) && !(data.samples instanceof Float32Array)) {
    throw new WebRtcTranscriptionChunkerError('malformed-frame', 'WebRTC audio frame has no PCM samples.');
  }
  if (data.samples.length === 0) {
    throw new WebRtcTranscriptionChunkerError('malformed-frame', 'WebRTC audio frame has no PCM samples.');
  }
  const sourceRate = data.sampleRate;
  const channelCount = data.channelCount;
  if (typeof sourceRate !== 'number' || !Number.isInteger(sourceRate) || sourceRate <= 0) {
    throw new WebRtcTranscriptionChunkerError('malformed-frame', 'WebRTC audio frame sample rate is invalid.');
  }
  if (typeof channelCount !== 'number' || !Number.isInteger(channelCount) || channelCount <= 0 || channelCount > 8) {
    throw new WebRtcTranscriptionChunkerError('malformed-frame', 'WebRTC audio frame channel count is invalid.');
  }
  if (data.samples.length % channelCount !== 0) {
    throw new WebRtcTranscriptionChunkerError('malformed-frame', 'WebRTC audio frame sample layout is invalid.');
  }

  const inputSampleType: 'int16' | 'float32' =
    data.samples instanceof Int16Array ? 'int16' : 'float32';
  const expectedBitsPerSample = inputSampleType === 'int16' ? 16 : 32;
  if (
    typeof data.bitsPerSample === 'number' &&
    Number.isFinite(data.bitsPerSample) &&
    data.bitsPerSample !== expectedBitsPerSample
  ) {
    throw new WebRtcTranscriptionChunkerError(
      'unsupported-format',
      `WebRTC audio frame bit depth ${data.bitsPerSample} is unsupported; expected ${expectedBitsPerSample}-bit ${inputSampleType} PCM.`,
    );
  }
  const pcm16 =
    data.samples instanceof Int16Array ? data.samples : float32ToInt16(data.samples);
  const mono = downmixToMono(pcm16, channelCount);
  const normalized =
    sourceRate === WEBRTC_TRANSCRIPTION_SAMPLE_RATE
      ? mono
      : resampleLinear(mono, sourceRate, WEBRTC_TRANSCRIPTION_SAMPLE_RATE);

  return {
    samples: normalized,
    diagnostics: {
      inputSampleRate: sourceRate,
      inputChannelCount: channelCount,
      inputBitsPerSample:
        typeof data.bitsPerSample === 'number' && Number.isFinite(data.bitsPerSample)
          ? data.bitsPerSample
          : null,
      inputSampleType,
      inputSampleCount: data.samples.length,
      inputDurationMs: Math.round(((data.samples.length / channelCount) / sourceRate) * 1000),
      normalizedSampleRate: WEBRTC_TRANSCRIPTION_SAMPLE_RATE,
      normalizedChannelCount: WEBRTC_TRANSCRIPTION_CHANNEL_COUNT,
      normalizedBitsPerSample: 16,
      normalizedSampleCount: normalized.length,
      normalizedDurationMs: Math.round((normalized.length / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
      ...inspectPcm16Samples(normalized),
      metadataWarnings: [],
    },
  };
}

function downmixToMono(samples: Int16Array, channelCount: number): Int16Array {
  if (channelCount === 1) return samples.slice();
  const frames = samples.length / channelCount;
  const mono = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      sum += samples[frame * channelCount + channel] ?? 0;
    }
    mono[frame] = clampInt16(Math.round(sum / channelCount));
  }
  return mono;
}

function resampleLinear(samples: Int16Array, sourceRate: number, targetRate: number): Int16Array {
  if (samples.length === 0) return samples;
  const outputLength = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
  const output = new Int16Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index++) {
    const sourcePosition = index * ratio;
    const left = Math.floor(sourcePosition);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourcePosition - left;
    output[index] = clampInt16(Math.round((samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction));
  }
  return output;
}

function clampInt16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

function float32ToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    output[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
  }
  return output;
}

export function inspectPcm16Samples(samples: Int16Array): Pick<
  WebRtcAudioPcmDiagnostics,
  'rms' | 'peak' | 'clippedSampleCount' | 'silent'
> {
  if (samples.length === 0) {
    return {
      rms: 0,
      peak: 0,
      clippedSampleCount: 0,
      silent: true,
    };
  }
  let sumSquares = 0;
  let peak = 0;
  let clippedSampleCount = 0;
  for (const sample of samples) {
    const absolute = Math.abs(sample);
    peak = Math.max(peak, absolute / 32768);
    if (absolute >= 32767) clippedSampleCount++;
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return {
    rms,
    peak,
    clippedSampleCount,
    silent: rms < 0.0001 && peak < 0.0005,
  };
}

let sileroFallbackWarned = false;

function warnSileroUnavailableOnce(): void {
  if (sileroFallbackWarned) return;
  sileroFallbackWarned = true;
  logger.warn(
    'WEBRTC_VAD_MODE=silero is configured but Silero VAD is not implemented yet; falling back to the energy-gate VAD',
  );
}

function joinFrames(frames: Int16Array[], totalSampleCount: number): Int16Array {
  const output = new Int16Array(totalSampleCount);
  let offset = 0;
  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.length;
  }
  return output;
}

function frameEnergy(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    total += normalized * normalized;
  }
  return Math.sqrt(total / samples.length);
}
