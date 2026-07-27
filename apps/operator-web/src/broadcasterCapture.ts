export type BroadcasterCaptureStatus =
  | 'idle'
  | 'requesting-permission'
  | 'ready'
  | 'capturing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'permission-denied'
  | 'device-unavailable'
  | 'failed';

export type BroadcasterCaptureErrorCode =
  | 'media-api-unavailable'
  | 'insecure-context'
  | 'permission-denied'
  | 'permission-dismissed'
  | 'no-audio-input-device'
  | 'requested-device-missing'
  | 'device-busy'
  | 'constraint-unsupported'
  | 'stream-creation-failure'
  | 'track-ended'
  | 'browser-capture-failure'
  | 'cleanup-failure'
  | 'duplicate-capture';

export interface BroadcasterCaptureErrorDetails {
  code: BroadcasterCaptureErrorCode;
  message: string;
  recoverable: boolean;
}

export class BroadcasterCaptureError extends Error {
  constructor(
    readonly code: BroadcasterCaptureErrorCode,
    message: string,
    readonly recoverable = true,
  ) {
    super(message);
    this.name = 'BroadcasterCaptureError';
  }
}

export interface BroadcasterAudioDevice {
  deviceId: string;
  label: string;
}

export interface BroadcasterAudioTrackMetadata {
  label: string;
  muted: boolean;
  readyState: MediaStreamTrackState;
  settings: {
    deviceId?: string;
    channelCount?: number;
    sampleRate?: number;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };
}

export interface BroadcasterCaptureSnapshot {
  status: BroadcasterCaptureStatus;
  devices: BroadcasterAudioDevice[];
  selectedDeviceId: string;
  activeDeviceLabel: string;
  audioTrackCount: number;
  track: BroadcasterAudioTrackMetadata | null;
  hasOwnedStream: boolean;
  error: BroadcasterCaptureErrorDetails | null;
  lastUpdatedAt: string;
}

export interface BroadcasterCaptureControllerOptions {
  mediaDevices?: MediaDevices;
  isSecureContext?: boolean;
  onStateChange?: (snapshot: BroadcasterCaptureSnapshot) => void;
  onSafeLog?: (event: string, metadata: Record<string, string | number | boolean | null>) => void;
}

const RECOVERABLE_ERROR_CODES = new Set<BroadcasterCaptureErrorCode>([
  'permission-denied',
  'permission-dismissed',
  'no-audio-input-device',
  'requested-device-missing',
  'device-busy',
  'constraint-unsupported',
  'stream-creation-failure',
  'track-ended',
  'browser-capture-failure',
  'cleanup-failure',
  'duplicate-capture',
]);

export function createInitialBroadcasterCaptureSnapshot(): BroadcasterCaptureSnapshot {
  return {
    status: 'idle',
    devices: [],
    selectedDeviceId: '',
    activeDeviceLabel: 'Not selected',
    audioTrackCount: 0,
    track: null,
    hasOwnedStream: false,
    error: null,
    lastUpdatedAt: new Date(0).toISOString(),
  };
}

export function createBroadcasterAudioConstraints(deviceId?: string): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    channelCount: { ideal: 1 },
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }
  return { audio, video: false };
}

export function isBroadcasterCaptureActive(status: BroadcasterCaptureStatus): boolean {
  return (
    status === 'requesting-permission' ||
    status === 'capturing' ||
    status === 'paused' ||
    status === 'stopping'
  );
}

export function isBroadcasterCaptureRecoverable(status: BroadcasterCaptureStatus): boolean {
  return status === 'permission-denied' || status === 'device-unavailable' || status === 'failed';
}

export class BroadcasterCaptureController {
  private readonly mediaDevices: MediaDevices | undefined;
  private readonly isSecureContext: boolean;
  private readonly onStateChange:
    | ((snapshot: BroadcasterCaptureSnapshot) => void)
    | undefined;
  private readonly onSafeLog:
    | ((
    event: string,
    metadata: Record<string, string | number | boolean | null>,
  ) => void)
    | undefined;

  private snapshot = createInitialBroadcasterCaptureSnapshot();
  private stream: MediaStream | null = null;
  private boundTracks = new Set<MediaStreamTrack>();
  private disposed = false;

  constructor(options: BroadcasterCaptureControllerOptions = {}) {
    this.mediaDevices = options.mediaDevices;
    this.isSecureContext = options.isSecureContext ?? true;
    this.onStateChange = options.onStateChange;
    this.onSafeLog = options.onSafeLog;
    this.mediaDevices?.addEventListener?.('devicechange', this.handleDeviceChange);
  }

  getSnapshot(): BroadcasterCaptureSnapshot {
    return this.snapshot;
  }

  getOwnedStream(): MediaStream | null {
    return this.stream;
  }

  async refreshDevices(): Promise<BroadcasterCaptureSnapshot> {
    const devices = await this.listAudioInputDevices();
    const selectedMissing =
      this.snapshot.selectedDeviceId !== '' &&
      !devices.some((device) => device.deviceId === this.snapshot.selectedDeviceId);
    if (selectedMissing) {
      const error = new BroadcasterCaptureError(
        'requested-device-missing',
        'Selected programme audio input is no longer available.',
      );
      this.fail('device-unavailable', error, devices);
      return this.snapshot;
    }
    this.updateSnapshot({
      devices,
      error: null,
      activeDeviceLabel: this.getActiveDeviceLabel(devices),
    });
    return this.snapshot;
  }

  async selectDevice(deviceId: string): Promise<BroadcasterCaptureSnapshot> {
    if (this.snapshot.status === 'capturing' || this.snapshot.status === 'requesting-permission') {
      throw this.rejectWithoutStateTransition(
        new BroadcasterCaptureError(
          'duplicate-capture',
          'Stop local broadcaster capture before changing programme audio input.',
        ),
      );
    }
    const devices = await this.listAudioInputDevices();
    if (deviceId && !devices.some((device) => device.deviceId === deviceId)) {
      throw this.applyError(
        new BroadcasterCaptureError(
          'requested-device-missing',
          'Selected programme audio input is unavailable.',
        ),
        'device-unavailable',
      );
    }
    this.updateSnapshot({
      selectedDeviceId: deviceId,
      devices,
      error: null,
      activeDeviceLabel: this.getActiveDeviceLabel(devices, deviceId),
    });
    return this.snapshot;
  }

  async requestPermission(): Promise<BroadcasterCaptureSnapshot> {
    this.assertCanUseMediaDevices();
    if (this.snapshot.status === 'capturing') return this.snapshot;
    this.updateSnapshot({ status: 'requesting-permission', error: null });
    let permissionStream: MediaStream | null = null;
    try {
      permissionStream = await this.mediaDevices!.getUserMedia(
        createBroadcasterAudioConstraints(this.snapshot.selectedDeviceId || undefined),
      );
      this.assertAudioOnlyStream(permissionStream);
      const devices = await this.listAudioInputDevices();
      this.stopStream(permissionStream);
      this.updateSnapshot({
        status: 'ready',
        devices,
        activeDeviceLabel: this.getActiveDeviceLabel(devices),
        audioTrackCount: 0,
        track: null,
        hasOwnedStream: false,
        error: null,
      });
      this.safeLog('permission-ready');
      return this.snapshot;
    } catch (error) {
      if (permissionStream) this.stopStream(permissionStream);
      throw this.applyError(normalizeBroadcasterCaptureError(error, this.snapshot.selectedDeviceId));
    }
  }

  async startCapture(): Promise<BroadcasterCaptureSnapshot> {
    this.assertCanUseMediaDevices();
    if (isBroadcasterCaptureActive(this.snapshot.status)) {
      throw this.rejectWithoutStateTransition(
        new BroadcasterCaptureError(
          'duplicate-capture',
          'A local broadcaster capture stream is already active.',
        ),
      );
    }
    if (this.snapshot.status !== 'ready' && this.snapshot.status !== 'stopped') {
      throw this.applyError(
        new BroadcasterCaptureError(
          'permission-denied',
          'Request programme audio permission before starting local capture.',
        ),
        this.snapshot.status === 'device-unavailable' ? 'device-unavailable' : 'permission-denied',
      );
    }

    this.updateSnapshot({ status: 'requesting-permission', error: null });
    let nextStream: MediaStream | null = null;
    try {
      nextStream = await this.mediaDevices!.getUserMedia(
        createBroadcasterAudioConstraints(this.snapshot.selectedDeviceId || undefined),
      );
      this.assertAudioOnlyStream(nextStream);
      this.replaceOwnedStream(nextStream);
      this.updateSnapshot({
        status: 'capturing',
        audioTrackCount: nextStream.getAudioTracks().length,
        track: this.trackMetadata(nextStream),
        hasOwnedStream: true,
        activeDeviceLabel: this.trackMetadata(nextStream)?.label ?? this.snapshot.activeDeviceLabel,
        error: null,
      });
      this.safeLog('capture-started');
      return this.snapshot;
    } catch (error) {
      if (nextStream) this.stopStream(nextStream);
      throw this.applyError(normalizeBroadcasterCaptureError(error, this.snapshot.selectedDeviceId));
    }
  }

  async stopCapture(reason = 'operator stopped local capture'): Promise<BroadcasterCaptureSnapshot> {
    if (this.snapshot.status === 'stopping') return this.snapshot;
    this.updateSnapshot({ status: 'stopping', error: null });
    try {
      this.releaseOwnedStream();
      this.updateSnapshot({
        status: 'stopped',
        audioTrackCount: 0,
        track: null,
        hasOwnedStream: false,
        activeDeviceLabel: this.getActiveDeviceLabel(this.snapshot.devices),
        error: null,
      });
      this.safeLog('capture-stopped', { reason });
      return this.snapshot;
    } catch (error) {
      throw this.applyError(normalizeCleanupError(error));
    }
  }

  async retry(): Promise<BroadcasterCaptureSnapshot> {
    await this.stopCapture('retry reset');
    this.updateSnapshot({ status: 'idle', error: null });
    return this.requestPermission();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.mediaDevices?.removeEventListener?.('devicechange', this.handleDeviceChange);
    await this.stopCapture('component teardown').catch((error: unknown) => {
      this.safeLog('capture-dispose-failed', {
        code: error instanceof BroadcasterCaptureError ? error.code : 'cleanup-failure',
      });
    });
  }

  async handleSignallingTeardown(reason: string): Promise<BroadcasterCaptureSnapshot> {
    if (!this.stream && !isBroadcasterCaptureActive(this.snapshot.status)) return this.snapshot;
    return this.stopCapture(reason);
  }

  private handleDeviceChange = (): void => {
    void this.refreshDevices().catch((error: unknown) => {
      this.applyError(normalizeBroadcasterCaptureError(error, this.snapshot.selectedDeviceId));
    });
  };

  private assertCanUseMediaDevices(): void {
    if (!this.isSecureContext) {
      throw this.applyError(
        new BroadcasterCaptureError(
          'insecure-context',
          'Browser programme audio capture requires HTTPS or localhost.',
          false,
        ),
        'failed',
      );
    }
    if (!this.mediaDevices?.getUserMedia) {
      throw this.applyError(
        new BroadcasterCaptureError(
          'media-api-unavailable',
          'This browser does not support programme audio capture.',
          false,
        ),
        'failed',
      );
    }
  }

  private async listAudioInputDevices(): Promise<BroadcasterAudioDevice[]> {
    if (!this.mediaDevices?.enumerateDevices) return [];
    const devices = await this.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Audio input ${index + 1}`,
      }));
  }

  private assertAudioOnlyStream(stream: MediaStream): void {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new BroadcasterCaptureError(
        'no-audio-input-device',
        'No programme audio input track was provided by the browser.',
      );
    }
    if (stream.getVideoTracks().length > 0) {
      throw new BroadcasterCaptureError(
        'browser-capture-failure',
        'Browser returned video tracks for an audio-only broadcaster capture request.',
        false,
      );
    }
  }

  private replaceOwnedStream(stream: MediaStream): void {
    this.releaseOwnedStream();
    this.stream = stream;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener?.('ended', this.handleTrackEnded);
      this.boundTracks.add(track);
    }
  }

  private releaseOwnedStream(): void {
    if (!this.stream && this.boundTracks.size === 0) return;
    for (const track of this.boundTracks) {
      track.removeEventListener?.('ended', this.handleTrackEnded);
    }
    this.boundTracks.clear();
    if (this.stream) {
      this.stopStream(this.stream);
      this.stream = null;
    }
  }

  private stopStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      if (track.readyState !== 'ended') track.stop();
    }
  }

  private handleTrackEnded = (): void => {
    this.releaseOwnedStream();
    this.applyError(
      new BroadcasterCaptureError(
        'track-ended',
        'Programme audio input ended unexpectedly.',
      ),
      'failed',
    );
  };

  private trackMetadata(stream: MediaStream): BroadcasterAudioTrackMetadata | null {
    const track = stream.getAudioTracks()[0];
    if (!track) return null;
    const settings = track.getSettings?.() ?? {};
    const safeSettings: BroadcasterAudioTrackMetadata['settings'] = {};
    if (settings.deviceId !== undefined) safeSettings.deviceId = settings.deviceId;
    if (settings.channelCount !== undefined) safeSettings.channelCount = settings.channelCount;
    if (settings.sampleRate !== undefined) safeSettings.sampleRate = settings.sampleRate;
    if (settings.echoCancellation !== undefined) {
      safeSettings.echoCancellation = settings.echoCancellation;
    }
    if (settings.noiseSuppression !== undefined) {
      safeSettings.noiseSuppression = settings.noiseSuppression;
    }
    if (settings.autoGainControl !== undefined) {
      safeSettings.autoGainControl = settings.autoGainControl;
    }
    return {
      label: track.label || 'Selected programme audio input',
      muted: track.muted,
      readyState: track.readyState,
      settings: safeSettings,
    };
  }

  private getActiveDeviceLabel(
    devices = this.snapshot.devices,
    selectedDeviceId = this.snapshot.selectedDeviceId,
  ): string {
    if (!selectedDeviceId) return devices[0]?.label ?? 'Browser default input';
    return devices.find((device) => device.deviceId === selectedDeviceId)?.label ?? 'Missing input';
  }

  private fail(
    status: BroadcasterCaptureStatus,
    error: BroadcasterCaptureError,
    devices = this.snapshot.devices,
  ): void {
    this.releaseOwnedStream();
    this.updateSnapshot({
      status,
      devices,
      audioTrackCount: 0,
      track: null,
      hasOwnedStream: false,
      activeDeviceLabel: this.getActiveDeviceLabel(devices),
      error: errorDetails(error),
    });
    this.safeLog('capture-failed', { code: error.code, status });
  }

  private applyError(
    error: BroadcasterCaptureError,
    status: BroadcasterCaptureStatus = statusForError(error),
  ): BroadcasterCaptureError {
    this.fail(status, error);
    return error;
  }

  private rejectWithoutStateTransition(error: BroadcasterCaptureError): BroadcasterCaptureError {
    this.updateSnapshot({ error: errorDetails(error) });
    this.safeLog('capture-action-rejected', { code: error.code });
    return error;
  }

  private updateSnapshot(next: Partial<BroadcasterCaptureSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...next,
      lastUpdatedAt: new Date().toISOString(),
    };
    this.onStateChange?.(this.snapshot);
  }

  private safeLog(
    event: string,
    metadata: Record<string, string | number | boolean | null> = {},
  ): void {
    this.onSafeLog?.(event, {
      status: this.snapshot.status,
      selectedDevice: this.snapshot.selectedDeviceId ? 'selected' : 'default',
      audioTrackCount: this.snapshot.audioTrackCount,
      ...metadata,
    });
  }
}

export function normalizeBroadcasterCaptureError(
  error: unknown,
  selectedDeviceId = '',
): BroadcasterCaptureError {
  if (error instanceof BroadcasterCaptureError) return error;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return new BroadcasterCaptureError(
        'permission-denied',
        'Programme audio permission denied.',
      );
    }
    if (error.name === 'NotFoundError') {
      return new BroadcasterCaptureError(
        selectedDeviceId ? 'requested-device-missing' : 'no-audio-input-device',
        selectedDeviceId
          ? 'Selected programme audio input is unavailable.'
          : 'No programme audio input device was found.',
      );
    }
    if (error.name === 'NotReadableError') {
      return new BroadcasterCaptureError(
        'device-busy',
        'Programme audio input is busy or unreadable.',
      );
    }
    if (error.name === 'OverconstrainedError') {
      return new BroadcasterCaptureError(
        'constraint-unsupported',
        'Selected programme audio constraints are not supported by this browser or device.',
      );
    }
    if (error.name === 'AbortError') {
      return new BroadcasterCaptureError(
        'permission-dismissed',
        'Programme audio permission request was dismissed or interrupted.',
      );
    }
    if (error.name === 'SecurityError') {
      return new BroadcasterCaptureError(
        'insecure-context',
        'Browser programme audio capture is blocked by the current security context.',
        false,
      );
    }
  }
  if (error instanceof Error) {
    return new BroadcasterCaptureError('stream-creation-failure', error.message);
  }
  return new BroadcasterCaptureError(
    'browser-capture-failure',
    'Browser programme audio capture failed.',
  );
}

function normalizeCleanupError(error: unknown): BroadcasterCaptureError {
  if (error instanceof BroadcasterCaptureError) return error;
  if (error instanceof Error) {
    return new BroadcasterCaptureError('cleanup-failure', error.message);
  }
  return new BroadcasterCaptureError('cleanup-failure', 'Programme audio cleanup failed.');
}

function statusForError(error: BroadcasterCaptureError): BroadcasterCaptureStatus {
  if (error.code === 'permission-denied' || error.code === 'permission-dismissed') {
    return 'permission-denied';
  }
  if (
    error.code === 'no-audio-input-device' ||
    error.code === 'requested-device-missing' ||
    error.code === 'device-busy' ||
    error.code === 'constraint-unsupported'
  ) {
    return 'device-unavailable';
  }
  return 'failed';
}

function errorDetails(error: BroadcasterCaptureError): BroadcasterCaptureErrorDetails {
  return {
    code: error.code,
    message: error.message,
    recoverable: RECOVERABLE_ERROR_CODES.has(error.code) && error.recoverable,
  };
}
