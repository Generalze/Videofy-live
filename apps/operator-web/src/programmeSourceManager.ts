export type ProgrammeSourceType = 'none' | 'camera' | 'screen' | 'uploaded-video' | 'direct-url';

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
  | 'stream-interrupted'
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
  audioSourceLabel: string;
  videoSourceLabel: string;
  audioTrackState: MediaStreamTrackState | 'none';
  videoTrackState: MediaStreamTrackState | 'none';
  videoWidth: number | null;
  videoHeight: number | null;
  frameRate: number | null;
  audioMissingReason: string | null;
  sourceEnded: boolean;
  captureInterrupted: boolean;
  browserLimitation: string | null;
  isObsVirtualCamera: boolean;
  isCaptureDeviceCandidate: boolean;
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
  createHlsController?: () => HlsController;
  isHlsSupported?: () => boolean;
  loadHlsRuntime?: () => Promise<HlsRuntime>;
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

interface HlsController {
  attachMedia(media: HTMLMediaElement): void;
  loadSource(url: string): void;
  destroy(): void;
  on(event: string, listener: (event: string, data: HlsErrorData) => void): void;
}

interface HlsRuntime {
  isSupported(): boolean;
  createController(): HlsController;
}

interface HlsErrorData {
  fatal?: boolean;
  details?: string;
  type?: string;
  error?: { message?: string };
  reason?: string;
}

const UPLOADED_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov']);
const UPLOADED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-quicktime',
]);
const DIRECT_STREAM_EXTENSIONS = new Set(['mp4', 'webm', 'm3u8']);
const NATIVE_HLS_MIME_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegURL'];
const HLS_ERROR_EVENT = 'hlsError';
const HLS_ERROR_DETAILS = {
  manifestParsing: 'manifestParsingError',
  manifestIncompatibleCodecs: 'manifestIncompatibleCodecsError',
  bufferAddCodec: 'bufferAddCodecError',
  bufferIncompatibleCodecs: 'bufferIncompatibleCodecsError',
  fragmentLoad: 'fragLoadError',
  fragmentLoadTimeout: 'fragLoadTimeOut',
  bufferStalled: 'bufferStalledError',
  manifestLoad: 'manifestLoadError',
  manifestLoadTimeout: 'manifestLoadTimeOut',
  levelLoad: 'levelLoadError',
} as const;
const HLS_ERROR_TYPES = {
  network: 'networkError',
} as const;

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
    audioSourceLabel: 'No audio source',
    videoSourceLabel: 'No video source',
    audioTrackState: 'none',
    videoTrackState: 'none',
    videoWidth: null,
    videoHeight: null,
    frameRate: null,
    audioMissingReason: null,
    sourceEnded: false,
    captureInterrupted: false,
    browserLimitation: null,
    isObsVirtualCamera: false,
    isCaptureDeviceCandidate: false,
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

export function validateDirectProgrammeUrl(rawUrl: string): {
  url: string;
  format: 'mp4' | 'webm' | 'hls';
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new ProgrammeSourceError(
      'unsupported-format',
      'Enter a direct HTTPS MP4, WebM, or HLS .m3u8 URL.',
      false,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ProgrammeSourceError(
      'unsupported-format',
      'Stream URLs must use HTTP or HTTPS.',
      false,
    );
  }
  const extension = parsed.pathname.split('.').pop()?.toLowerCase() ?? '';
  if (!DIRECT_STREAM_EXTENSIONS.has(extension)) {
    throw new ProgrammeSourceError(
      'unsupported-format',
      'Only direct MP4, WebM, and HLS .m3u8 URLs are supported. Platform pages are not direct media streams.',
      false,
    );
  }
  const format = extension === 'm3u8' ? 'hls' : extension === 'mp4' ? 'mp4' : 'webm';
  return {
    url: parsed.toString(),
    format,
  };
}

export class ProgrammeSourceManager {
  private readonly mediaDevices: MediaDevices | undefined;
  private readonly isSecureContext: boolean;
  private readonly createObjectUrl: (file: File) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly createHlsController: (() => HlsController) | undefined;
  private readonly isHlsSupported: (() => boolean) | undefined;
  private readonly loadHlsRuntime: () => Promise<HlsRuntime>;
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
  private hlsController: HlsController | null = null;
  private hlsFatalError: ProgrammeSourceError | null = null;
  private hlsRuntimePromise: Promise<HlsRuntime> | null = null;
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
    this.createHlsController = options.createHlsController;
    this.isHlsSupported = options.isHlsSupported;
    this.loadHlsRuntime = options.loadHlsRuntime ?? loadDefaultHlsRuntime;
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
    this.auditSelectedDeviceAvailability(devices);
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
      audioMissingReason: null,
      sourceEnded: false,
      captureInterrupted: false,
      browserLimitation: null,
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
      const videoLabel = this.resolveDeviceLabel('videoinput', input.videoDeviceId, 'Browser default camera');
      const audioLabel = this.resolveDeviceLabel('audioinput', input.audioDeviceId, 'Browser default audio');
      this.installStream('camera', formatCameraIdentity(videoLabel, audioLabel), stream, {
        audioSourceLabel: audioLabel,
        videoSourceLabel: videoLabel,
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
      audioMissingReason: null,
      sourceEnded: false,
      captureInterrupted: false,
      browserLimitation: null,
      error: null,
    });
    let stream: MediaStream | null = null;
    try {
      stream = await this.mediaDevices!.getDisplayMedia({ video: true, audio: true });
      this.assertUsableTracks(stream, { requireVideo: true });
      this.attachPreviewElement(previewElement ?? null, stream);
      this.installStream('screen', 'Screen or browser tab', stream, {
        audioSourceLabel: stream.getAudioTracks()[0]?.label || 'Screen audio',
        videoSourceLabel: stream.getVideoTracks()[0]?.label || 'Screen or browser tab',
        audioMissingReason:
          stream.getAudioTracks().length === 0
            ? 'Browser or platform did not provide screen-share audio.'
            : null,
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
      audioMissingReason: null,
      sourceEnded: false,
      captureInterrupted: false,
      browserLimitation: null,
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
      videoElement.addEventListener('ended', this.handleMediaElementEnded);
      videoElement.load?.();
      void videoElement.play?.().catch(() => undefined);
      await waitForMediaReady(videoElement);
      const stream = (videoElement.captureStream ?? videoElement.mozCaptureStream)!.call(videoElement);
      this.assertUsableTracks(stream, { requireVideo: false });
      this.installStream('uploaded-video', file.name, stream, {
        audioSourceLabel: stream.getAudioTracks()[0]?.label || 'Uploaded video audio',
        videoSourceLabel: stream.getVideoTracks()[0]?.label || file.name,
        audioMissingReason:
          stream.getAudioTracks().length === 0
            ? 'Uploaded video did not expose a browser-playable audio track.'
            : null,
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

  async selectDirectStreamUrl(rawUrl: string, videoElement: CaptureVideoElement): Promise<ProgrammeSourceSnapshot> {
    this.assertNoActiveSource();
    const direct = validateDirectProgrammeUrl(rawUrl);
    if (!videoElement.captureStream && !videoElement.mozCaptureStream) {
      throw this.fail(
        new ProgrammeSourceError(
          'capture-stream-unavailable',
          'This browser cannot publish stream URLs through captureStream().',
          false,
        ),
      );
    }
    const hlsMode =
      direct.format === 'hls'
        ? await this.resolveHlsPlaybackMode(videoElement)
        : 'not-hls';
    if (hlsMode === 'unsupported') {
      throw this.fail(
        new ProgrammeSourceError(
          'unsupported-format',
          'This browser cannot play HLS .m3u8 streams. Use Chrome or Firefox with MediaSource support, or use a direct MP4/WebM URL.',
          false,
        ),
      );
    }

    this.update({
      sourceType: 'direct-url',
      sourceIdentity: direct.url,
      status: 'selecting',
      durationMs: null,
      audioMissingReason: null,
      sourceEnded: false,
      captureInterrupted: false,
      browserLimitation:
        direct.format === 'hls'
          ? hlsMode === 'native'
            ? 'Using native browser HLS playback.'
            : 'Using hls.js fallback for browser HLS playback.'
          : 'Remote media must allow browser playback and WebRTC capture.',
      error: null,
    });

    this.videoElement = videoElement;
    try {
      videoElement.muted = true;
      videoElement.playsInline = true;
      videoElement.preload = 'metadata';
      videoElement.crossOrigin = 'anonymous';
      videoElement.addEventListener('ended', this.handleMediaElementEnded);
      if (direct.format === 'hls') {
        await this.attachHlsPlayback(direct.url, videoElement, hlsMode);
      } else {
        videoElement.src = direct.url;
        videoElement.load?.();
      }
      void videoElement.play?.().catch(() => undefined);
      await waitForMediaReady(videoElement, () => this.hlsFatalError);
      const stream = (videoElement.captureStream ?? videoElement.mozCaptureStream)!.call(videoElement);
      this.assertUsableTracks(stream, { requireVideo: true });
      const durationMs = Number.isFinite(videoElement.duration) ? Math.round(videoElement.duration * 1000) : null;
      this.installStream('direct-url', formatDirectSourceIdentity(direct.url), stream, {
        audioSourceLabel: stream.getAudioTracks()[0]?.label || 'Stream URL audio',
        videoSourceLabel: stream.getVideoTracks()[0]?.label || direct.url,
        audioMissingReason:
          stream.getAudioTracks().length === 0
            ? 'Stream URL did not expose a browser-playable audio track.'
            : null,
        durationMs,
        canPause: true,
        canResume: true,
        canSeek: durationMs !== null,
        canRestart: durationMs !== null,
        preservePreview: true,
        browserLimitation:
          direct.format === 'hls'
            ? hlsMode === 'native'
              ? 'Native HLS playback active.'
              : 'hls.js playback active.'
            : null,
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
    if (this.isMediaElementSource() && this.videoElement) {
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
    if (this.isMediaElementSource()) {
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
    if (this.isMediaElementSource() && this.videoElement) {
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
      audioSourceLabel: 'No audio source',
      videoSourceLabel: 'No video source',
      audioTrackState: 'none',
      videoTrackState: 'none',
      videoWidth: null,
      videoHeight: null,
      frameRate: null,
      audioMissingReason: null,
      sourceEnded: false,
      captureInterrupted: false,
      browserLimitation: null,
      isObsVirtualCamera: false,
      isCaptureDeviceCandidate: false,
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
      audioSourceLabel?: string;
      videoSourceLabel?: string;
      audioMissingReason?: string | null;
      browserLimitation?: string | null;
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
    const videoSettings = readVideoSettings(videoTrack);
    const audioSourceLabel = options.audioSourceLabel ?? audioTrack?.label ?? 'Programme audio';
    const videoSourceLabel = options.videoSourceLabel ?? videoTrack?.label ?? sourceIdentity;
    this.update({
      sourceType,
      sourceIdentity,
      status: 'preview-ready',
      audioDetected: Boolean(audioTrack),
      videoDetected: Boolean(videoTrack),
      audioTrackId: audioTrack?.id ?? null,
      videoTrackId: videoTrack?.id ?? null,
      audioSourceLabel,
      videoSourceLabel,
      audioTrackState: audioTrack?.readyState ?? 'none',
      videoTrackState: videoTrack?.readyState ?? 'none',
      videoWidth: videoSettings.width,
      videoHeight: videoSettings.height,
      frameRate: videoSettings.frameRate,
      audioMissingReason:
        options.audioMissingReason ??
        (audioTrack ? null : 'No programme audio track is available for transcription.'),
      sourceEnded: false,
      captureInterrupted: false,
      browserLimitation:
        options.browserLimitation ??
        (sourceType === 'screen' && !audioTrack
          ? 'Screen or tab audio depends on browser, operating system, and platform support.'
          : null),
      isObsVirtualCamera: isObsLikeDevice(videoSourceLabel),
      isCaptureDeviceCandidate: isCaptureDeviceLike(videoSourceLabel) || isCaptureDeviceLike(audioSourceLabel),
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
    if (this.isMediaElementSource() && this.videoElement) {
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
    const audioTrack = this.stream?.getAudioTracks()[0] ?? null;
    const videoTrack = this.stream?.getVideoTracks()[0] ?? null;
    const videoSettings = readVideoSettings(videoTrack);
    this.update({
      status: 'ended',
      broadcasting: false,
      paused: false,
      audioDetected: Boolean(audioTrack && audioTrack.readyState !== 'ended'),
      videoDetected: Boolean(videoTrack && videoTrack.readyState !== 'ended'),
      audioTrackState: audioTrack?.readyState ?? 'none',
      videoTrackState: videoTrack?.readyState ?? 'none',
      videoWidth: videoSettings.width,
      videoHeight: videoSettings.height,
      frameRate: videoSettings.frameRate,
      sourceEnded: true,
      captureInterrupted: true,
      error: errorDetails(new ProgrammeSourceError('source-ended', 'Programme source track ended.')),
    });
    this.incrementRevision('programme source track ended');
    this.onTrackEnded?.(this.snapshot);
  };

  private handleMediaElementEnded = (): void => {
    if (!this.isMediaElementSource()) return;
    if (this.snapshot.status === 'ended' || this.snapshot.status === 'stopped') return;
    this.enableTracks(false);
    this.update({
      status: 'ended',
      broadcasting: false,
      paused: false,
      programmeTimestampMs: this.readProgrammeTimestampMs(),
      sourceEnded: true,
      captureInterrupted: false,
      error: null,
    });
    this.incrementRevision(`${this.snapshot.sourceType} ended`);
    this.onTrackEnded?.(this.snapshot);
  };

  private releaseResources(options: { preserveObjectUrl?: boolean; preservePreview?: boolean } = {}): void {
    for (const track of this.ownedTracks) {
      track.removeEventListener?.('ended', this.handleTrackEnded);
    }
    this.ownedTracks.clear();
    if (this.stream) this.stopStream(this.stream);
    this.stream = null;
    if (this.hlsController) {
      this.hlsController.destroy();
      this.hlsController = null;
      this.hlsFatalError = null;
    }
    if (this.videoElement && !options.preservePreview) {
      this.videoElement.removeEventListener('ended', this.handleMediaElementEnded);
      this.videoElement.pause();
      this.videoElement.srcObject = null;
      this.videoElement.crossOrigin = '';
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

  private async resolveHlsPlaybackMode(videoElement: HTMLVideoElement): Promise<'native' | 'hls-js' | 'unsupported' | 'not-hls'> {
    if (NATIVE_HLS_MIME_TYPES.some((mimeType) => videoElement.canPlayType?.(mimeType))) {
      return 'native';
    }
    if (this.isHlsSupported) {
      return this.isHlsSupported() ? 'hls-js' : 'unsupported';
    }
    const runtime = await this.getHlsRuntime();
    return runtime.isSupported() ? 'hls-js' : 'unsupported';
  }

  private async attachHlsPlayback(
    url: string,
    videoElement: HTMLVideoElement,
    hlsMode: 'native' | 'hls-js' | 'unsupported' | 'not-hls',
  ): Promise<void> {
    if (hlsMode === 'native') {
      videoElement.src = url;
      videoElement.load?.();
      return;
    }
    if (hlsMode !== 'hls-js') {
      throw new ProgrammeSourceError('unsupported-format', 'This browser cannot play HLS .m3u8 streams.', false);
    }
    this.hlsFatalError = null;
    const controller = await this.createFallbackHlsController();
    this.hlsController = controller;
    controller.on(HLS_ERROR_EVENT, (_event, data) => {
      if (data.fatal) {
        this.handleHlsFatalError(data);
      }
    });
    controller.attachMedia(videoElement);
    controller.loadSource(url);
  }

  private async getHlsRuntime(): Promise<HlsRuntime> {
    this.hlsRuntimePromise ??= this.loadHlsRuntime();
    return this.hlsRuntimePromise;
  }

  private async createFallbackHlsController(): Promise<HlsController> {
    if (this.createHlsController) return this.createHlsController();
    const runtime = await this.getHlsRuntime();
    return runtime.createController();
  }

  private handleHlsFatalError(data: HlsErrorData): void {
    const error = mapHlsError(data);
    this.hlsFatalError = error;
    if (
      this.snapshot.sourceType === 'direct-url' &&
      this.snapshot.status !== 'selecting' &&
      this.snapshot.status !== 'failed' &&
      this.snapshot.status !== 'stopped'
    ) {
      this.enableTracks(false);
      this.fail(error);
    }
  }

  private fail(error: ProgrammeSourceError): ProgrammeSourceError {
    const details = errorDetails(error);
    this.update({
      status: 'failed',
      broadcasting: false,
      paused: false,
      previewReady: false,
      captureInterrupted: true,
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

  private auditSelectedDeviceAvailability(devices: ProgrammeSourceDevice[]): void {
    if (this.snapshot.sourceType !== 'camera') return;
    if (this.snapshot.status === 'idle' || this.snapshot.status === 'stopped' || this.snapshot.status === 'failed') return;
    const missingVideo =
      this.snapshot.selectedVideoDeviceId &&
      !devices.some((device) => device.kind === 'videoinput' && device.deviceId === this.snapshot.selectedVideoDeviceId);
    const missingAudio =
      this.snapshot.selectedAudioDeviceId &&
      !devices.some((device) => device.kind === 'audioinput' && device.deviceId === this.snapshot.selectedAudioDeviceId);
    if (!missingVideo && !missingAudio) return;
    this.update({
      status: 'ended',
      broadcasting: false,
      paused: false,
      sourceEnded: true,
      captureInterrupted: true,
      error: errorDetails(
        new ProgrammeSourceError(
          'device-unavailable',
          `${missingVideo ? 'Selected video device' : 'Selected audio device'} disappeared. Reconnect it and select the source again.`,
        ),
      ),
    });
    this.incrementRevision('programme source device disappeared');
    this.onTrackEnded?.(this.snapshot);
  }

  private resolveDeviceLabel(
    kind: ProgrammeSourceDevice['kind'],
    deviceId: string | undefined,
    fallback: string,
  ): string {
    if (!deviceId) return fallback;
    return this.snapshot.availableDevices.find((device) => device.kind === kind && device.deviceId === deviceId)?.label ?? fallback;
  }

  private isMediaElementSource(): boolean {
    return this.snapshot.sourceType === 'uploaded-video' || this.snapshot.sourceType === 'direct-url';
  }
}

function waitForMediaReady(
  video: HTMLVideoElement,
  getFatalPlaybackError: () => ProgrammeSourceError | null = () => null,
): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = globalThis.setInterval(() => {
      const fatalPlaybackError = getFatalPlaybackError();
      if (fatalPlaybackError) {
        cleanup();
        reject(fatalPlaybackError);
        return;
      }
      if (video.readyState >= 1) {
        cleanup();
        resolve();
        return;
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
      globalThis.clearInterval(poll);
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
      reject(mediaElementError(video));
    };
    video.addEventListener('loadedmetadata', onReady, { once: true });
    video.addEventListener('canplay', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

function mediaElementError(video: HTMLVideoElement): ProgrammeSourceError {
  switch (video.error?.code) {
    case MediaError.MEDIA_ERR_NETWORK:
      return new ProgrammeSourceError(
        'decode-failed',
        'The stream URL is unreachable or blocked by CORS.',
      );
    case MediaError.MEDIA_ERR_DECODE:
      return new ProgrammeSourceError(
        'decode-failed',
        'The browser could not decode the stream. Check codec compatibility or media integrity.',
      );
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return new ProgrammeSourceError(
        'unsupported-format',
        'The stream uses an unsupported codec or invalid media container.',
        false,
      );
    default:
      return new ProgrammeSourceError('decode-failed', 'The browser could not decode the selected video.');
  }
}

function mapHlsError(data: HlsErrorData): ProgrammeSourceError {
  const details = String(data.details ?? '');
  const type = String(data.type ?? '');
  const message = [
    data.error?.message,
    data.reason,
    details,
    type,
  ].filter(Boolean).join(' ');
  if (/cors|cross.?origin|access-control/i.test(message)) {
    return new ProgrammeSourceError('decode-failed', 'HLS stream is blocked by CORS.');
  }
  if (
    data.details === HLS_ERROR_DETAILS.manifestParsing ||
    /manifest.*parsing|invalid.*manifest/i.test(message)
  ) {
    return new ProgrammeSourceError('decode-failed', 'Invalid HLS manifest.');
  }
  if (
    data.details === HLS_ERROR_DETAILS.manifestIncompatibleCodecs ||
    data.details === HLS_ERROR_DETAILS.bufferAddCodec ||
    data.details === HLS_ERROR_DETAILS.bufferIncompatibleCodecs ||
    /codec|not supported|unsupported/i.test(message)
  ) {
    return new ProgrammeSourceError('unsupported-format', 'HLS stream uses an unsupported codec.', false);
  }
  if (
    data.details === HLS_ERROR_DETAILS.fragmentLoad ||
    data.details === HLS_ERROR_DETAILS.fragmentLoadTimeout ||
    data.details === HLS_ERROR_DETAILS.bufferStalled
  ) {
    return new ProgrammeSourceError('stream-interrupted', 'HLS stream playback was interrupted.');
  }
  if (
    data.type === HLS_ERROR_TYPES.network ||
    data.details === HLS_ERROR_DETAILS.manifestLoad ||
    data.details === HLS_ERROR_DETAILS.manifestLoadTimeout ||
    data.details === HLS_ERROR_DETAILS.levelLoad
  ) {
    return new ProgrammeSourceError('decode-failed', 'HLS stream is unreachable or interrupted.');
  }
  return new ProgrammeSourceError('decode-failed', 'HLS playback failed.');
}

async function loadDefaultHlsRuntime(): Promise<HlsRuntime> {
  const module = await import('hls.js/light');
  const HlsClass = module.default;
  return {
    isSupported: () => HlsClass.isSupported(),
    createController: () => new HlsClass({ enableWorker: true }) as HlsController,
  };
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

function formatDirectSourceIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function readVideoSettings(track: MediaStreamTrack | null): {
  width: number | null;
  height: number | null;
  frameRate: number | null;
} {
  const settings = track?.getSettings?.();
  return {
    width: typeof settings?.width === 'number' ? settings.width : null,
    height: typeof settings?.height === 'number' ? settings.height : null,
    frameRate: typeof settings?.frameRate === 'number' ? settings.frameRate : null,
  };
}

function formatCameraIdentity(videoLabel: string, audioLabel: string): string {
  return `${videoLabel} + ${audioLabel}`;
}

function isObsLikeDevice(label: string): boolean {
  return /\bobs\b|virtual camera/i.test(label);
}

function isCaptureDeviceLike(label: string): boolean {
  return /capture|cam link|decklink|ultra ?studio|aja|magewell|elgato|blackmagic|atem|ndi|virtual cable|vb-audio/i.test(label);
}
