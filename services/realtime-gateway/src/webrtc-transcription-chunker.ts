import type { WebRtcAudioDataLike } from './webrtc-audio-ingest-bridge.js';

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

export interface WebRtcTranscriptionChunkerOptions extends WebRtcTranscriptionChunkerContext {
  chunkDurationMs?: number;
  maxBufferedDurationMs?: number;
  maxQueuedChunks?: number;
  maxQueuedBytes?: number;
  vad?: WebRtcVadOptions;
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
  private buffer = new Int16Array(0);
  private emittedChunkCount = 0;
  private emittedSampleCount = 0;
  private queuedChunks = 0;
  private queuedBytes = 0;
  private nextDiscontinuity = false;
  private closed = false;
  private readonly vad: Required<WebRtcVadOptions> | null;
  private vadSpeechBuffer: Int16Array<ArrayBufferLike> = new Int16Array(0);
  private vadSpeechStartSample: number | null = null;
  private vadSilenceBuffer: Int16Array<ArrayBufferLike> = new Int16Array(0);
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
    this.vad = options.vad?.enabled
      ? {
          enabled: true,
          mode: options.vad.mode,
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

  snapshot() {
    return {
      sessionId: this.context.sessionId,
      broadcastId: this.context.broadcastId,
      revision: this.context.revision,
      bufferedDurationMs: Math.round((this.buffer.length / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
      queuedChunks: this.queuedChunks,
      queuedBytes: this.queuedBytes,
      emittedChunkCount: this.emittedChunkCount,
      vadMode: this.vad?.mode ?? 'disabled',
      skippedSilenceMs: Math.round((this.skippedSilenceSamples / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
      closed: this.closed,
    };
  }

  private pushVadFrame(samples: Int16Array): WebRtcTranscriptionChunk[] {
    const startSample = this.inputSampleCount;
    this.inputSampleCount += samples.length;
    const vad = this.vad;
    if (!vad) return [];
    const isSpeech = frameEnergy(samples) >= vad.speechThreshold;
    if (isSpeech) {
      if (this.vadSpeechStartSample === null) {
        this.vadSpeechStartSample = startSample;
      }
      if (this.vadSilenceBuffer.length > 0) {
        this.vadSpeechBuffer = concatSamples(this.vadSpeechBuffer, this.vadSilenceBuffer);
        this.vadSilenceBuffer = new Int16Array(0);
      }
      this.vadSpeechBuffer = concatSamples(this.vadSpeechBuffer, samples);
    } else if (this.vadSpeechStartSample === null) {
      this.skippedSilenceSamples += samples.length;
      return [];
    } else {
      this.vadSilenceBuffer = concatSamples(this.vadSilenceBuffer, samples);
    }

    const segmentLength = this.vadSpeechBuffer.length + this.vadSilenceBuffer.length;
    const endSilenceSamples = Math.round((vad.endSilenceMs / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE);
    const maxSegmentSamples = Math.round((vad.maxSegmentMs / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE);
    const minSpeechSamples = Math.round((vad.minSpeechMs / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE);
    if (
      this.vadSpeechStartSample !== null &&
      this.vadSpeechBuffer.length >= minSpeechSamples &&
      (this.vadSilenceBuffer.length >= endSilenceSamples || segmentLength >= maxSegmentSamples)
    ) {
      const segment = concatSamples(this.vadSpeechBuffer, this.vadSilenceBuffer);
      const chunk = this.createChunk(segment, false, this.vadSpeechStartSample);
      this.vadSpeechStartSample = null;
      this.vadSpeechBuffer = new Int16Array(0);
      this.vadSilenceBuffer = new Int16Array(0);
      return [chunk];
    }
    return [];
  }

  private flushVad(endOfStream: boolean): WebRtcTranscriptionChunk[] {
    if (this.closed && this.vadSpeechBuffer.length === 0 && this.vadSilenceBuffer.length === 0) return [];
    const chunks =
      this.vadSpeechStartSample !== null && this.vadSpeechBuffer.length > 0
        ? [
            this.createChunk(
              concatSamples(this.vadSpeechBuffer, this.vadSilenceBuffer),
              endOfStream,
              this.vadSpeechStartSample,
            ),
          ]
        : [];
    this.vadSpeechStartSample = null;
    this.vadSpeechBuffer = new Int16Array(0);
    this.vadSilenceBuffer = new Int16Array(0);
    this.closed = true;
    return chunks;
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
    while (this.buffer.length >= this.chunkSamples) {
      const samples = this.buffer.slice(0, this.chunkSamples);
      this.buffer = this.buffer.slice(this.chunkSamples);
      chunks.push(this.createChunk(samples, endOfStream && this.buffer.length === 0));
    }
    return chunks;
  }

  private createChunk(
    samples: Int16Array,
    endOfStream: boolean,
    explicitStartSample?: number,
  ): WebRtcTranscriptionChunk {
    const byteLength = samples.byteLength;
    if (this.queuedChunks + 1 > this.maxQueuedChunks || this.queuedBytes + byteLength > this.maxQueuedBytes) {
      this.nextDiscontinuity = true;
      throw new WebRtcTranscriptionChunkerError(
        'queue-limit-exceeded',
        'WebRTC transcription chunk queue limit exceeded.',
      );
    }
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
  const metadataWarnings = frameMetadataWarnings(inputSampleType, data.bitsPerSample);
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
      metadataWarnings,
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

function frameMetadataWarnings(
  sampleType: 'int16' | 'float32',
  bitsPerSample: number | undefined,
): string[] {
  if (bitsPerSample === undefined) return [];
  const expectedBits = sampleType === 'int16' ? 16 : 32;
  if (bitsPerSample === expectedBits) return [];
  return [`bitsPerSample metadata ${bitsPerSample} did not match ${sampleType} samples`];
}

function concatSamples(left: Int16Array, right: Int16Array): Int16Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left.slice();
  const output = new Int16Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
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
