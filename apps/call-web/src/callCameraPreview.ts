/**
 * Pre-join camera preview.
 *
 * A video track left running keeps the camera light on, and a lit camera
 * with no visible preview reads as "this site is watching me". So every path
 * that stops wanting the camera — toggle off, leaving pre-join, a start
 * superseded by a newer one, even a permission grant that resolves AFTER the
 * user already said stop — releases its tracks through the same teardown.
 *
 * The controller owns the MediaStream outside React (the established
 * pattern: CallRemoteSpeakerAudioController). Screens render only the STATE
 * it publishes, so pre-join stays renderToStaticMarkup-testable with no DOM
 * APIs in render.
 *
 * Device ids identify cameras only inside this browser session and are
 * local-only: they reach the device <select> and getUserMedia constraints,
 * never a log line or the wire (device LABELS are the loggable name).
 */

export type CameraPreviewStatus = 'idle' | 'requesting' | 'active' | 'denied' | 'unavailable';

export interface CameraDeviceOption {
  /** Local-only selection identity; never logged, never sent. */
  deviceId: string;
  label: string;
}

/** Everything a screen needs to render the preview region. */
export interface CameraPreviewState {
  /** What is actually happening with the camera right now. */
  status: CameraPreviewStatus;
  /** The user's toggle intent; `status` reports how far reality got. */
  cameraOn: boolean;
  /** False only when the environment has no camera API at all. */
  supported: boolean;
  devices: CameraDeviceOption[];
  selectedDeviceId: string | null;
}

/* Narrow browser surfaces, so tests need neither a DOM nor real devices. */
export interface CameraTrackLike {
  stop(): void;
}
export interface CameraStreamLike {
  getTracks(): CameraTrackLike[];
}
export interface CameraDeviceInfoLike {
  kind: string;
  deviceId: string;
  label: string;
}
export interface CameraStreamConstraints {
  video:
    | boolean
    | {
        deviceId?: { exact: string };
        width?: { ideal: number };
        height?: { ideal: number };
        frameRate?: { ideal: number };
      };
}

/**
 * The capture request every camera site makes (post-freeze exception,
 * accepted 18 Aug: the browser's bare-`video: true` default is commonly
 * 640x480, which is the blurry frame the acceptance session saw). `ideal`
 * rather than `exact` on purpose — a camera that cannot do 720p degrades
 * gracefully instead of failing the call.
 */
export function hdCameraVideoConstraints(deviceId?: string | null): Exclude<
  CameraStreamConstraints['video'],
  boolean
> {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  };
}
export interface CameraMediaDevicesLike {
  getUserMedia(constraints: CameraStreamConstraints): Promise<CameraStreamLike>;
  /** Absent on engines without enumeration; the picker is simply not offered. */
  enumerateDevices?: () => Promise<CameraDeviceInfoLike[]>;
}
/** The one thing the preview needs from a <video>: somewhere to point the stream. */
export interface CameraVideoElementLike {
  srcObject: unknown;
}

/** The real browser surface, or null where none exists (then: 'unavailable'). */
export function defaultCameraMediaDevices(): CameraMediaDevicesLike | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return null;
  const mediaDevices = navigator.mediaDevices;
  const surface: CameraMediaDevicesLike = {
    getUserMedia: (constraints) => mediaDevices.getUserMedia(constraints),
  };
  if (typeof mediaDevices.enumerateDevices === 'function') {
    surface.enumerateDevices = () => mediaDevices.enumerateDevices();
  }
  return surface;
}

export class CallCameraPreviewController {
  private current: CameraPreviewState;
  private activeStream: CameraStreamLike | null = null;
  private element: CameraVideoElementLike | null = null;
  /** Bumped whenever the in-flight start() stops being wanted. */
  private epoch = 0;

  constructor(
    private readonly mediaDevices: CameraMediaDevicesLike | null,
    private readonly onChange: (state: CameraPreviewState) => void = () => undefined,
  ) {
    this.current = {
      status: 'idle',
      cameraOn: false,
      supported: mediaDevices !== null,
      devices: [],
      selectedDeviceId: null,
    };
  }

  state(): CameraPreviewState {
    return this.current;
  }

  stream(): CameraStreamLike | null {
    return this.activeStream;
  }

  /**
   * Ask for the camera. Failures are states, never throws: the preview is a
   * courtesy, and no camera problem may keep anyone from joining.
   */
  async start(constraints?: CameraStreamConstraints): Promise<void> {
    if (!this.mediaDevices) {
      this.update({ status: 'unavailable', cameraOn: false });
      return;
    }
    const epoch = ++this.epoch;
    this.releaseStream();
    this.update({ status: 'requesting', cameraOn: true });

    let stream: CameraStreamLike;
    try {
      stream = await this.mediaDevices.getUserMedia(constraints ?? this.defaultConstraints());
    } catch (error) {
      if (epoch !== this.epoch) return; // superseded, and nothing was acquired
      this.update({ status: classifyCameraFailure(error), cameraOn: false });
      return;
    }
    if (epoch !== this.epoch) {
      // stop() or a newer start() won while the permission prompt was open.
      // The grant still lit the camera — put it out immediately.
      stopTracks(stream);
      return;
    }

    this.activeStream = stream;
    this.syncElement();
    this.update({ status: 'active' });
    await this.refreshDevices(epoch);
  }

  /** Release the camera. Safe to call twice, and during a pending start(). */
  stop(): void {
    this.epoch += 1;
    this.releaseStream();
    this.update({ status: this.mediaDevices ? 'idle' : 'unavailable', cameraOn: false });
  }

  async setCameraOn(on: boolean): Promise<void> {
    if (on) {
      await this.start();
    } else {
      this.stop();
    }
  }

  /** Remember the chosen camera; restart the stream only if one is wanted. */
  async selectDevice(deviceId: string): Promise<void> {
    this.update({ selectedDeviceId: deviceId });
    if (this.current.cameraOn) {
      await this.start();
    }
  }

  /**
   * Point a <video> (or a test double) at whatever the current stream is.
   * Pass null on unmount; the previous element is always released first.
   */
  attachElement(element: CameraVideoElementLike | null): void {
    if (this.element && this.element !== element) {
      this.element.srcObject = null;
    }
    this.element = element;
    this.syncElement();
  }

  private syncElement(): void {
    if (this.element) {
      this.element.srcObject = this.activeStream;
    }
  }

  private releaseStream(): void {
    if (this.activeStream) {
      stopTracks(this.activeStream);
      this.activeStream = null;
    }
    if (this.element) {
      this.element.srcObject = null;
    }
  }

  private defaultConstraints(): CameraStreamConstraints {
    return { video: hdCameraVideoConstraints(this.current.selectedDeviceId) };
  }

  private async refreshDevices(epoch: number): Promise<void> {
    if (!this.mediaDevices?.enumerateDevices) return;
    let infos: CameraDeviceInfoLike[];
    try {
      infos = await this.mediaDevices.enumerateDevices();
    } catch {
      return; // no list is an acceptable list; the active stream is unaffected
    }
    if (epoch !== this.epoch) return;
    this.update({
      devices: infos
        .filter((info) => info.kind === 'videoinput')
        .map((info) => ({ deviceId: info.deviceId, label: info.label })),
    });
  }

  private update(patch: Partial<CameraPreviewState>): void {
    this.current = { ...this.current, ...patch };
    this.onChange(this.current);
  }
}

/** NotAllowed/Security is the user or browser saying no; the rest is hardware. */
function classifyCameraFailure(error: unknown): 'denied' | 'unavailable' {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError'
    ? 'denied'
    : 'unavailable';
}

function stopTracks(stream: CameraStreamLike): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // a track that refuses to stop is already stopped
    }
  }
}
