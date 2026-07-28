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

export interface WebRtcTranscriptionChunkerOptions extends WebRtcTranscriptionChunkerContext {
  chunkDurationMs?: number;
  maxBufferedDurationMs?: number;
  maxQueuedChunks?: number;
  maxQueuedBytes?: number;
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

  constructor(options: WebRtcTranscriptionChunkerOptions) {
    this.context = {
      sessionId: options.sessionId,
      broadcastId: options.broadcastId,
      broadcasterPeerId: options.broadcasterPeerId,
      revision: options.revision,
    };
    this.chunkSamples = Math.max(
      1,
      Math.round(((options.chunkDurationMs ?? 15_000) / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE),
    );
    this.maxBufferedSamples = Math.round(
      ((options.maxBufferedDurationMs ?? 30_000) / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE,
    );
    this.maxQueuedChunks = options.maxQueuedChunks ?? 8;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 8 * 1024 * 1024;
  }

  pushFrame(data: WebRtcAudioDataLike): WebRtcTranscriptionChunk[] {
    if (this.closed) {
      throw new WebRtcTranscriptionChunkerError('closed', 'WebRTC transcription chunker is closed.');
    }
    const normalized = normalizePcmFrame(data);
    this.appendSamples(normalized);
    return this.drain(false);
  }

  flush(endOfStream = true): WebRtcTranscriptionChunk[] {
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
      closed: this.closed,
    };
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

  private createChunk(samples: Int16Array, endOfStream: boolean): WebRtcTranscriptionChunk {
    const byteLength = samples.byteLength;
    if (this.queuedChunks + 1 > this.maxQueuedChunks || this.queuedBytes + byteLength > this.maxQueuedBytes) {
      this.nextDiscontinuity = true;
      throw new WebRtcTranscriptionChunkerError(
        'queue-limit-exceeded',
        'WebRTC transcription chunk queue limit exceeded.',
      );
    }
    const startSample = this.emittedSampleCount;
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
    this.emittedSampleCount = endSample;
    this.queuedChunks += 1;
    this.queuedBytes += byteLength;
    return chunk;
  }
}

export function normalizePcmFrame(data: WebRtcAudioDataLike): Int16Array {
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
  if (data.bitsPerSample !== undefined && data.bitsPerSample !== 16 && data.bitsPerSample !== 32) {
    throw new WebRtcTranscriptionChunkerError('unsupported-format', 'WebRTC audio frame must be 16-bit PCM.');
  }
  if (data.samples.length % channelCount !== 0) {
    throw new WebRtcTranscriptionChunkerError('malformed-frame', 'WebRTC audio frame sample layout is invalid.');
  }

  const pcm16 = data.samples instanceof Int16Array ? data.samples : float32ToInt16(data.samples);
  const mono = downmixToMono(pcm16, channelCount);
  if (sourceRate === WEBRTC_TRANSCRIPTION_SAMPLE_RATE) return mono;
  return resampleLinear(mono, sourceRate, WEBRTC_TRANSCRIPTION_SAMPLE_RATE);
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
