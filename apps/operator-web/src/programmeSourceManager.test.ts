import { describe, expect, it, vi } from 'vitest';
import {
  ProgrammeSourceManager,
  createInitialProgrammeSourceSnapshot,
  deriveRtmpHlsPlaybackUrl,
  isUploadedProgrammeVideoSupported,
  validateDirectProgrammeUrl,
} from './programmeSourceManager';

function track(
  kind: 'audio' | 'video',
  id: string = kind,
  options: { label?: string; settings?: MediaTrackSettings } = {},
) {
  const listeners = new Set<() => void>();
  return {
    id,
    kind,
    label: options.label ?? id,
    enabled: true,
    readyState: 'live',
    getSettings: vi.fn(() => options.settings ?? {}),
    stop: vi.fn(function stop(this: { readyState: string }) {
      this.readyState = 'ended';
    }),
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'ended') listeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'ended') listeners.delete(listener);
    }),
    emitEnded: function emitEnded(this: { readyState: string }) {
      this.readyState = 'ended';
      listeners.forEach((listener) => listener());
    },
  } as unknown as MediaStreamTrack & { emitEnded: () => void };
}

function stream(tracks: MediaStreamTrack[]) {
  return {
    getTracks: vi.fn(() => tracks),
    getAudioTracks: vi.fn(() => tracks.filter((item) => item.kind === 'audio')),
    getVideoTracks: vi.fn(() => tracks.filter((item) => item.kind === 'video')),
  } as unknown as MediaStream;
}

function mediaDevices(input: {
  user?: MediaStream;
  display?: MediaStream;
  rejectUser?: unknown;
  rejectDisplay?: unknown;
  devices?: MediaDeviceInfo[];
} = {}) {
  return {
    getUserMedia: vi.fn(async () => {
      if (input.rejectUser) throw input.rejectUser;
      return input.user ?? stream([track('audio'), track('video')]);
    }),
    getDisplayMedia: vi.fn(async () => {
      if (input.rejectDisplay) throw input.rejectDisplay;
      return input.display ?? stream([track('video')]);
    }),
    enumerateDevices: vi.fn(async () =>
      input.devices ?? [
        { kind: 'videoinput', deviceId: 'camera_1', label: 'Camera 1' },
        { kind: 'videoinput', deviceId: 'obs_1', label: 'OBS Virtual Camera' },
        { kind: 'audioinput', deviceId: 'mic_1', label: 'Mic 1' },
        { kind: 'audioinput', deviceId: 'vac_1', label: 'VB-Audio Virtual Cable' },
      ],
    ),
  } as unknown as MediaDevices;
}

function videoElement(
  captured: MediaStream,
  options: { readyState?: number; duration?: number } = {},
) {
  const listeners = new Map<string, Set<() => void>>();
  let currentTime = 0;
  const emit = (event: string): void => {
    listeners.get(event)?.forEach((listener) => listener());
  };
  return {
    readyState: options.readyState ?? 1,
    duration: options.duration ?? 12.4,
    networkState: 1,
    error: null,
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      queueMicrotask(() => emit('seeked'));
    },
    paused: true,
    muted: false,
    volume: 1,
    playsInline: false,
    preload: '',
    src: '',
    srcObject: null,
    captureStream: vi.fn(() => captured),
    play: vi.fn(async function play(this: { paused: boolean }) {
      this.paused = false;
    }),
    pause: vi.fn(function pause(this: { paused: boolean }) {
      this.paused = true;
    }),
    load: vi.fn(),
    removeAttribute: vi.fn(),
    canPlayType: vi.fn(() => ''),
    addEventListener: vi.fn((event: string, listener: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set<() => void>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener);
    }),
    emit,
  } as unknown as HTMLVideoElement & { emit: (event: string) => void };
}

function hlsController(input: {
  onAttach?: () => void;
  onLoad?: () => void;
  fatalError?: { details: string; type: string; message?: string };
} = {}) {
  const listeners = new Map<string, (event: string, data: unknown) => void>();
  const controller = {
    attachMedia: vi.fn(() => input.onAttach?.()),
    loadSource: vi.fn(() => {
      input.onLoad?.();
      if (input.fatalError) {
        listeners.get('hlsError')?.('hlsError', {
          fatal: true,
          details: input.fatalError.details,
          type: input.fatalError.type,
          error: input.fatalError.message ? new Error(input.fatalError.message) : undefined,
        });
      }
    }),
    destroy: vi.fn(),
    on: vi.fn((event: string, listener: (event: string, data: unknown) => void) => {
      listeners.set(event, listener);
    }),
    emitFatal: (fatalError: { details: string; type: string; message?: string }) => {
      listeners.get('hlsError')?.('hlsError', {
        fatal: true,
        details: fatalError.details,
        type: fatalError.type,
        error: fatalError.message ? new Error(fatalError.message) : undefined,
      });
    },
  };
  return controller;
}

function file(name: string, type: string): File {
  return new File(['demo'], name, { type });
}

async function withNavigator<T>(
  value: Pick<Navigator, 'userAgent' | 'vendor'>,
  run: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value,
  });
  try {
    return await run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'navigator', descriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  }
}

describe('ProgrammeSourceManager', () => {
  it('starts with a source-neutral snapshot', () => {
    expect(createInitialProgrammeSourceSnapshot()).toMatchObject({
      sourceType: 'none',
      status: 'idle',
      audioDetected: false,
      videoDetected: false,
    });
  });

  it('selects camera capture with one audio and one video track', async () => {
    const source = stream([
      track('audio', 'audio_1', { label: 'Mic 1' }),
      track('video', 'video_1', { label: 'Camera 1', settings: { width: 1280, height: 720, frameRate: 30 } }),
    ]);
    const preview = videoElement(source);
    const manager = new ProgrammeSourceManager({ mediaDevices: mediaDevices({ user: source }) });

    await manager.refreshDevices();
    await manager.selectCamera({ audioDeviceId: 'mic_1', videoDeviceId: 'camera_1' }, preview);
    await manager.start();
    await manager.pause();
    await manager.resume();

    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'camera',
      audioDetected: true,
      videoDetected: true,
      status: 'broadcasting',
      selectedAudioDeviceId: 'mic_1',
      selectedVideoDeviceId: 'camera_1',
      audioSourceLabel: 'Mic 1',
      videoSourceLabel: 'Camera 1',
      videoWidth: 1280,
      videoHeight: 720,
      frameRate: 30,
    });
    expect(preview.srcObject).toBe(source);
  });

  it('supports OBS-style video with a separate programme-audio device', async () => {
    const source = stream([
      track('audio', 'audio_obs', { label: 'VB-Audio Virtual Cable' }),
      track('video', 'video_obs', { label: 'OBS Virtual Camera', settings: { width: 1920, height: 1080, frameRate: 60 } }),
    ]);
    const manager = new ProgrammeSourceManager({ mediaDevices: mediaDevices({ user: source }) });

    await manager.refreshDevices();
    await manager.selectCamera({ audioDeviceId: 'vac_1', videoDeviceId: 'obs_1' }, videoElement(source));

    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'camera',
      audioDetected: true,
      videoDetected: true,
      audioSourceLabel: 'VB-Audio Virtual Cable',
      videoSourceLabel: 'OBS Virtual Camera',
      isObsVirtualCamera: true,
      isCaptureDeviceCandidate: true,
      audioMissingReason: null,
    });
  });

  it('selects screen capture without falsely claiming missing platform audio', async () => {
    const source = stream([track('video', 'screen_video')]);
    const manager = new ProgrammeSourceManager({ mediaDevices: mediaDevices({ display: source }) });

    await manager.selectScreen(videoElement(source));

    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'screen',
      audioDetected: false,
      videoDetected: true,
      previewReady: true,
      audioMissingReason: 'Browser or platform did not provide screen-share audio.',
      browserLimitation: 'Screen or tab audio depends on browser, operating system, and platform support.',
    });
  });

  it('detects screen-share track end as capture interruption', async () => {
    const video = track('video', 'screen_video');
    const manager = new ProgrammeSourceManager({ mediaDevices: mediaDevices({ display: stream([video]) }) });

    await manager.selectScreen(videoElement(stream([video])));
    video.emitEnded();

    expect(manager.getSnapshot()).toMatchObject({
      status: 'ended',
      sourceEnded: true,
      captureInterrupted: true,
      videoTrackState: 'ended',
    });
  });

  it('surfaces selected device disappearance during refresh', async () => {
    const devices = [
      { kind: 'videoinput', deviceId: 'camera_1', label: 'Camera 1' },
      { kind: 'audioinput', deviceId: 'mic_1', label: 'Mic 1' },
    ] as MediaDeviceInfo[];
    const media = mediaDevices({ devices });
    const manager = new ProgrammeSourceManager({ mediaDevices: media });

    await manager.refreshDevices();
    await manager.selectCamera({ audioDeviceId: 'mic_1', videoDeviceId: 'camera_1' }, videoElement(stream([track('audio'), track('video')])));
    devices.splice(0, devices.length, { kind: 'audioinput', deviceId: 'mic_1', label: 'Mic 1' } as MediaDeviceInfo);
    await manager.refreshDevices();

    expect(manager.getSnapshot()).toMatchObject({
      status: 'ended',
      captureInterrupted: true,
      error: { code: 'device-unavailable' },
      revision: 1,
    });
  });

  it('loads uploaded video as a paused preview, rewinds before start, and preserves timeline controls', async () => {
    const source = stream([track('audio'), track('video')]);
    const preview = videoElement(source);
    const revoke = vi.fn();
    const manager = new ProgrammeSourceManager({
      createObjectUrl: () => 'blob:uploaded-video',
      revokeObjectUrl: revoke,
    });

    expect(isUploadedProgrammeVideoSupported(file('clip.mp4', 'video/mp4'))).toBe(true);
    expect(isUploadedProgrammeVideoSupported(file('clip.mov', 'video/quicktime'))).toBe(true);
    expect(isUploadedProgrammeVideoSupported(file('clip.avi', 'video/x-msvideo'))).toBe(false);

    await manager.selectUploadedVideo(file('clip.webm', 'video/webm'), preview);
    expect(preview.play).not.toHaveBeenCalled();
    expect(preview.pause).toHaveBeenCalled();
    expect(preview.currentTime).toBe(0);
    await manager.seek(2_000);

    expect(manager.getSnapshot()).toMatchObject({
      status: 'preview-ready',
      broadcasting: false,
      paused: false,
      programmeTimestampMs: 2_000,
    });

    await manager.prepareForInterpretationStart();
    expect(preview.currentTime).toBe(0);
    expect(source.getTracks().every((item) => item.enabled)).toBe(true);
    expect(manager.getSnapshot()).toMatchObject({
      status: 'preview-ready',
      broadcasting: false,
      programmeTimestampMs: 0,
    });

    await manager.start();
    expect(preview.muted).toBe(false);
    expect(preview.volume).toBe(1);
    await manager.seek(5_000);
    await manager.restart();
    await manager.clear();

    expect(preview.play).toHaveBeenCalled();
    expect(manager.getSnapshot()).toMatchObject({ sourceType: 'none' });
    expect(revoke).toHaveBeenCalledWith('blob:uploaded-video');
  });

  it('prepares uploaded-video Web Audio before playback so WebRTC binds the final stream', async () => {
    const capturedAudio = track('audio', 'captured_audio');
    const capturedVideo = track('video', 'uploaded_preview_video');
    const transportVideo = track('video', 'uploaded_transport_video');
    const webAudio = track('audio', 'uploaded_web_audio');
    const captured = stream([capturedAudio, capturedVideo]);
    const transportCapture = stream([track('audio', 'transport_captured_audio'), transportVideo]);
    const destination = {
      stream: stream([webAudio]),
      disconnect: vi.fn(),
    };
    const sourceNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const close = vi.fn(async () => undefined);
    const mediaStreamDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'MediaStream');
    const audioContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    Object.defineProperty(globalThis, 'MediaStream', {
      configurable: true,
      value: vi.fn((tracks: MediaStreamTrack[]) => stream(tracks)),
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: vi.fn(() => ({
        createMediaElementSource: vi.fn(() => sourceNode),
        createMediaStreamDestination: vi.fn(() => destination),
        resume: vi.fn(async () => undefined),
        close,
      })),
    });

    try {
      const manager = new ProgrammeSourceManager({
        createObjectUrl: () => 'blob:uploaded-video',
        revokeObjectUrl: vi.fn(),
      });
      const preview = videoElement(captured) as unknown as HTMLVideoElement & {
        captureStream: ReturnType<typeof vi.fn>;
      };
      preview.captureStream = vi.fn()
        .mockReturnValueOnce(captured)
        .mockReturnValueOnce(transportCapture);

      await manager.selectUploadedVideo(file('clip.mp4', 'video/mp4'), preview);

      expect(sourceNode.connect).not.toHaveBeenCalled();
      expect(capturedAudio.readyState).toBe('live');
      expect(capturedVideo.readyState).toBe('live');
      expect(manager.getSnapshot()).toMatchObject({
        sourceType: 'uploaded-video',
        status: 'preview-ready',
        audioSourceLabel: 'captured_audio',
        videoSourceLabel: 'uploaded_preview_video',
      });

      await manager.prepareForInterpretationStart();

      expect(sourceNode.connect).toHaveBeenCalledWith(destination);
      expect(capturedAudio.readyState).toBe('ended');
      expect(capturedVideo.readyState).toBe('ended');
      expect(manager.getStream()?.getAudioTracks()[0]).toBe(webAudio);
      expect(manager.getStream()?.getVideoTracks()[0]).toBe(transportVideo);
      expect(manager.getStream()?.getTracks().every((item) => item.enabled)).toBe(true);
      expect(manager.getSnapshot()).toMatchObject({
        audioDetected: true,
        videoDetected: true,
        audioSourceLabel: 'uploaded_web_audio',
        videoSourceLabel: 'uploaded_transport_video',
      });

      await manager.start();

      await manager.clear();

      expect(sourceNode.disconnect).toHaveBeenCalledTimes(1);
      expect(destination.disconnect).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(webAudio.readyState).toBe('ended');
    } finally {
      if (mediaStreamDescriptor) {
        Object.defineProperty(globalThis, 'MediaStream', mediaStreamDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'MediaStream');
      }
      if (audioContextDescriptor) {
        Object.defineProperty(globalThis, 'AudioContext', audioContextDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'AudioContext');
      }
    }
  });

  it('validates direct MP4, WebM, and HLS URLs without accepting platform pages', () => {
    expect(validateDirectProgrammeUrl('https://cdn.example.com/demo.mp4')).toMatchObject({
      format: 'mp4',
      url: 'https://cdn.example.com/demo.mp4',
    });
    expect(validateDirectProgrammeUrl('https://cdn.example.com/live/programme.webm?clip=abc')).toMatchObject({
      format: 'webm',
      url: 'https://cdn.example.com/live/programme.webm?clip=abc',
    });
    expect(validateDirectProgrammeUrl('https://cdn.example.com/live/index.m3u8')).toMatchObject({
      format: 'hls',
      url: 'https://cdn.example.com/live/index.m3u8',
    });
    expect(() => validateDirectProgrammeUrl('file:///C:/demo.mp4')).toThrow(/HTTP or HTTPS/);
    expect(() => validateDirectProgrammeUrl('https://youtube.com/watch?v=demo')).toThrow(
      /Only direct MP4, WebM, and HLS/,
    );
  });

  it('maps a local RTMP publish URL and stream key to the expected MediaMTX HLS URL', () => {
    expect(
      deriveRtmpHlsPlaybackUrl({
        publishUrl: 'rtmp://localhost:1935/live',
        streamKey: 'videofy-demo',
      }),
    ).toMatchObject({
      publishUrl: 'rtmp://localhost:1935/live',
      streamKeyRedacted: 'vi...mo',
      streamPath: 'live/videofy-demo',
      hlsPlaybackUrl: 'http://localhost:8888/live/videofy-demo/index.m3u8',
    });
    expect(
      deriveRtmpHlsPlaybackUrl({
        publishUrl: 'rtmp://127.0.0.1:1935/channel',
        streamKey: 'demo_01',
        hlsBaseUrl: 'http://127.0.0.1:8888/custom',
      }).hlsPlaybackUrl,
    ).toBe('http://127.0.0.1:8888/custom/channel/demo_01/index.m3u8');
  });

  it('rejects unsafe RTMP gateway inputs before deriving playback', () => {
    expect(() =>
      deriveRtmpHlsPlaybackUrl({
        publishUrl: 'https://localhost/live',
        streamKey: 'videofy-demo',
      }),
    ).toThrow(/rtmp/);
    expect(() =>
      deriveRtmpHlsPlaybackUrl({
        publishUrl: 'rtmp://example.com/live',
        streamKey: 'videofy-demo',
      }),
    ).toThrow(/local RTMP gateway/);
    expect(() =>
      deriveRtmpHlsPlaybackUrl({
        publishUrl: 'rtmp://localhost:1935/live',
        streamKey: '../secret',
      }),
    ).toThrow(/cannot include slashes/);
  });

  it('selects a direct MP4 URL through the media element capture path', async () => {
    const source = stream([track('audio', 'stream_audio'), track('video', 'stream_video')]);
    const preview = videoElement(source);
    const loadHlsRuntime = vi.fn(async () => {
      throw new Error('hls.js should not load for MP4.');
    });
    const manager = new ProgrammeSourceManager({ loadHlsRuntime });

    await manager.selectDirectStreamUrl('https://cdn.example.com/show.mp4', preview);
    expect(preview.play).not.toHaveBeenCalled();
    expect(preview.pause).toHaveBeenCalled();
    expect(preview.currentTime).toBe(0);

    await manager.seek(5_000);
    await manager.prepareForInterpretationStart();
    expect(preview.currentTime).toBe(0);

    await manager.start();
    await manager.pause();
    await manager.resume();

    expect(preview.src).toBe('https://cdn.example.com/show.mp4');
    expect(preview.crossOrigin).toBe('anonymous');
    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'direct-url',
      sourceIdentity: 'cdn.example.com/show.mp4',
      audioDetected: true,
      videoDetected: true,
      status: 'broadcasting',
      canSeek: true,
      canRestart: true,
    });
    expect(loadHlsRuntime).not.toHaveBeenCalled();
  });

  it('does not load hls.js for direct WebM URLs', async () => {
    const source = stream([track('audio', 'stream_audio'), track('video', 'stream_video')]);
    const preview = videoElement(source);
    const loadHlsRuntime = vi.fn(async () => {
      throw new Error('hls.js should not load for WebM.');
    });
    const manager = new ProgrammeSourceManager({ loadHlsRuntime });

    await manager.selectDirectStreamUrl('https://cdn.example.com/show.webm', preview);

    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'direct-url',
      audioDetected: true,
      videoDetected: true,
    });
    expect(preview.play).not.toHaveBeenCalled();
    expect(preview.currentTime).toBe(0);
    expect(loadHlsRuntime).not.toHaveBeenCalled();
  });

  it('reports direct URL missing audio without blocking preview selection', async () => {
    const source = stream([track('video', 'stream_video')]);
    const manager = new ProgrammeSourceManager();

    await manager.selectDirectStreamUrl('https://cdn.example.com/silent.webm', videoElement(source));

    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'direct-url',
      audioDetected: false,
      videoDetected: true,
      audioMissingReason: 'Stream URL did not expose a browser-playable audio track.',
    });
  });

  it('rejects HLS URLs when the browser does not support native HLS', async () => {
    const manager = new ProgrammeSourceManager({ isHlsSupported: () => false });

    await expect(
      manager.selectDirectStreamUrl('https://cdn.example.com/live.m3u8', videoElement(stream([]))),
    ).rejects.toMatchObject({
      code: 'unsupported-format',
    });
  });

  it('accepts native HLS URLs when the browser reports HLS playback support', async () => {
    await withNavigator(
      {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        vendor: 'Apple Computer, Inc.',
      },
      async () => {
        const source = stream([track('audio', 'hls_audio'), track('video', 'hls_video')]);
        const preview = {
          ...videoElement(source),
          canPlayType: vi.fn((mimeType: string) =>
            mimeType === 'application/vnd.apple.mpegurl' ? 'probably' : '',
          ),
        } as unknown as HTMLVideoElement;
        const loadHlsRuntime = vi.fn(async () => {
          throw new Error('hls.js should not load for native HLS.');
        });
        const manager = new ProgrammeSourceManager({ loadHlsRuntime });

        await manager.selectDirectStreamUrl('https://cdn.example.com/live.m3u8', preview);

        expect(manager.getSnapshot()).toMatchObject({
          sourceType: 'direct-url',
          audioDetected: true,
          videoDetected: true,
          browserLimitation: 'Native HLS playback active.',
        });
        expect(loadHlsRuntime).not.toHaveBeenCalled();
      },
    );
  });

  it('uses hls.js when Chromium reports false native HLS support', async () => {
    await withNavigator(
      {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        vendor: 'Google Inc.',
      },
      async () => {
        const source = stream([track('audio', 'hls_audio'), track('video', 'hls_video')]);
        const preview = {
          ...videoElement(source),
          canPlayType: vi.fn((mimeType: string) =>
            mimeType === 'application/vnd.apple.mpegurl' ? 'probably' : '',
          ),
        } as unknown as HTMLVideoElement;
        const controller = hlsController();
        const loadHlsRuntime = vi.fn(async () => ({
          isSupported: () => true,
          createController: () => controller,
        }));
        const manager = new ProgrammeSourceManager({ loadHlsRuntime });

        await manager.selectDirectStreamUrl('https://cdn.example.com/live.m3u8', preview);

        expect(loadHlsRuntime).toHaveBeenCalledTimes(1);
        expect(controller.attachMedia).toHaveBeenCalledWith(preview);
        expect(controller.loadSource).toHaveBeenCalledWith('https://cdn.example.com/live.m3u8');
        expect(preview.src).toBe('');
        expect(manager.getSnapshot()).toMatchObject({
          sourceType: 'direct-url',
          audioDetected: true,
          videoDetected: true,
          browserLimitation: 'hls.js playback active.',
        });
      },
    );
  });

  it('loads hls.js once for fallback HLS playback', async () => {
    const source = stream([track('audio', 'hls_audio'), track('video', 'hls_video')]);
    const controller = hlsController();
    const loadHlsRuntime = vi.fn(async () => ({
      isSupported: () => true,
      createController: () => controller,
    }));
    const manager = new ProgrammeSourceManager({ loadHlsRuntime });

    await manager.selectDirectStreamUrl('https://cdn.example.com/live.m3u8', videoElement(source));

    expect(loadHlsRuntime).toHaveBeenCalledTimes(1);
    expect(controller.attachMedia).toHaveBeenCalledTimes(1);
    expect(controller.loadSource).toHaveBeenCalledWith('https://cdn.example.com/live.m3u8');
  });

  it('uses hls.js fallback for HLS URLs when native HLS is unavailable', async () => {
    const source = stream([track('audio', 'hls_audio'), track('video', 'hls_video')]);
    const preview = videoElement(source);
    const controller = hlsController();
    const manager = new ProgrammeSourceManager({
      isHlsSupported: () => true,
      createHlsController: () => controller,
    });

    await manager.selectDirectStreamUrl('https://cdn.example.com/live.m3u8', preview);

    expect(controller.attachMedia).toHaveBeenCalledWith(preview);
    expect(controller.loadSource).toHaveBeenCalledWith('https://cdn.example.com/live.m3u8');
    expect(preview.src).toBe('');
    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'direct-url',
      audioDetected: true,
      videoDetected: true,
      browserLimitation: 'hls.js playback active.',
    });
  });

  it('maps hls.js fatal manifest errors to clear operator failures', async () => {
    vi.useFakeTimers();
    const controller = hlsController({
      fatalError: {
        details: 'manifestParsingError',
        type: 'networkError',
        message: 'invalid manifest',
      },
    });
    const manager = new ProgrammeSourceManager({
      isHlsSupported: () => true,
      createHlsController: () => controller,
    });
    const selection = manager.selectDirectStreamUrl(
      'https://cdn.example.com/bad.m3u8',
      videoElement(stream([]), { readyState: 0 }),
    );
    const expectation = expect(selection).rejects.toMatchObject({
      code: 'decode-failed',
      message: 'Invalid HLS manifest.',
    });

    await vi.advanceTimersByTimeAsync(100);
    await expectation;
    vi.useRealTimers();
  });

  it('maps hls.js fatal CORS and codec errors without silent fallback', async () => {
    vi.useFakeTimers();
    const corsManager = new ProgrammeSourceManager({
      isHlsSupported: () => true,
      createHlsController: () =>
        hlsController({
          fatalError: {
            details: 'manifestLoadError',
            type: 'networkError',
            message: 'No Access-Control-Allow-Origin header',
          },
        }),
    });
    const corsSelection = corsManager.selectDirectStreamUrl(
      'https://cdn.example.com/cors.m3u8',
      videoElement(stream([]), { readyState: 0 }),
    );
    const corsExpectation = expect(corsSelection).rejects.toMatchObject({
      code: 'decode-failed',
      message: 'HLS stream is blocked by CORS.',
    });

    await vi.advanceTimersByTimeAsync(100);
    await corsExpectation;

    const codecManager = new ProgrammeSourceManager({
      isHlsSupported: () => true,
      createHlsController: () =>
        hlsController({
          fatalError: {
            details: 'manifestIncompatibleCodecsError',
            type: 'mediaError',
            message: 'unsupported codec',
          },
        }),
    });
    const codecSelection = codecManager.selectDirectStreamUrl(
      'https://cdn.example.com/codec.m3u8',
      videoElement(stream([]), { readyState: 0 }),
    );
    const codecExpectation = expect(codecSelection).rejects.toMatchObject({
      code: 'unsupported-format',
      message: 'HLS stream uses an unsupported codec.',
    });

    await vi.advanceTimersByTimeAsync(100);
    await codecExpectation;
    vi.useRealTimers();
  });

  it('destroys hls.js playback on cleanup', async () => {
    const source = stream([track('audio', 'hls_audio'), track('video', 'hls_video')]);
    const controller = hlsController();
    const manager = new ProgrammeSourceManager({
      isHlsSupported: () => true,
      createHlsController: () => controller,
    });

    await manager.selectDirectStreamUrl('https://cdn.example.com/live.m3u8', videoElement(source));
    await manager.clear();

    expect(controller.destroy).toHaveBeenCalledTimes(1);
  });

  it('surfaces hls.js stream interruption after preview readiness', async () => {
    const source = stream([track('audio', 'hls_audio'), track('video', 'hls_video')]);
    const controller = hlsController();
    const manager = new ProgrammeSourceManager({
      isHlsSupported: () => true,
      createHlsController: () => controller,
    });

    await manager.selectDirectStreamUrl('https://cdn.example.com/live.m3u8', videoElement(source));
    controller.emitFatal({
      details: 'fragLoadError',
      type: 'networkError',
      message: 'segment disappeared',
    });

    expect(manager.getSnapshot()).toMatchObject({
      status: 'failed',
      captureInterrupted: true,
      error: {
        code: 'stream-interrupted',
        message: 'HLS stream playback was interrupted.',
      },
    });
    expect(source.getTracks().every((item) => item.enabled === false)).toBe(true);
  });

  it('keeps RTMP processing unavailable until gateway HLS metadata is ready', async () => {
    vi.useFakeTimers();
    const source = stream([track('audio', 'rtmp_audio'), track('video', 'rtmp_video')]);
    const preview = videoElement(source, { readyState: 0 });
    const controller = hlsController();
    const manager = new ProgrammeSourceManager({
      isHlsSupported: () => true,
      createHlsController: () => controller,
    });

    const selection = manager.selectRtmpProgrammeSource({
      publishUrl: 'rtmp://localhost:1935/live',
      streamKey: 'videofy-demo',
    }, preview);

    await vi.advanceTimersByTimeAsync(100);
    expect(manager.getStream()).toBeNull();
    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'rtmp',
      status: 'selecting',
      previewReady: false,
      rtmpState: 'waiting-for-stream',
      rtmpPlaybackUrl: 'http://localhost:8888/live/videofy-demo/index.m3u8',
    });

    (preview as { readyState: number }).readyState = 1;
    preview.emit('loadedmetadata');
    await selection;
    vi.useRealTimers();

    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'rtmp',
      status: 'preview-ready',
      previewReady: true,
      audioDetected: true,
      videoDetected: true,
      rtmpState: 'live',
    });
  });

  it('waits for RTMP HLS capture to expose audio after video metadata', async () => {
    vi.useFakeTimers();
    const tracks = [track('video', 'rtmp_video')] as MediaStreamTrack[];
    const source = stream(tracks);
    const preview = videoElement(source, { readyState: 0 });
    const controller = hlsController();
    const manager = new ProgrammeSourceManager({
      isHlsSupported: () => true,
      createHlsController: () => controller,
    });

    const selection = manager.selectRtmpProgrammeSource({
      publishUrl: 'rtmp://localhost:1935/live',
      streamKey: 'videofy-demo',
    }, preview);

    (preview as { readyState: number }).readyState = 1;
    preview.emit('loadedmetadata');
    await vi.advanceTimersByTimeAsync(500);

    expect(manager.getStream()).toBeNull();
    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'rtmp',
      status: 'selecting',
      audioDetected: false,
      videoDetected: false,
    });

    tracks.push(track('audio', 'rtmp_audio'));
    await vi.advanceTimersByTimeAsync(100);
    await selection;
    vi.useRealTimers();

    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'rtmp',
      status: 'preview-ready',
      audioDetected: true,
      videoDetected: true,
      rtmpState: 'live',
    });
  });

  it('uses Web Audio to capture RTMP HLS audio when captureStream exposes video only', async () => {
    const capturedVideo = track('video', 'rtmp_video');
    const webAudio = track('audio', 'rtmp_web_audio');
    const captured = stream([capturedVideo]);
    const destination = {
      stream: stream([webAudio]),
      disconnect: vi.fn(),
    };
    const sourceNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const close = vi.fn(async () => undefined);
    const mediaStreamDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'MediaStream');
    const audioContextDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    Object.defineProperty(globalThis, 'MediaStream', {
      configurable: true,
      value: vi.fn((tracks: MediaStreamTrack[]) => stream(tracks)),
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: vi.fn(() => ({
        createMediaElementSource: vi.fn(() => sourceNode),
        createMediaStreamDestination: vi.fn(() => destination),
        resume: vi.fn(async () => undefined),
        close,
      })),
    });

    try {
      const manager = new ProgrammeSourceManager({
        isHlsSupported: () => true,
        createHlsController: () => hlsController(),
      });
      const preview = videoElement(captured);

      await manager.selectRtmpProgrammeSource({
        publishUrl: 'rtmp://localhost:1935/live',
        streamKey: 'videofy-demo',
      }, preview);

      expect(sourceNode.connect).toHaveBeenCalledWith(destination);
      expect(preview.muted).toBe(false);
      expect(preview.volume).toBe(1);
      expect(manager.getSnapshot()).toMatchObject({
        sourceType: 'rtmp',
        status: 'preview-ready',
        audioDetected: true,
        videoDetected: true,
        audioSourceLabel: 'rtmp_web_audio',
        videoSourceLabel: 'rtmp_video',
      });

      await manager.clear();

      expect(sourceNode.disconnect).toHaveBeenCalledTimes(1);
      expect(destination.disconnect).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(webAudio.readyState).toBe('ended');
    } finally {
      if (mediaStreamDescriptor) {
        Object.defineProperty(globalThis, 'MediaStream', mediaStreamDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'MediaStream');
      }
      if (audioContextDescriptor) {
        Object.defineProperty(globalThis, 'AudioContext', audioContextDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'AudioContext');
      }
    }
  });

  it('marks RTMP interruption and recovery without creating a duplicate active source', async () => {
    const first = stream([track('audio', 'rtmp_audio_1'), track('video', 'rtmp_video_1')]);
    const firstController = hlsController();
    const manager = new ProgrammeSourceManager({
      isHlsSupported: () => true,
      createHlsController: () => firstController,
    });

    await manager.selectRtmpProgrammeSource({
      publishUrl: 'rtmp://localhost:1935/live',
      streamKey: 'videofy-demo',
    }, videoElement(first));
    await manager.start();
    firstController.emitFatal({
      details: 'fragLoadError',
      type: 'networkError',
      message: 'stream interrupted',
    });

    expect(manager.getSnapshot()).toMatchObject({
      status: 'failed',
      rtmpState: 'interrupted',
      captureInterrupted: true,
    });
    const second = stream([track('audio', 'rtmp_audio_2'), track('video', 'rtmp_video_2')]);
    await manager.selectRtmpProgrammeSource({
      publishUrl: 'rtmp://localhost:1935/live',
      streamKey: 'videofy-demo',
    }, videoElement(second));

    expect(first.getTracks().every((item) => item.readyState === 'ended')).toBe(true);
    expect(manager.getSnapshot()).toMatchObject({
      status: 'preview-ready',
      rtmpState: 'recovered',
      sourceIdentity: 'MediaMTX live/videofy-demo',
    });
  });

  it('cleans up uploaded video before switching to a live source', async () => {
    const uploaded = stream([track('audio', 'uploaded_audio'), track('video', 'uploaded_video')]);
    const live = stream([track('audio', 'live_audio'), track('video', 'live_video')]);
    const preview = videoElement(uploaded);
    const revoke = vi.fn();
    const manager = new ProgrammeSourceManager({
      mediaDevices: mediaDevices({ user: live }),
      createObjectUrl: () => 'blob:uploaded-video',
      revokeObjectUrl: revoke,
    });

    await manager.selectUploadedVideo(file('clip.webm', 'video/webm'), preview);
    await manager.clear();
    await manager.selectCamera({}, videoElement(live));

    expect(revoke).toHaveBeenCalledWith('blob:uploaded-video');
    expect(uploaded.getTracks().every((item) => item.readyState === 'ended')).toBe(true);
    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'camera',
      previewReady: true,
    });
  });

  it('ends uploaded-video broadcasting when the media element ends naturally', async () => {
    const audio = track('audio');
    const video = track('video');
    const source = stream([audio, video]);
    const preview = videoElement(source);
    const onTrackEnded = vi.fn();
    const manager = new ProgrammeSourceManager({
      createObjectUrl: () => 'blob:uploaded-video',
      onTrackEnded,
    });

    await manager.selectUploadedVideo(file('clip.webm', 'video/webm'), preview);
    await manager.start();
    preview.currentTime = 4.2;
    preview.emit('ended');

    expect(manager.getSnapshot()).toMatchObject({
      status: 'ended',
      broadcasting: false,
      paused: false,
      programmeTimestampMs: 4_200,
      sourceEnded: true,
      captureInterrupted: false,
      revision: 1,
    });
    expect(audio.enabled).toBe(false);
    expect(video.enabled).toBe(false);
    expect(onTrackEnded).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported uploaded files and duplicate active source selection clearly', async () => {
    const manager = new ProgrammeSourceManager({ mediaDevices: mediaDevices() });

    await expect(
      manager.selectUploadedVideo(file('optimistic.mov.txt', 'text/plain'), videoElement(stream([]))),
    ).rejects.toMatchObject({ code: 'unsupported-format' });

    await manager.clear();
    await manager.selectCamera({}, videoElement(stream([track('audio'), track('video')])));
    await expect(manager.selectCamera()).rejects.toMatchObject({ code: 'duplicate-source' });
  });

  it('creates a revision boundary when tracks end', async () => {
    const video = track('video');
    const revisions: number[] = [];
    const manager = new ProgrammeSourceManager({
      mediaDevices: mediaDevices({ user: stream([track('audio'), video]) }),
      onRevisionChange: (revision) => revisions.push(revision),
    });

    await manager.selectCamera({}, videoElement(stream([track('audio'), video])));
    video.emitEnded();

    expect(manager.getSnapshot()).toMatchObject({
      status: 'ended',
      revision: 1,
    });
    expect(revisions).toEqual([1]);
  });
});
