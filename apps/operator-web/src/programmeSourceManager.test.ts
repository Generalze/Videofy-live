import { describe, expect, it, vi } from 'vitest';
import {
  ProgrammeSourceManager,
  createInitialProgrammeSourceSnapshot,
  isUploadedProgrammeVideoSupported,
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
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLVideoElement;
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
