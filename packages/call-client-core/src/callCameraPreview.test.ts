import { describe, expect, it } from 'vitest';
import {
  CallCameraPreviewController,
  hdCameraVideoConstraints,
  type CameraDeviceInfoLike,
  type CameraMediaDevicesLike,
  type CameraPreviewState,
  type CameraStreamConstraints,
  type CameraStreamLike,
} from './callCameraPreview';

/**
 * The lifecycle is the part worth testing: every way of no longer wanting the
 * camera must put its tracks down — including a permission grant that resolves
 * AFTER the user already said stop, which still lights the camera. Fakes only:
 * no DOM, no real devices.
 */

interface FakeStream {
  stream: CameraStreamLike;
  stoppedTracks: () => number;
}

function makeStream(trackCount = 2): FakeStream {
  let stopped = 0;
  const tracks = Array.from({ length: trackCount }, () => ({
    stop: () => {
      stopped += 1;
    },
  }));
  return { stream: { getTracks: () => tracks }, stoppedTracks: () => stopped };
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

interface HarnessOptions {
  streams?: FakeStream[];
  failWith?: unknown;
  devices?: CameraDeviceInfoLike[];
  enumerate?: boolean;
  enumerateFails?: boolean;
}

interface Harness {
  controller: CallCameraPreviewController;
  states: CameraPreviewState[];
  constraintsSeen: CameraStreamConstraints[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const streams = [...(options.streams ?? [makeStream()])];
  const constraintsSeen: CameraStreamConstraints[] = [];
  const states: CameraPreviewState[] = [];
  const env: CameraMediaDevicesLike = {
    getUserMedia: async (constraints) => {
      constraintsSeen.push(constraints);
      if (options.failWith !== undefined) throw options.failWith;
      const next = streams.shift();
      if (!next) throw new Error('harness ran out of streams');
      return next.stream;
    },
  };
  if (options.enumerate !== false) {
    env.enumerateDevices = async () => {
      if (options.enumerateFails) throw new Error('enumerate failed');
      return options.devices ?? [];
    };
  }
  const controller = new CallCameraPreviewController(env, (state) => states.push(state));
  return { controller, states, constraintsSeen };
}

describe('grant', () => {
  it('goes requesting then active and exposes the stream', async () => {
    const stream = makeStream();
    const h = createHarness({ streams: [stream] });

    await h.controller.start();

    expect(h.states[0]?.status).toBe('requesting');
    expect(h.controller.state().status).toBe('active');
    expect(h.controller.state().cameraOn).toBe(true);
    expect(h.controller.stream()).toBe(stream.stream);
  });

  it('lists cameras only — never microphones — once the grant names them', async () => {
    const h = createHarness({
      devices: [
        { kind: 'videoinput', deviceId: 'cam-a', label: 'Front camera' },
        { kind: 'audioinput', deviceId: 'mic-a', label: 'Desk mic' },
        { kind: 'videoinput', deviceId: 'cam-b', label: 'Rear camera' },
      ],
    });

    await h.controller.start();

    expect(h.controller.state().devices).toEqual([
      { deviceId: 'cam-a', label: 'Front camera' },
      { deviceId: 'cam-b', label: 'Rear camera' },
    ]);
  });

  it('works without device enumeration — the picker is simply not offered', async () => {
    const h = createHarness({ enumerate: false });

    await h.controller.start();

    expect(h.controller.state().status).toBe('active');
    expect(h.controller.state().devices).toEqual([]);
  });

  it('an enumeration failure costs the device list, never the stream', async () => {
    const h = createHarness({ enumerateFails: true });

    await h.controller.start();

    expect(h.controller.state().status).toBe('active');
    expect(h.controller.state().devices).toEqual([]);
  });
});

describe('denial and absence', () => {
  it('a declined permission is a state, not a throw', async () => {
    const h = createHarness({ failWith: namedError('NotAllowedError') });

    await h.controller.start();

    expect(h.controller.state().status).toBe('denied');
    expect(h.controller.state().cameraOn).toBe(false);
    expect(h.controller.stream()).toBeNull();
  });

  it('no camera at all reads unavailable, not denied', async () => {
    const h = createHarness({ failWith: namedError('NotFoundError') });

    await h.controller.start();

    expect(h.controller.state().status).toBe('unavailable');
  });

  it('a nonsense failure still lands on an honest status', async () => {
    const h = createHarness({ failWith: 'exploded' });

    await h.controller.start();

    expect(h.controller.state().status).toBe('unavailable');
  });

  it('an environment with no camera API is unavailable and unsupported', async () => {
    const controller = new CallCameraPreviewController(null);

    expect(controller.state().supported).toBe(false);

    await controller.start();

    expect(controller.state().status).toBe('unavailable');
    expect(controller.state().cameraOn).toBe(false);
  });
});

describe('device switching', () => {
  it('selecting a device restarts the stream with exactly that device', async () => {
    const first = makeStream();
    const second = makeStream();
    const h = createHarness({ streams: [first, second] });

    await h.controller.start();
    await h.controller.selectDevice('cam-b');

    expect(h.constraintsSeen[1]).toEqual({ video: hdCameraVideoConstraints('cam-b') });
    expect(first.stoppedTracks()).toBe(2);
    expect(h.controller.stream()).toBe(second.stream);
    expect(h.controller.state().status).toBe('active');
    expect(h.controller.state().selectedDeviceId).toBe('cam-b');
  });

  it('selecting while the camera is off only remembers the choice', async () => {
    const h = createHarness();

    await h.controller.selectDevice('cam-b');

    expect(h.constraintsSeen).toHaveLength(0);
    expect(h.controller.state().selectedDeviceId).toBe('cam-b');

    await h.controller.start();

    expect(h.constraintsSeen[0]).toEqual({ video: hdCameraVideoConstraints('cam-b') });
  });
});

describe('release', () => {
  it('stop puts down every track and detaches the element', async () => {
    const stream = makeStream();
    const h = createHarness({ streams: [stream] });
    const element = { srcObject: null as unknown };
    h.controller.attachElement(element);

    await h.controller.start();

    expect(element.srcObject).toBe(stream.stream);

    h.controller.stop();

    expect(stream.stoppedTracks()).toBe(2);
    expect(h.controller.stream()).toBeNull();
    expect(element.srcObject).toBeNull();
    expect(h.controller.state().status).toBe('idle');
    expect(h.controller.state().cameraOn).toBe(false);
  });

  it('a grant that resolves after stop() is put down immediately', async () => {
    const stream = makeStream();
    let grant!: (stream: CameraStreamLike) => void;
    const env: CameraMediaDevicesLike = {
      getUserMedia: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    };
    const controller = new CallCameraPreviewController(env);

    const started = controller.start();
    controller.stop();
    grant(stream.stream);
    await started;

    expect(stream.stoppedTracks()).toBe(2);
    expect(controller.stream()).toBeNull();
    expect(controller.state().status).toBe('idle');
  });

  it('a newer start supersedes an older pending one, whose grant is stopped', async () => {
    const first = makeStream();
    const second = makeStream();
    const grants: Array<(stream: CameraStreamLike) => void> = [];
    const env: CameraMediaDevicesLike = {
      getUserMedia: () =>
        new Promise((resolve) => {
          grants.push(resolve);
        }),
    };
    const controller = new CallCameraPreviewController(env);

    const a = controller.start();
    const b = controller.start();
    grants[1]?.(second.stream);
    grants[0]?.(first.stream);
    await Promise.all([a, b]);

    expect(first.stoppedTracks()).toBe(2);
    expect(second.stoppedTracks()).toBe(0);
    expect(controller.stream()).toBe(second.stream);
    expect(controller.state().status).toBe('active');
  });

  it('setCameraOn toggles between live preview and released tracks', async () => {
    const first = makeStream();
    const second = makeStream();
    const h = createHarness({ streams: [first, second] });

    await h.controller.setCameraOn(true);
    expect(h.controller.state().status).toBe('active');

    await h.controller.setCameraOn(false);
    expect(first.stoppedTracks()).toBe(2);
    expect(h.controller.state().status).toBe('idle');
    expect(h.controller.state().cameraOn).toBe(false);

    await h.controller.setCameraOn(true);
    expect(h.controller.stream()).toBe(second.stream);
  });

  it('attaching an element after the stream is live points it at the stream', async () => {
    const stream = makeStream();
    const h = createHarness({ streams: [stream] });

    await h.controller.start();

    const element = { srcObject: null as unknown };
    h.controller.attachElement(element);
    expect(element.srcObject).toBe(stream.stream);

    h.controller.attachElement(null);
    expect(element.srcObject).toBeNull();
  });
});

describe('HD capture request (post-freeze exception, 18 Aug)', () => {
  it('asks for 720p ideals — never exacts — with and without a chosen device', () => {
    expect(hdCameraVideoConstraints()).toEqual({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
    expect(hdCameraVideoConstraints('cam-b')).toEqual({
      deviceId: { exact: 'cam-b' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
  });

  it('start() carries the HD request by default', async () => {
    const h = createHarness();
    await h.controller.start();
    expect(h.constraintsSeen[0]).toEqual({ video: hdCameraVideoConstraints() });
  });
});
