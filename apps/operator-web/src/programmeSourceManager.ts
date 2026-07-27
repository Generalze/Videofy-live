export type ProgrammeSourceType = 'none' | 'camera' | 'screen' | 'uploaded-video';

export type ProgrammePlaybackState =
  | 'idle'
  | 'selecting'
  | 'preview-ready'
  | 'broadcasting'
  | 'paused'
  | 'seeking'
  | 'ended'
  | 'failed'
  | 'stopped';

export type ProgrammeSourceErrorCode =
  | 'media-api-unavailable'
  | 'insecure-context'
  | 'permission-denied'
  | 'device-unavailable'
  | 'unsupported-format'
  | 'decode-failed'
  | 'missing-media-track'
  | 'duplicate-source'
  | 'capture-stream-unavailable'
  | 'source-ended'
  | 'cleanup-failure';

export interface ProgrammeSourceErrorDetails {
  code: ProgrammeSourceErrorCode;
  message: string;
  recoverable: boolean;
}

export interface ProgrammeSourceDevice {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'videoinput';
}

export interface ProgrammeSourceSnapshot {
  sourceType: ProgrammeSourceType;
  sourceIdentity: string;
  status: ProgrammePlaybackState;
  revision: number;
  audioDetected: boolean;
  videoDetected: boolean;
  audioTrackId: string | null;
  videoTrackId: string | null;
  previewReady: boolean;
  broadcasting: boolean;
  paused: boolean;
  programmeTimestampMs: number;
  durationMs: number | null;
  canPause: boolean;
  canResume: boolean;
  canSeek: boolean;
  canRestart: boolean;
  availableDevices: ProgrammeSourceDevice[];
  selectedAudioDeviceId: string;
  selectedVideoDeviceId: string;
  error: ProgrammeSourceErrorDetails | null;
  updatedAt: string;
}

export interface ProgrammeSourceManagerOptions {
  mediaDevices?: MediaDevices;
  isSecureContext?: boolean;
  createObjectUrl?: (file: File) => string;
  revokeObjectUrl?: (url: string) => void;
  now?: () => number;
  onStateChange?: (snapshot: ProgrammeSourceSnapshot) => void;
  onRevisionChange?: (revision: number, reason: string) => void;
  onTrackEnded?: (snapshot: ProgrammeSourceSnapshot) => void;
  onFailure?: (error: ProgrammeSourceErrorDetails) => void;
}

interface CaptureVideoElement extends HTMLVideoElement {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
}

const UPLOADED_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov']);
const UPLOADED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-quicktime',
]);

export class ProgrammeSourceError extends Error {
  constructor(
    readonly code: ProgrammeSourceErrorCode,
    message: string,
    readonly recoverable = true,
  ) {
    super(message);
    this.name = 'ProgrammeSourceError';
  }
}

export function createInitialProgrammeSourceSnapshot(): ProgrammeSourceSnapshot {
  return {
    sourceType: 'none',
    sourceIdentity: 'No source selected',
    status: 'idle',
    revision: 0,
    audioDetected: false,
    videoDetected: false,
    audioTrackId: null,
    videoTrackId: null,
    previewReady: false,
    broadcasting: false,
    paused: false,
    programmeTimestampMs: 0,
    durationMs: null,
    canPause: false,
    canResume: false,
    canSeek: false,
    canRestart: false,
    availableDevices: [],
    selectedAudioDeviceId: '',
    selectedVideoDeviceId: '',
    error: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export function isUploadedProgrammeVideoSupported(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = file.type.toLowerCase();
  if (!UPLOADED_VIDEO_EXTENSIONS.has(extension)) return false;
  if (!mimeType) return true;
  return UPLOADED_VIDEO_MIME_TYPES.has(mimeType);
}

export class ProgrammeSourceManager {
  private readonly mediaDevices: MediaDevices | undefined;
  private readonly isSecureContext: boolean;
  private readonly createObjectUrl: (file: File) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly now: () => number;
  private readonly onStateChange: ((snapshot: ProgrammeSourceSnapshot) => void) | undefined;
  private readonly onRevisionChange: ((revision: number, reason: string) => void) | undefined;
  private readonly onTrackEnded: ((snapshot: ProgrammeSourceSnapshot) => void) | undefined;
  private readonly onFailure: ((error: ProgrammeSourceErrorDetails) => void) | undefined;

  private snapshot = createInitialProgrammeSourceSnapshot();
  private stream: MediaStream | null = null;
  private ownedTracks = new Set<MediaStreamTrack>();
  private objectUrl: string | null = null;
  private videoElement: CaptureVideoElement | null = null;
  private liveStartedAtMs: number | null = null;
  private livePausedAtMs: number | null = null;
  private livePausedDurationMs = 0;

  constructor(options: ProgrammeSourceManagerOptions = {}) {
    this.mediaDevices = options.mediaDevices;
    this.isSecureContext = options.isSecureContext ?? true;
    this.createObjectUrl =
      options.createObjectUrl ?? ((file) => URL.createObjectURL(file));
    this.revokeObjectUrl =
      options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.now = options.now ?? (() => Date.now());
    this.onStateChange = options.onStateChange;
    this.onRevisionChange = options.onRevisionChange;
    this.onTrackEnded = options.onTrackEnded;
    this.onFailure = options.onFailure;
  }

  getSnapshot(): ProgrammeSourceSnapshot {
    return this.snapshot;
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  async refreshDevices(): Promise<ProgrammeSourceSnapshot> {
    if (!this.mediaDevices?.enumerateDevices) return this.snapshot;
    const devices = (await this.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'audioinput' || device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `${device.kind === 'videoinput' ? 'Camera' : 'Audio input'} ${index + 1}`,
        kind: device.kind as 'audioinput' | 'videoinput',
      }));
    this.update({ availableDevices: devices, error: null });
    return this.snapshot;
  }

  async selectCamera(
    input: { audioDeviceId?: string; videoDeviceId?: string } = {},
    previewElement?: CaptureVideoElement | null,
  ): Promise<ProgrammeSourceSnapshot> {
    this.assertCanUseMediaDevices('getUserMedia');
    this.assertNoActiveSource();
    this.update({
      sourceType: 'camera',
      sourceIdentity: 'Camera',
      status: 'selecting',
      selectedAudioDeviceId: input.audioDeviceId ?? '',
      selectedVideoDeviceId: input.videoDeviceId ?? '',
      error: null,
    });
    let stream: MediaStream | null = null;
    try {
      stream = await this.mediaDevices!.getUserMedia({
        audio: input.audioDeviceId ? { deviceId: { exact: input.audioDeviceId } } : true,
        video: input.videoDeviceId ? { deviceId: { exact: input.videoDeviceId } } : true,
      });
      this.assertUsableTracks(stream, { requireVideo: true });
      this.attachPreviewElement(previewElement ?? null, stream);
      this.installStream('camera', input.videoDeviceId || 'Browser camera', stream, {
        canPause: true,
        canResume: true,
        preservePreview: Boolean(previewElement),
      });
      return this.snapshot;
    } catch (error) {
      if (stream) this.stopStream(stream);
      throw this.fail(normalizeProgrammeSourceError(error));
    }
  }

  async selectScreen(previewElement?: CaptureVideoElement | null): Promise<ProgrammeSourceSnapshot> {
    this.assertCanUseMediaDevices('getDisplayMedia');
    this.assertNoActiveSource();
    this.update({
      sourceType: 'screen',
      sourceIdentity: 'Screen or tab',
      status: 'selecting',
      error: null,
    });
    let stream: MediaStream | null = null;
    try {
      stream = await this.mediaDevices!.getDisplayMedia({ video: true, audio: true });
      this.assertUsableTracks(stream, { requireVideo: true });
      this.attachPreviewElement(previewElement ?? null, stream);
      this.installStream('screen', 'Screen or browser tab', stream, {
        canPause: true,
        canResume: true,
        preservePreview: Boolean(previewElement),
      });
      return this.snapshot;
    } catch (error) {
      if (stream) this.stopStream(stream);
      throw this.fail(normalizeProgrammeSourceError(error));
    }
  }

  async selectUploadedVideo(file: File, videoElement: CaptureVideoElement): Promise<ProgrammeSourceSnapshot> {
    this.assertNoActiveSource();
    if (!isUploadedProgrammeVideoSupported(file)) {
      throw this.fail(
        new ProgrammeSourceError(
          'unsupported-format',
          'Select an MP4 or WebM video, or a MOV file that this browser can decode.',
          false,
        ),
      );
    }
    if (!videoElement.captureStream && !videoElement.mozCaptureStream) {
      throw this.fail(
        new ProgrammeSourceError(
          'capture-stream-unavailable',
          'This browser cannot publish uploaded video through captureStream().',
          false,
        ),
      );
    }

    this.update({
      sourceType: 'uploaded-video',
      sourceIdentity: file.name,
      status: 'selecting',
      durationMs: null,
      error: null,
    });

    const objectUrl = this.createObjectUrl(file);
    this.objectUrl = objectUrl;
    this.videoElement = videoElement;
    try {
      videoElement.muted = true;
      videoElement.playsInline = true;
      videoElement.preload = 'metadata';
      videoElement.src = objectUrl;
      videoElement.load?.();
      void videoElement.play?.().catch(() => undefined);
      await waitForMediaReady(videoElement);
      const stream = (videoElement.captureStream ?? videoElement.mozCaptureStream)!.call(videoElement);
      this.assertUsableTracks(stream, { requireVideo: false });
      this.installStream('uploaded-video', file.name, stream, {
        durationMs: Number.isFinite(videoElement.duration) ? Math.round(videoElement.duration * 1000) : null,
        canPause: true,
        canResume: true,
        canSeek: true,
        canRestart: true,
        preserveObjectUrl: true,
        preservePreview: true,
      });
      this.update({ programmeTimestampMs: Math.round((videoElement.currentTime || 0) * 1000) });
      return this.snapshot;
    } catch (error) {
      this.releaseResources();
      throw this.fail(normalizeProgrammeSourceError(error, 'decode-failed'));
    }
  }

  async start(): Promise<ProgrammeSourceSnapshot> {
    if (!this.stream || this.snapshot.status !== 'preview-ready') {
      throw this.fail(new ProgrammeSourceError('missing-media-track', 'Select a programme source before starting.'));
    }
    if (this.snapshot.sourceType === 'uploaded-video' && this.videoElement) {
      await this.videoElement.play().catch((error: unknown) => {
        throw normalizeProgrammeSourceError(error, 'decode-failed');
      });
    } else {
      this.liveStartedAtMs = this.now();
      this.livePausedAtMs = null;
      this.livePausedDurationMs = 0;
    }
    this.enableTracks(true);
    this.update({
      status: 'broadcasting',
      broadcasting: true,
      paused: false,
      programmeTimestampMs: this.readProgrammeTimestampMs(),
      error: null,
    });
    return this.snapshot;
  }

  async pause(): Promise<ProgrammeSourceSnapshot> {
    if (!this.stream || this.snapshot.status !== 'broadcasting') return this.snapshot;
    if (this.snapshot.sourceType === 'uploaded-video') {
      this.videoElement?.pause();
    } else {
      this.livePausedAtMs = this.now();
      this.enableTracks(false);
    }
    this.update({
      status: 'paused',
      broadcasting: false,
      paused: true,
      programmeTimestampMs: this.readProgrammeTimestampMs(),
    });
    return this.snapshot;
  }

  async resume(): Promise<ProgrammeSourceSnapshot> {
    if (!this.stream || this.snapshot.status !== 'paused') return this.snapshot;
    if (this.snapshot.sourceType === 'uploaded-video' && this.videoElement) {
      await this.videoElement.play();
    } else {
      if (this.livePausedAtMs !== null) {
        this.livePausedDurationMs += this.now() - this.livePausedAtMs;
      }
      this.livePausedAtMs = null;
      this.enableTracks(true);
    }
    this.update({
      status: 'broadcasting',
      broadcasting: true,
      paused: false,
      programmeTimestampMs: this.readProgrammeTimestampMs(),
      error: null,
    });
    return this.snapshot;
  }

  async seek(ms: number): Promise<ProgrammeSourceSnapshot> {
    if (!this.snapshot.canSeek || !this.videoElement) {
      throw this.fail(new ProgrammeSourceError('unsupported-format', 'The selected source cannot seek.', false));
    }
    this.update({ status: 'seeking', broadcasting: false, paused: true });
    this.videoElement.currentTime = Math.max(0, ms / 1000);
    this.incrementRevision('uploaded video seek');
    this.update({
      status: 'preview-ready',
      broadcasting: false,
      paused: false,
      programmeTimestampMs: this.readProgrammeTimestampMs(),
    });
    return this.snapshot;
  }

  async restart(): Promise<ProgrammeSourceSnapshot> {
    if (!this.snapshot.canRestart) {
      throw this.fail(new ProgrammeSourceError('unsupported-format', 'The selected source cannot restart.', false));
    }
    await this.seek(0);
    this.incrementRevision('programme restart');
    return this.snapshot;
  }

  async stop(reason = 'operator stopped programme source'): Promise<ProgrammeSourceSnapshot> {
    if (this.snapshot.status === 'idle' || this.snapshot.status === 'stopped') return this.snapshot;
    this.releaseResources();
    this.update({
      status: 'stopped',
      broadcasting: false,
      paused: false,
      previewReady: false,
      audioDetected: false,
      videoDetected: false,
      audioTrackId: null,
      videoTrackId: null,
      programmeTimestampMs: 0,
      sourceIdentity: reason,
      error: null,
    });
    return this.snapshot;
  }

  async clear(): Promise<ProgrammeSourceSnapshot> {
    this.releaseResources();
    this.snapshot = {
      ...createInitialProgrammeSourceSnapshot(),
      revision: this.snapshot.revision,
      availableDevices: this.snapshot.availableDevices,
      updatedAt: new Date().toISOString(),
    };
    this.onStateChange?.(this.snapshot);
    return this.snapshot;
  }

  async teardown(): Promise<void> {
    try {
      await this.clear();
    } catch (error) {
      this.fail(normalizeProgrammeSourceError(error, 'cleanup-failure'));
    }
  }

  private installStream(
    sourceType: Exclude<ProgrammeSourceType, 'none'>,
    sourceIdentity: string,
    stream: MediaStream,
    options: {
      durationMs?: number | null;
      canPause?: boolean;
      canResume?: boolean;
      canSeek?: boolean;
      canRestart?: boolean;
      preserveObjectUrl?: boolean;
      preservePreview?: boolean;
    } = {},
  ): void {
    this.releaseResources({
      ...(options.preserveObjectUrl !== undefined ? { preserveObjectUrl: options.preserveObjectUrl } : {}),
      ...(options.preservePreview !== undefined ? { preservePreview: options.preservePreview } : {}),
    });
    this.stream = stream;
    for (const track of stream.getTracks()) {
      track.addEventListener?.('ended', this.handleTrackEnded);
      this.ownedTracks.add(track);
    }
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    const videoTrack = stream.getVideoTracks()[0] ?? null;
    this.update({
      sourceType,
      sourceIdentity,
      status: 'preview-ready',
      audioDetected: Boolean(audioTrack),
      videoDetected: Boolean(videoTrack),
      audioTrackId: audioTrack?.id ?? null,
      videoTrackId: videoTrack?.id ?? null,
      previewReady: true,
      broadcasting: false,
      paused: false,
      durationMs: options.durationMs ?? null,
      canPause: options.canPause ?? false,
      canResume: options.canResume ?? false,
      canSeek: options.canSeek ?? false,
      canRestart: options.canRestart ?? false,
      error: null,
    });
  }

  private attachPreviewElement(
    previewElement: CaptureVideoElement | null,
    stream: MediaStream,
  ): void {
    if (!previewElement) return;
    this.videoElement = previewElement;
    previewElement.muted = true;
    previewElement.playsInline = true;
    previewElement.srcObject = stream;
    void previewElement.play?.().catch(() => undefined);
  }

  private assertCanUseMediaDevices(method: 'getUserMedia' | 'getDisplayMedia'): void {
    if (!this.isSecureContext) {
      throw this.fail(
        new ProgrammeSourceError(
          'insecure-context',
          'Browser programme capture requires HTTPS or localhost.',
          false,
        ),
      );
    }
    if (!this.mediaDevices?.[method]) {
      throw this.fail(
        new ProgrammeSourceError(
          'media-api-unavailable',
          `This browser does not support ${method} programme capture.`,
          false,
        ),
      );
    }
  }

  private assertNoActiveSource(): void {
    if (this.stream && this.snapshot.status !== 'stopped' && this.snapshot.status !== 'failed') {
      throw this.fail(new ProgrammeSourceError('duplicate-source', 'Clear the current programme source before selecting another.'));
    }
  }

  private assertUsableTracks(stream: MediaStream, options: { requireVideo: boolean }): void {
    const audioTracks = stream.getAudioTracks().filter((track) => track.readyState !== 'ended');
    const videoTracks = stream.getVideoTracks().filter((track) => track.readyState !== 'ended');
    if (audioTracks.length > 1 || videoTracks.length > 1) {
      throw new ProgrammeSourceError('duplicate-source', 'Programme source must expose at most one audio and one video track.', false);
    }
    if (options.requireVideo && videoTracks.length === 0) {
      throw new ProgrammeSourceError('missing-media-track', 'The selected source did not provide a usable video track.');
    }
    if (audioTracks.length === 0 && videoTracks.length === 0) {
      throw new ProgrammeSourceError('missing-media-track', 'The selected source did not provide usable media tracks.');
    }
  }

  private readProgrammeTimestampMs(): number {
    if (this.snapshot.sourceType === 'uploaded-video' && this.videoElement) {
      return Math.round((this.videoElement.currentTime || 0) * 1000);
    }
    if (this.liveStartedAtMs === null) return this.snapshot.programmeTimestampMs;
    const pausedMs =
      this.livePausedAtMs === null
        ? this.livePausedDurationMs
        : this.livePausedDurationMs + this.now() - this.livePausedAtMs;
    return Math.max(0, this.now() - this.liveStartedAtMs - pausedMs);
  }

  private incrementRevision(reason: string): void {
    const revision = this.snapshot.revision + 1;
    this.update({ revision });
    this.onRevisionChange?.(revision, reason);
  }

  private enableTracks(enabled: boolean): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  private handleTrackEnded = (): void => {
    this.update({
      status: 'ended',
      broadcasting: false,
      paused: false,
      audioDetected: this.stream?.getAudioTracks().some((track) => track.readyState !== 'ended') ?? false,
      videoDetected: this.stream?.getVideoTracks().some((track) => track.readyState !== 'ended') ?? false,
      error: errorDetails(new ProgrammeSourceError('source-ended', 'Programme source track ended.')),
    });
    this.incrementRevision('programme source track ended');
    this.onTrackEnded?.(this.snapshot);
  };

  private releaseResources(options: { preserveObjectUrl?: boolean; preservePreview?: boolean } = {}): void {
    for (const track of this.ownedTracks) {
      track.removeEventListener?.('ended', this.handleTrackEnded);
    }
    this.ownedTracks.clear();
    if (this.stream) this.stopStream(this.stream);
    this.stream = null;
    if (this.videoElement && !options.preservePreview) {
      this.videoElement.pause();
      this.videoElement.srcObject = null;
      this.videoElement.removeAttribute('src');
      this.videoElement.load?.();
      this.videoElement = null;
    }
    if (this.objectUrl && !options.preserveObjectUrl) {
      this.revokeObjectUrl(this.objectUrl);
      this.objectUrl = null;
    }
    this.liveStartedAtMs = null;
    this.livePausedAtMs = null;
    this.livePausedDurationMs = 0;
  }

  private stopStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      if (track.readyState !== 'ended') track.stop();
    }
  }

  private fail(error: ProgrammeSourceError): ProgrammeSourceError {
    const details = errorDetails(error);
    this.update({
      status: 'failed',
      broadcasting: false,
      paused: false,
      previewReady: false,
      error: details,
    });
    this.onFailure?.(details);
    return error;
  }

  private update(next: Partial<ProgrammeSourceSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...next,
      updatedAt: new Date().toISOString(),
    };
    this.onStateChange?.(this.snapshot);
  }
}

function waitForMediaReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = window.setInterval(() => {
      if (video.readyState >= 1) {
        cleanup();
        resolve();
      }
      if (Date.now() - startedAt > 30_000) {
        cleanup();
        reject(new ProgrammeSourceError(
          'decode-failed',
          `Timed out waiting for browser video metadata. readyState=${video.readyState} networkState=${video.networkState} error=${video.error?.code ?? 'none'}`,
        ));
      }
    }, 100);
    const cleanup = (): void => {
      window.clearInterval(poll);
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new ProgrammeSourceError('decode-failed', 'The browser could not decode the selected video.'));
    };
    video.addEventListener('loadedmetadata', onReady, { once: true });
    video.addEventListener('canplay', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function normalizeProgrammeSourceError(
  error: unknown,
  fallbackCode: ProgrammeSourceErrorCode = 'media-api-unavailable',
): ProgrammeSourceError {
  if (error instanceof ProgrammeSourceError) return error;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return new ProgrammeSourceError('permission-denied', 'Programme source permission denied.');
    }
    if (error.name === 'NotFoundError') {
      return new ProgrammeSourceError('device-unavailable', 'Requested programme source device is unavailable.');
    }
    if (error.name === 'NotReadableError') {
      return new ProgrammeSourceError('device-unavailable', 'Programme source device is busy or unreadable.');
    }
    if (error.name === 'AbortError') {
      return new ProgrammeSourceError('permission-denied', 'Programme source selection was cancelled.');
    }
    if (error.name === 'SecurityError') {
      return new ProgrammeSourceError('insecure-context', 'Browser blocked programme source capture.', false);
    }
  }
  return new ProgrammeSourceError(
    fallbackCode,
    error instanceof Error ? error.message : 'Programme source failed.',
    fallbackCode !== 'unsupported-format',
  );
}

function errorDetails(error: ProgrammeSourceError): ProgrammeSourceErrorDetails {
  return {
    code: error.code,
    message: error.message,
    recoverable: error.recoverable,
  };
}
