import { describe, expect, it, vi } from 'vitest';
import {
  ProgrammeSourceManager,
  createInitialProgrammeSourceSnapshot,
  isUploadedProgrammeVideoSupported,
} from './programmeSourceManager';

function track(kind: 'audio' | 'video', id: string = kind) {
  const listeners = new Set<() => void>();
  return {
    id,
    kind,
    enabled: true,
    readyState: 'live',
    stop: vi.fn(function stop(this: { readyState: string }) {
      this.readyState = 'ended';
    }),
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'ended') listeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'ended') listeners.delete(listener);
    }),
    emitEnded: () => listeners.forEach((listener) => listener()),
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
    enumerateDevices: vi.fn(async () => [
      { kind: 'videoinput', deviceId: 'camera_1', label: 'Camera 1' },
      { kind: 'audioinput', deviceId: 'mic_1', label: 'Mic 1' },
    ]),
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
    const source = stream([track('audio', 'audio_1'), track('video', 'video_1')]);
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
    });
    expect(preview.srcObject).toBe(source);
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
