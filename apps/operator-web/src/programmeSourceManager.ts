export type ProgrammeSourceType = 'none' | 'camera' | 'screen' | 'uploaded-video' | 'direct-url' | 'rtmp';

export type RtmpProgrammeState =
  | 'idle'
  | 'waiting-for-stream'
  | 'live'
  | 'interrupted'
  | 'recovered'
  | 'ended';

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
  rtmpState: RtmpProgrammeState;
  rtmpPublishUrl: string | null;
  rtmpStreamPath: string | null;
  rtmpPlaybackUrl: string | null;
  error: ProgrammeSourceErrorDetails | null;
  updatedAt: string;
}

export interface RtmpProgrammeSourceInput {
  publishUrl: string;
  streamKey: string;
  hlsBaseUrl?: string;
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
const SAFE_RTMP_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCAL_RTMP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
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
    rtmpState: 'idle',
    rtmpPublishUrl: null,
    rtmpStreamPath: null,
    rtmpPlaybackUrl: null,
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

export function deriveRtmpHlsPlaybackUrl(input: RtmpProgrammeSourceInput): {
  publishUrl: string;
  streamKeyRedacted: string;
  streamPath: string;
  hlsPlaybackUrl: string;
} {
  const publishUrl = parseRtmpPublishUrl(input.publishUrl);
  const streamKey = input.streamKey.trim();
  if (!SAFE_RTMP_SEGMENT.test(streamKey)) {
    throw new ProgrammeSourceError(
      'unsupported-format',
      'Stream key must use only letters, numbers, dots, dashes, or underscores and cannot include slashes.',
      false,
    );
  }
  const pathSegments = publishUrl.pathname
    .split('/')
    .filter(Boolean)
    .map(validateRtmpPathSegment);
  const streamPath = [...pathSegments, streamKey].join('/');
  const hlsBase = parseRtmpHlsBaseUrl(input.hlsBaseUrl ?? 'http://localhost:8888');
  hlsBase.pathname = joinUrlPath(hlsBase.pathname, ...pathSegments, streamKey, 'index.m3u8');
  hlsBase.search = '';
  hlsBase.hash = '';
  return {
    publishUrl: publishUrl.toString(),
    streamKeyRedacted: redactStreamKey(streamKey),
    streamPath,
    hlsPlaybackUrl: hlsBase.toString(),
  };
}

function parseRtmpPublishUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new ProgrammeSourceError(
      'unsupported-format',
      'Enter a local RTMP publish URL such as rtmp://localhost:1935/live.',
      false,
    );
  }
  if (parsed.protocol !== 'rtmp:' && parsed.protocol !== 'rtmps:') {
    throw new ProgrammeSourceError('unsupported-format', 'RTMP publish URLs must use rtmp:// or rtmps://.', false);
  }
  if (!LOCAL_RTMP_HOSTS.has(parsed.hostname)) {
    throw new ProgrammeSourceError(
      'unsupported-format',
      'Only local RTMP gateway hosts are supported for this demo configuration.',
      false,
    );
  }
  return parsed;
}

function parseRtmpHlsBaseUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new ProgrammeSourceError(
      'unsupported-format',
      'Enter a local MediaMTX HLS base URL such as http://localhost:8888.',
      false,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProgrammeSourceError('unsupported-format', 'MediaMTX HLS playback must use HTTP or HTTPS.', false);
  }
  if (!LOCAL_RTMP_HOSTS.has(parsed.hostname)) {
    throw new ProgrammeSourceError(
      'unsupported-format',
      'Only local MediaMTX HLS hosts are supported for this demo configuration.',
      false,
    );
  }
  return parsed;
}

function validateRtmpPathSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new ProgrammeSourceError('unsupported-format', 'RTMP publish path contains invalid encoding.', false);
  }
  if (!SAFE_RTMP_SEGMENT.test(decoded)) {
    throw new ProgrammeSourceError(
      'unsupported-format',
      'RTMP publish path must use only safe path segments.',
      false,
    );
  }
  return decoded;
}

function joinUrlPath(basePath: string, ...segments: string[]): string {
  const baseSegments = basePath.split('/').filter(Boolean).map(validateRtmpPathSegment);
  const encoded = [...baseSegments, ...segments].map((segment) => encodeURIComponent(segment));
  return `/${encoded.join('/')}`;
}

function redactStreamKey(streamKey: string): string {
  if (streamKey.length <= 4) return '****';
  return `${streamKey.slice(0, 2)}...${streamKey.slice(-2)}`;
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
  private mediaElementAudioContext: AudioContext | null = null;
  private mediaElementAudioSource: MediaElementAudioSourceNode | null = null;
  private mediaElementAudioDestination: MediaStreamAudioDestinationNode | null = null;
  private mediaElementVideoCanvas: HTMLCanvasElement | null = null;
  private mediaElementVideoCanvasStream: MediaStream | null = null;
  private mediaElementVideoAnimationFrame: number | null = null;
  private lastInterruptedRtmpStreamPath: string | null = null;
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
      await waitForMediaReady(videoElement);
      videoElement.pause();
      videoElement.currentTime = 0;
      const stream = (videoElement.captureStream ?? videoElement.mozCaptureStream)!.call(videoElement);
      this.assertUsableTracks(stream, { requireVideo: true });
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
      if (direct.format === 'hls') {
        void videoElement.play?.().catch(() => undefined);
      }
      await waitForMediaReady(videoElement, () => this.hlsFatalError);
      if (direct.format !== 'hls') {
        videoElement.pause();
        videoElement.currentTime = 0;
      }
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

  async selectRtmpProgrammeSource(
    input: RtmpProgrammeSourceInput,
    videoElement: CaptureVideoElement,
  ): Promise<ProgrammeSourceSnapshot> {
    this.assertNoActiveSource();
    const rtmp = deriveRtmpHlsPlaybackUrl(input);
    const direct = validateDirectProgrammeUrl(rtmp.hlsPlaybackUrl);
    if (!videoElement.captureStream && !videoElement.mozCaptureStream) {
      throw this.fail(
        new ProgrammeSourceError(
          'capture-stream-unavailable',
          'This browser cannot publish RTMP gateway playback through captureStream().',
          false,
        ),
      );
    }
    const hlsMode = await this.resolveHlsPlaybackMode(videoElement);
    if (hlsMode === 'unsupported') {
      throw this.fail(
        new ProgrammeSourceError(
          'unsupported-format',
          'This browser cannot play the MediaMTX HLS output. Use Chrome or Firefox with MediaSource support.',
          false,
        ),
      );
    }

    this.update({
      sourceType: 'rtmp',
      sourceIdentity: `RTMP ${rtmp.streamPath}`,
      status: 'selecting',
      durationMs: null,
      audioMissingReason: null,
      sourceEnded: false,
      captureInterrupted: false,
      browserLimitation:
        hlsMode === 'native'
          ? 'Using native browser HLS playback from MediaMTX.'
          : 'Using hls.js fallback for MediaMTX HLS playback.',
      rtmpState: 'waiting-for-stream',
      rtmpPublishUrl: rtmp.publishUrl,
      rtmpStreamPath: rtmp.streamPath,
      rtmpPlaybackUrl: rtmp.hlsPlaybackUrl,
      error: null,
    });

    this.videoElement = videoElement;
    try {
      videoElement.muted = true;
      videoElement.playsInline = true;
      videoElement.preload = 'metadata';
      videoElement.crossOrigin = 'anonymous';
      videoElement.addEventListener('ended', this.handleMediaElementEnded);
      await this.attachHlsPlayback(direct.url, videoElement, hlsMode);
      void videoElement.play?.().catch(() => undefined);
      await waitForMediaReady(videoElement, () => this.hlsFatalError);
      const capturedStream = (videoElement.captureStream ?? videoElement.mozCaptureStream)!.call(videoElement);
      const stream =
        capturedStream.getAudioTracks().some((track) => track.readyState !== 'ended')
          ? capturedStream
          : (await this.combineWithMediaElementAudioTrack(videoElement, capturedStream)) ?? capturedStream;
      await waitForCapturedTracks(stream, {
        requireAudio: true,
        requireVideo: true,
        missingAudioMessage: 'RTMP gateway stream did not expose browser-playable audio.',
        missingVideoMessage: 'RTMP gateway stream did not expose browser-playable video.',
        getFatalPlaybackError: () => this.hlsFatalError,
      });
      this.assertUsableTracks(stream, { requireVideo: true });
      this.installStream('rtmp', `MediaMTX ${rtmp.streamPath}`, stream, {
        audioSourceLabel: stream.getAudioTracks()[0]?.label || 'RTMP programme audio',
        videoSourceLabel: stream.getVideoTracks()[0]?.label || `RTMP ${rtmp.streamPath}`,
        audioMissingReason:
          stream.getAudioTracks().length === 0
            ? 'RTMP gateway stream did not expose browser-playable audio.'
            : null,
        canPause: true,
        canResume: true,
        preservePreview: true,
        browserLimitation:
          hlsMode === 'native'
            ? 'Native HLS playback active for RTMP gateway.'
            : 'hls.js playback active for RTMP gateway.',
        rtmpState:
          this.lastInterruptedRtmpStreamPath === rtmp.streamPath
            ? 'recovered'
            : 'live',
        rtmpPublishUrl: rtmp.publishUrl,
        rtmpStreamPath: rtmp.streamPath,
        rtmpPlaybackUrl: rtmp.hlsPlaybackUrl,
      });
      if (this.snapshot.rtmpState === 'recovered') {
        this.lastInterruptedRtmpStreamPath = null;
      }
      this.update({ programmeTimestampMs: Math.round((videoElement.currentTime || 0) * 1000) });
      return this.snapshot;
    } catch (error) {
      this.lastInterruptedRtmpStreamPath = rtmp.streamPath;
      this.releaseResources();
      const normalized = normalizeProgrammeSourceError(error, 'decode-failed');
      throw this.fail(
        normalized.code === 'decode-failed' && /Timed out waiting/.test(normalized.message)
          ? new ProgrammeSourceError(
              'decode-failed',
              'Waiting for the RTMP stream. Confirm OBS is publishing to MediaMTX and try again.',
            )
          : normalized,
      );
    }
  }

  async start(options: { captureForTransport?: boolean } = {}): Promise<ProgrammeSourceSnapshot> {
    if (!this.stream || this.snapshot.status !== 'preview-ready') {
      throw this.fail(new ProgrammeSourceError('missing-media-track', 'Select a programme source before starting.'));
    }
    if (this.isMediaElementSource() && this.videoElement) {
      this.videoElement.muted = options.captureForTransport === false;
      this.videoElement.volume = 1;
      if (options.captureForTransport !== false) {
        await this.mediaElementAudioContext?.resume?.().catch(() => undefined);
      }
      await requestMediaElementPlayback(this.videoElement, (error) => this.fail(error));
      if (options.captureForTransport !== false) {
        await this.replaceMediaElementAudioForTransport();
      }
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

  async prepareForInterpretationStart(
    options: { captureForTransport?: boolean } = {},
  ): Promise<ProgrammeSourceSnapshot> {
    if (!this.stream || this.snapshot.status !== 'preview-ready') {
      throw this.fail(new ProgrammeSourceError('missing-media-track', 'Select a programme source before starting.'));
    }
    if (this.isMediaElementSource() && this.videoElement && this.snapshot.canRestart) {
      this.videoElement.pause();
      if (Math.abs((this.videoElement.currentTime || 0)) > 0.05) {
        await seekMediaElement(this.videoElement, 0);
        this.incrementRevision('programme media start rewind');
      } else {
        this.videoElement.currentTime = 0;
      }
      this.update({
        programmeTimestampMs: 0,
        sourceEnded: false,
        captureInterrupted: false,
        error: null,
      });
    }
    if (this.isMediaElementSource() && options.captureForTransport !== false) {
      await this.replaceMediaElementAudioForTransport();
    }
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
      await requestMediaElementPlayback(this.videoElement, (error) => this.fail(error));
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
    await seekMediaElement(this.videoElement, Math.max(0, ms / 1000));
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
      rtmpState: 'idle',
      rtmpPublishUrl: null,
      rtmpStreamPath: null,
      rtmpPlaybackUrl: null,
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
      rtmpState?: RtmpProgrammeState;
      rtmpPublishUrl?: string | null;
      rtmpStreamPath?: string | null;
      rtmpPlaybackUrl?: string | null;
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
      rtmpState: options.rtmpState ?? (sourceType === 'rtmp' ? 'live' : 'idle'),
      rtmpPublishUrl: options.rtmpPublishUrl ?? null,
      rtmpStreamPath: options.rtmpStreamPath ?? null,
      rtmpPlaybackUrl: options.rtmpPlaybackUrl ?? null,
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
      rtmpState: this.snapshot.sourceType === 'rtmp' ? 'interrupted' : this.snapshot.rtmpState,
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
      rtmpState: this.snapshot.sourceType === 'rtmp' ? 'ended' : this.snapshot.rtmpState,
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
    this.releaseMediaElementAudioCapture();
    this.releaseMediaElementVideoCanvasCapture();
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

  private captureMediaElementStream(videoElement: HTMLVideoElement): MediaStream | null {
    const capture = (videoElement as CaptureVideoElement).captureStream ?? (videoElement as CaptureVideoElement).mozCaptureStream;
    if (!capture) return null;
    return capture.call(videoElement as CaptureVideoElement);
  }

  private captureMediaElementCanvasStream(videoElement: HTMLVideoElement): MediaStream | null {
    if (
      typeof document === 'undefined' ||
      typeof requestAnimationFrame === 'undefined' ||
      typeof cancelAnimationFrame === 'undefined'
    ) {
      return null;
    }
    this.releaseMediaElementVideoCanvasCapture();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(videoElement.videoWidth || 1280));
    canvas.height = Math.max(2, Math.round(videoElement.videoHeight || 720));
    const context = canvas.getContext('2d');
    if (!context || !canvas.captureStream) return null;
    const draw = (): void => {
      if (this.mediaElementVideoCanvas !== canvas) return;
      const width = Math.max(2, Math.round(videoElement.videoWidth || canvas.width));
      const height = Math.max(2, Math.round(videoElement.videoHeight || canvas.height));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      if (videoElement.readyState >= 2) {
        context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      }
      this.mediaElementVideoAnimationFrame = requestAnimationFrame(draw);
    };
    const stream = canvas.captureStream(30);
    this.mediaElementVideoCanvas = canvas;
    this.mediaElementVideoCanvasStream = stream;
    draw();
    return stream;
  }

  private async combineWithMediaElementAudioTrack(
    videoElement: HTMLVideoElement,
    previousStream: MediaStream,
  ): Promise<MediaStream | null> {
    const AudioContextConstructor =
      globalThis.AudioContext ??
      (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return null;
    try {
      this.releaseMediaElementAudioCapture();
      videoElement.muted = false;
      videoElement.volume = 1;
      const audioContext = new AudioContextConstructor();
      const source = audioContext.createMediaElementSource(videoElement);
      const destination = audioContext.createMediaStreamDestination();
      source.connect(destination);
      await audioContext.resume?.().catch(() => undefined);
      const audioTracks = destination.stream.getAudioTracks().filter((track) => track.readyState !== 'ended');
      if (audioTracks.length === 0) {
        source.disconnect();
        void audioContext.close?.().catch(() => undefined);
        return null;
      }
      const capturedStream =
        this.captureMediaElementCanvasStream(videoElement) ??
        this.captureMediaElementStream(videoElement) ??
        previousStream;
      const videoTracks = capturedStream.getVideoTracks().filter((track) => track.readyState !== 'ended');
      if (videoTracks.length === 0) {
        source.disconnect();
        void audioContext.close?.().catch(() => undefined);
        return null;
      }
      this.mediaElementAudioContext = audioContext;
      this.mediaElementAudioSource = source;
      this.mediaElementAudioDestination = destination;
      for (const capturedAudioTrack of capturedStream.getAudioTracks()) {
        if (capturedAudioTrack.readyState !== 'ended') capturedAudioTrack.stop();
      }
      return new MediaStream([...videoTracks, ...audioTracks]);
    } catch {
      this.releaseMediaElementAudioCapture();
      return null;
    }
  }

  private async replaceMediaElementAudioForTransport(): Promise<void> {
    if (!this.videoElement || !this.stream) return;
    if (this.mediaElementAudioDestination) return;
    const previousStream = this.stream;
    const replacement = await this.combineWithMediaElementAudioTrack(this.videoElement, this.stream);
    if (!replacement) return;

    for (const track of this.ownedTracks) {
      track.removeEventListener?.('ended', this.handleTrackEnded);
    }
    this.ownedTracks.clear();
    this.stream = replacement;
    const replacementTracks = new Set(replacement.getTracks());
    for (const track of previousStream.getTracks()) {
      if (!replacementTracks.has(track) && track.readyState !== 'ended') track.stop();
    }
    for (const track of replacement.getTracks()) {
      track.addEventListener?.('ended', this.handleTrackEnded);
      this.ownedTracks.add(track);
    }

    const audioTrack = replacement.getAudioTracks()[0] ?? null;
    const videoTrack = replacement.getVideoTracks()[0] ?? null;
    const videoSettings = readVideoSettings(videoTrack);
    this.update({
      audioDetected: Boolean(audioTrack),
      videoDetected: Boolean(videoTrack),
      audioTrackId: audioTrack?.id ?? null,
      videoTrackId: videoTrack?.id ?? null,
      audioSourceLabel: audioTrack?.label || this.snapshot.audioSourceLabel,
      videoSourceLabel: videoTrack?.label || this.snapshot.videoSourceLabel,
      audioTrackState: audioTrack?.readyState ?? 'none',
      videoTrackState: videoTrack?.readyState ?? 'none',
      videoWidth: videoSettings.width,
      videoHeight: videoSettings.height,
      frameRate: videoSettings.frameRate,
      audioMissingReason: audioTrack ? null : this.snapshot.audioMissingReason,
      error: null,
    });
  }

  private releaseMediaElementAudioCapture(): void {
    this.mediaElementAudioSource?.disconnect();
    this.mediaElementAudioDestination?.disconnect();
    void this.mediaElementAudioContext?.close?.().catch(() => undefined);
    this.mediaElementAudioSource = null;
    this.mediaElementAudioDestination = null;
    this.mediaElementAudioContext = null;
  }

  private releaseMediaElementVideoCanvasCapture(): void {
    if (this.mediaElementVideoAnimationFrame !== null) {
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(this.mediaElementVideoAnimationFrame);
      }
      this.mediaElementVideoAnimationFrame = null;
    }
    if (this.mediaElementVideoCanvasStream) {
      this.stopStream(this.mediaElementVideoCanvasStream);
      this.mediaElementVideoCanvasStream = null;
    }
    this.mediaElementVideoCanvas = null;
  }

  private async resolveHlsPlaybackMode(videoElement: HTMLVideoElement): Promise<'native' | 'hls-js' | 'unsupported' | 'not-hls'> {
    if (
      supportsNativeHls(videoElement) &&
      isReliableNativeHlsBrowser()
    ) {
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
      (this.snapshot.sourceType === 'direct-url' || this.snapshot.sourceType === 'rtmp') &&
      this.snapshot.status !== 'selecting' &&
      this.snapshot.status !== 'failed' &&
      this.snapshot.status !== 'stopped'
    ) {
      if (this.snapshot.sourceType === 'rtmp') {
        this.lastInterruptedRtmpStreamPath = this.snapshot.rtmpStreamPath;
        this.update({ rtmpState: 'interrupted' });
      }
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
      rtmpState: this.snapshot.sourceType === 'rtmp' ? 'interrupted' : this.snapshot.rtmpState,
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
    return (
      this.snapshot.sourceType === 'uploaded-video' ||
      this.snapshot.sourceType === 'direct-url' ||
      this.snapshot.sourceType === 'rtmp'
    );
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

function waitForCapturedTracks(
  stream: MediaStream,
  options: {
    requireAudio: boolean;
    requireVideo: boolean;
    missingAudioMessage: string;
    missingVideoMessage: string;
    getFatalPlaybackError?: () => ProgrammeSourceError | null;
    timeoutMs?: number;
  },
): Promise<void> {
  const hasRequiredTracks = (): boolean =>
    (!options.requireAudio || stream.getAudioTracks().some((track) => track.readyState !== 'ended')) &&
    (!options.requireVideo || stream.getVideoTracks().some((track) => track.readyState !== 'ended'));

  if (hasRequiredTracks()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 10_000;
    const poll = globalThis.setInterval(() => {
      const fatalPlaybackError = options.getFatalPlaybackError?.();
      if (fatalPlaybackError) {
        cleanup();
        reject(fatalPlaybackError);
        return;
      }
      if (hasRequiredTracks()) {
        cleanup();
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        cleanup();
        reject(
          new ProgrammeSourceError(
            'missing-media-track',
            options.requireAudio && stream.getAudioTracks().length === 0
              ? options.missingAudioMessage
              : options.missingVideoMessage,
            false,
          ),
        );
      }
    }, 100);

    const cleanup = (): void => {
      globalThis.clearInterval(poll);
      stream.removeEventListener?.('addtrack', onTrackChanged);
      stream.removeEventListener?.('removetrack', onTrackChanged);
    };
    const onTrackChanged = (): void => {
      if (hasRequiredTracks()) {
        cleanup();
        resolve();
      }
    };
    stream.addEventListener?.('addtrack', onTrackChanged);
    stream.addEventListener?.('removetrack', onTrackChanged);
  });
}

function seekMediaElement(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
  const clamped = Math.max(0, timeSeconds);
  if (Math.abs((video.currentTime || 0) - clamped) <= 0.05) {
    video.currentTime = clamped;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(mediaElementError(video));
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = clamped;
  });
}

function requestMediaElementPlayback(
  video: HTMLVideoElement,
  onFailure: (error: ProgrammeSourceError) => void,
): Promise<void> {
  return video.play().catch((error: unknown) => {
    if (isInterruptedPlaybackRequest(error)) return;
    const normalized = normalizeProgrammeSourceError(error, 'decode-failed');
    onFailure(normalized);
    throw normalized;
  });
}

function isInterruptedPlaybackRequest(error: unknown): boolean {
  const name = typeof DOMException !== 'undefined' && error instanceof DOMException ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'AbortError' || /interrupted by a call to pause|play request was interrupted/i.test(message);
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

function supportsNativeHls(videoElement: HTMLVideoElement): boolean {
  return NATIVE_HLS_MIME_TYPES.some((mimeType) => Boolean(videoElement.canPlayType?.(mimeType)));
}

function isReliableNativeHlsBrowser(): boolean {
  const userAgent = globalThis.navigator?.userAgent ?? '';
  const vendor = globalThis.navigator?.vendor ?? '';
  const isAppleWebKit = /Safari/i.test(userAgent) && /Apple/i.test(vendor);
  const isChromium = /Chrome|Chromium|CriOS|Edg|OPR/i.test(userAgent);
  const isFirefox = /Firefox|FxiOS/i.test(userAgent);
  return isAppleWebKit && !isChromium && !isFirefox;
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
