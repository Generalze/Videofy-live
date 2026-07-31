import { describe, expect, it, vi } from 'vitest';
import {
  ProgrammeSourceManager,
  createInitialProgrammeSourceSnapshot,
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

function videoElement(captured: MediaStream) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    readyState: 1,
    duration: 12.4,
    currentTime: 0,
    paused: true,
    muted: false,
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
    emit: (event: string) => {
      listeners.get(event)?.forEach((listener) => listener());
    },
  } as unknown as HTMLVideoElement & { emit: (event: string) => void };
}

function file(name: string, type: string): File {
  return new File(['demo'], name, { type });
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

  it('validates uploaded video support and preserves media element timeline', async () => {
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
    await manager.seek(2_000);

    expect(manager.getSnapshot()).toMatchObject({
      status: 'preview-ready',
      broadcasting: false,
      paused: false,
      programmeTimestampMs: 2_000,
    });

    await manager.start();
    await manager.seek(5_000);
    await manager.restart();
    await manager.clear();

    expect(preview.play).toHaveBeenCalled();
    expect(manager.getSnapshot()).toMatchObject({ sourceType: 'none' });
    expect(revoke).toHaveBeenCalledWith('blob:uploaded-video');
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

  it('selects a direct MP4 URL through the media element capture path', async () => {
    const source = stream([track('audio', 'stream_audio'), track('video', 'stream_video')]);
    const preview = videoElement(source);
    const manager = new ProgrammeSourceManager();

    await manager.selectDirectStreamUrl('https://cdn.example.com/show.mp4', preview);
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
    const manager = new ProgrammeSourceManager();

    await expect(
      manager.selectDirectStreamUrl('https://cdn.example.com/live.m3u8', videoElement(stream([]))),
    ).rejects.toMatchObject({
      code: 'unsupported-format',
    });
  });

  it('accepts native HLS URLs when the browser reports HLS playback support', async () => {
    const source = stream([track('audio', 'hls_audio'), track('video', 'hls_video')]);
    const preview = {
      ...videoElement(source),
      canPlayType: vi.fn((mimeType: string) =>
        mimeType === 'application/vnd.apple.mpegurl' ? 'probably' : '',
      ),
    } as unknown as HTMLVideoElement;
    const manager = new ProgrammeSourceManager();

    await manager.selectDirectStreamUrl('https://cdn.example.com/live.m3u8', preview);

    expect(manager.getSnapshot()).toMatchObject({
      sourceType: 'direct-url',
      audioDetected: true,
      videoDetected: true,
      browserLimitation:
        'Native HLS playback only; Chrome requires MP4/WebM until an approved HLS runtime is added.',
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
