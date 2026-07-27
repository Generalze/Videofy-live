import { describe, expect, it, vi } from 'vitest';
import {
  BroadcasterCaptureController,
  BroadcasterCaptureError,
  createBroadcasterAudioConstraints,
  createInitialBroadcasterCaptureSnapshot,
  isBroadcasterCaptureActive,
} from './broadcasterCapture';

interface MockTrack extends MediaStreamTrack {
  emitEnded: () => void;
  stopped: boolean;
}

function mockAudioTrack(label = 'Desk microphone', deviceId = 'mic-1'): MockTrack {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let readyState: MediaStreamTrackState = 'live';
  const track = {
    kind: 'audio',
    label,
    muted: false,
    stopped: false,
    get readyState() {
      return readyState;
    },
    stop: vi.fn(() => {
      readyState = 'ended';
      track.stopped = true;
    }),
    addEventListener: vi.fn((event: string, listener: EventListenerOrEventListenerObject) => {
      if (event === 'ended') listeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: EventListenerOrEventListenerObject) => {
      if (event === 'ended') listeners.delete(listener);
    }),
    getSettings: vi.fn(() => ({
      deviceId,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    })),
    emitEnded: () => {
      readyState = 'ended';
      for (const listener of listeners) {
        if (typeof listener === 'function') listener(new Event('ended'));
        else listener.handleEvent(new Event('ended'));
      }
    },
  } as unknown as MockTrack;
  return track;
}

function mockVideoTrack(): MediaStreamTrack {
  return {
    kind: 'video',
    label: 'Camera',
    muted: false,
    readyState: 'live',
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function mockStream(audioTracks: MediaStreamTrack[], videoTracks: MediaStreamTrack[] = []) {
  return {
    getTracks: vi.fn(() => [...audioTracks, ...videoTracks]),
    getAudioTracks: vi.fn(() => audioTracks),
    getVideoTracks: vi.fn(() => videoTracks),
  } as unknown as MediaStream;
}

function mockDevices(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  devices: MediaDeviceInfo[] = [
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Desk microphone' } as MediaDeviceInfo,
  ],
): MediaDevices {
  return {
    getUserMedia: vi.fn(getUserMedia),
    enumerateDevices: vi.fn(async () => devices),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaDevices;
}

describe('BroadcasterCaptureController', () => {
  it('starts in an explicit idle state', () => {
    expect(createInitialBroadcasterCaptureSnapshot()).toMatchObject({
      status: 'idle',
      hasOwnedStream: false,
      audioTrackCount: 0,
      error: null,
    });
  });

  it('rejects unavailable browser media APIs and insecure contexts', async () => {
    const unsupported = new BroadcasterCaptureController();
    await expect(unsupported.requestPermission()).rejects.toMatchObject({
      code: 'media-api-unavailable',
    });

    const insecure = new BroadcasterCaptureController({
      mediaDevices: mockDevices(async () => mockStream([mockAudioTrack()])),
      isSecureContext: false,
    });
    await expect(insecure.requestPermission()).rejects.toMatchObject({
      code: 'insecure-context',
    });
  });

  it('uses explicit audio-only microphone speech constraints', () => {
    expect(createBroadcasterAudioConstraints('mic-1')).toEqual({
      audio: {
        deviceId: { exact: 'mic-1' },
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  });

  it('requests permission, stops the provisional stream and exposes devices', async () => {
    const track = mockAudioTrack();
    const mediaDevices = mockDevices(async () => mockStream([track]));
    const controller = new BroadcasterCaptureController({ mediaDevices });

    await expect(controller.requestPermission()).resolves.toMatchObject({
      status: 'ready',
      devices: [{ deviceId: 'mic-1', label: 'Desk microphone' }],
      hasOwnedStream: false,
    });
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith(createBroadcasterAudioConstraints());
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it('maps permission, missing-device, busy and constraint errors safely', async () => {
    const cases: Array<[DOMException, string, string]> = [
      [new DOMException('denied', 'NotAllowedError'), 'permission-denied', 'permission-denied'],
      [new DOMException('missing', 'NotFoundError'), 'no-audio-input-device', 'device-unavailable'],
      [new DOMException('busy', 'NotReadableError'), 'device-busy', 'device-unavailable'],
      [
        new DOMException('bad constraints', 'OverconstrainedError'),
        'constraint-unsupported',
        'device-unavailable',
      ],
    ];

    for (const [exception, code, status] of cases) {
      const controller = new BroadcasterCaptureController({
        mediaDevices: mockDevices(async () => {
          throw exception;
        }),
      });
      await expect(controller.requestPermission()).rejects.toMatchObject({ code });
      expect(controller.getSnapshot()).toMatchObject({ status, error: { code } });
    }
  });

  it('starts one owned stream after permission is ready', async () => {
    const permissionTrack = mockAudioTrack('Permission mic');
    const captureTrack = mockAudioTrack('Capture mic');
    const mediaDevices = mockDevices(
      vi
        .fn()
        .mockResolvedValueOnce(mockStream([permissionTrack]))
        .mockResolvedValueOnce(mockStream([captureTrack])),
    );
    const controller = new BroadcasterCaptureController({ mediaDevices });

    await controller.requestPermission();
    await expect(controller.startCapture()).resolves.toMatchObject({
      status: 'capturing',
      hasOwnedStream: true,
      audioTrackCount: 1,
      track: { label: 'Capture mic', readyState: 'live' },
    });
    expect(controller.getOwnedStream()).not.toBeNull();
    expect(isBroadcasterCaptureActive(controller.getSnapshot().status)).toBe(true);
  });

  it('prevents duplicate starts without creating or destroying another stream', async () => {
    const permissionTrack = mockAudioTrack('Permission mic');
    const captureTrack = mockAudioTrack('Capture mic');
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(mockStream([permissionTrack]))
      .mockResolvedValueOnce(mockStream([captureTrack]));
    const controller = new BroadcasterCaptureController({
      mediaDevices: mockDevices(getUserMedia),
    });

    await controller.requestPermission();
    await controller.startCapture();
    await expect(controller.startCapture()).rejects.toMatchObject({ code: 'duplicate-capture' });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(captureTrack.stop).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ status: 'capturing', hasOwnedStream: true });
  });

  it('stops all owned tracks and repeated stop calls are idempotent', async () => {
    const permissionTrack = mockAudioTrack('Permission mic');
    const captureTrack = mockAudioTrack('Capture mic');
    const controller = new BroadcasterCaptureController({
      mediaDevices: mockDevices(
        vi
          .fn()
          .mockResolvedValueOnce(mockStream([permissionTrack]))
          .mockResolvedValueOnce(mockStream([captureTrack])),
      ),
    });

    await controller.requestPermission();
    await controller.startCapture();
    await controller.stopCapture();
    await controller.stopCapture();

    expect(captureTrack.stop).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'stopped',
      hasOwnedStream: false,
      audioTrackCount: 0,
    });
  });

  it('cleans tracks on dispose and signalling teardown', async () => {
    const permissionTrack = mockAudioTrack('Permission mic');
    const captureTrack = mockAudioTrack('Capture mic');
    const controller = new BroadcasterCaptureController({
      mediaDevices: mockDevices(
        vi
          .fn()
          .mockResolvedValueOnce(mockStream([permissionTrack]))
          .mockResolvedValueOnce(mockStream([captureTrack])),
      ),
    });

    await controller.requestPermission();
    await controller.startCapture();
    await controller.handleSignallingTeardown('gateway disconnected');
    expect(captureTrack.stop).toHaveBeenCalledOnce();

    await controller.dispose();
    expect(controller.getSnapshot().hasOwnedStream).toBe(false);
  });

  it('marks unexpected track-ended events as failed and releases the stream', async () => {
    const permissionTrack = mockAudioTrack('Permission mic');
    const captureTrack = mockAudioTrack('Capture mic');
    const controller = new BroadcasterCaptureController({
      mediaDevices: mockDevices(
        vi
          .fn()
          .mockResolvedValueOnce(mockStream([permissionTrack]))
          .mockResolvedValueOnce(mockStream([captureTrack])),
      ),
    });

    await controller.requestPermission();
    await controller.startCapture();
    captureTrack.emitEnded();

    expect(controller.getSnapshot()).toMatchObject({
      status: 'failed',
      hasOwnedStream: false,
      error: { code: 'track-ended' },
    });
  });

  it('retries through permission after a recoverable error', async () => {
    const permissionTrack = mockAudioTrack('Permission mic');
    const controller = new BroadcasterCaptureController({
      mediaDevices: mockDevices(
        vi
          .fn()
          .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
          .mockResolvedValueOnce(mockStream([permissionTrack])),
      ),
    });

    await expect(controller.requestPermission()).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(controller.retry()).resolves.toMatchObject({ status: 'ready', error: null });
  });

  it('handles device selection and selected-device removal without silent switching', async () => {
    const controller = new BroadcasterCaptureController({
      mediaDevices: mockDevices(async () => mockStream([mockAudioTrack()]), [
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Desk microphone' } as MediaDeviceInfo,
        { kind: 'audioinput', deviceId: 'mic-2', label: 'Line feed' } as MediaDeviceInfo,
      ]),
    });
    await controller.selectDevice('mic-2');
    expect(controller.getSnapshot()).toMatchObject({
      selectedDeviceId: 'mic-2',
      activeDeviceLabel: 'Line feed',
    });

    const removed = new BroadcasterCaptureController({
      mediaDevices: mockDevices(async () => mockStream([mockAudioTrack()]), [
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Desk microphone' } as MediaDeviceInfo,
      ]),
    });
    await expect(removed.selectDevice('mic-missing')).rejects.toMatchObject({
      code: 'requested-device-missing',
    });
    expect(removed.getSnapshot()).toMatchObject({
      status: 'device-unavailable',
      error: { code: 'requested-device-missing' },
    });
  });

  it('rejects browser streams that include video tracks', async () => {
    const controller = new BroadcasterCaptureController({
      mediaDevices: mockDevices(async () => mockStream([mockAudioTrack()], [mockVideoTrack()])),
    });

    await expect(controller.requestPermission()).rejects.toBeInstanceOf(BroadcasterCaptureError);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'failed',
      error: { code: 'browser-capture-failure' },
    });
  });
});
