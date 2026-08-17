export type WebRtcAudioIngestBridgeState = 'idle' | 'opened' | 'track-attached' | 'active' | 'ended' | 'failed' | 'closed';

export interface WebRtcAudioFrameMetadata {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
  sequence: number;
  receivedAtMs: number;
  relativeIngestMs: number;
  sampleRate: number | null;
  channelCount: number | null;
  bitsPerSample: number | null;
  numberOfFrames: number | null;
  sampleCount: number | null;
}

export interface WebRtcAudioIngestBridgeSnapshot {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
  state: WebRtcAudioIngestBridgeState;
  codec: string;
  frameCount: number;
  firstFrameAtMs: number | null;
  lastFrameAtMs: number | null;
  lastActivityAtMs: number | null;
  lastFrame: WebRtcAudioFrameMetadata | null;
  /**
   * W3 — the rate frames ACTUALLY arrive at, before any gateway resampling.
   *
   * It was recorded on every frame and then dropped before anything could read
   * it, which is why nobody could say whether the 48 kHz path was engaged. It
   * has to be stamped on each corpus recording: change the resampler and you
   * need to know which recordings' acoustic measurements must be rerun.
   */
  inputSampleRate: number | null;
  inputChannelCount: number | null;
  error: string | null;
}

export interface WebRtcAudioIngestBridgeOptions {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
  codec?: string;
  nowMs?: () => number;
  maxStoredFrames?: number;
}

export interface WebRtcAudioDataLike {
  samples?: Int16Array | Float32Array;
  sampleRate?: number;
  bitsPerSample?: number;
  channelCount?: number;
  numberOfFrames?: number;
}

export class WebRtcAudioIngestBridge {
  private readonly sessionId: string;
  private readonly broadcastId: string;
  private readonly broadcasterPeerId: string;
  private readonly revision: number;
  private readonly codec: string;
  private readonly nowMs: () => number;
  private readonly maxStoredFrames: number;
  private state: WebRtcAudioIngestBridgeState = 'idle';
  private openedAtMs: number | null = null;
  private firstFrameAtMs: number | null = null;
  private lastFrameAtMs: number | null = null;
  private lastActivityAtMs: number | null = null;
  private frameCount = 0;
  private lastFrame: WebRtcAudioFrameMetadata | null = null;
  private storedFrameCount = 0;
  private error: string | null = null;

  constructor(options: WebRtcAudioIngestBridgeOptions) {
    this.sessionId = options.sessionId;
    this.broadcastId = options.broadcastId;
    this.broadcasterPeerId = options.broadcasterPeerId;
    this.revision = options.revision;
    this.codec = options.codec ?? 'opus/decoded-pcm';
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.maxStoredFrames = options.maxStoredFrames ?? 1;
  }

  open(): WebRtcAudioIngestBridgeSnapshot {
    if (this.state === 'closed') return this.snapshot();
    this.openedAtMs = this.nowMs();
    this.state = 'opened';
    return this.snapshot();
  }

  attachTrack(): WebRtcAudioIngestBridgeSnapshot {
    if (this.state === 'closed') return this.snapshot();
    if (!this.openedAtMs) this.open();
    this.state = 'track-attached';
    return this.snapshot();
  }

  recordFrame(data: WebRtcAudioDataLike): WebRtcAudioFrameMetadata {
    if (this.state === 'closed') {
      throw new Error('WebRTC audio ingest bridge is closed.');
    }
    if (!this.openedAtMs) this.open();
    const receivedAtMs = this.nowMs();
    const openedAtMs = this.openedAtMs ?? receivedAtMs;
    this.frameCount += 1;
    this.storedFrameCount = Math.min(this.maxStoredFrames, this.storedFrameCount + 1);
    this.firstFrameAtMs ??= receivedAtMs;
    this.lastFrameAtMs = receivedAtMs;
    this.lastActivityAtMs = receivedAtMs;
    this.state = 'active';
    this.lastFrame = {
      sessionId: this.sessionId,
      broadcastId: this.broadcastId,
      broadcasterPeerId: this.broadcasterPeerId,
      revision: this.revision,
      sequence: this.frameCount - 1,
      receivedAtMs,
      relativeIngestMs: receivedAtMs - openedAtMs,
      sampleRate: data.sampleRate ?? null,
      channelCount: data.channelCount ?? null,
      bitsPerSample: data.bitsPerSample ?? null,
      numberOfFrames: data.numberOfFrames ?? null,
      sampleCount: data.samples?.length ?? null,
    };
    return this.lastFrame;
  }

  endTrack(): WebRtcAudioIngestBridgeSnapshot {
    if (this.state !== 'closed') this.state = 'ended';
    return this.snapshot();
  }

  fail(message: string): WebRtcAudioIngestBridgeSnapshot {
    this.error = message;
    this.state = 'failed';
    return this.snapshot();
  }

  close(): WebRtcAudioIngestBridgeSnapshot {
    this.state = 'closed';
    return this.snapshot();
  }

  snapshot(): WebRtcAudioIngestBridgeSnapshot {
    return {
      sessionId: this.sessionId,
      broadcastId: this.broadcastId,
      broadcasterPeerId: this.broadcasterPeerId,
      revision: this.revision,
      state: this.state,
      codec: this.codec,
      frameCount: this.frameCount,
      firstFrameAtMs: this.firstFrameAtMs,
      lastFrameAtMs: this.lastFrameAtMs,
      lastActivityAtMs: this.lastActivityAtMs,
      lastFrame: this.lastFrame,
      inputSampleRate: this.lastFrame?.sampleRate ?? null,
      inputChannelCount: this.lastFrame?.channelCount ?? null,
      error: this.error,
    };
  }
}
