export const MICROPHONE_CHUNK_DURATION_MS = 15_000;

export type BrowserMicrophoneStatus =
  | 'idle'
  | 'requesting-permission'
  | 'capturing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'failed';

export class MicrophoneCaptureError extends Error {
  constructor(
    readonly code: 'permission-denied' | 'device-unavailable' | 'unsupported' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'MicrophoneCaptureError';
  }
}

export function createMicrophoneConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: deviceId
      ? {
          deviceId: { exact: deviceId },
        }
      : true,
  };
}

export function chooseRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
}

export async function requestMicrophoneStream(
  mediaDevices: MediaDevices | undefined,
  deviceId?: string,
): Promise<MediaStream> {
  if (!mediaDevices?.getUserMedia) {
    throw new MicrophoneCaptureError(
      'unsupported',
      'This browser does not support microphone capture.',
    );
  }

  try {
    return await mediaDevices.getUserMedia(createMicrophoneConstraints(deviceId));
  } catch (error) {
    throw normalizeMicrophoneError(error);
  }
}

export async function listMicrophoneDevices(
  mediaDevices: MediaDevices | undefined,
): Promise<MediaDeviceInfo[]> {
  if (!mediaDevices?.enumerateDevices) return [];
  const devices = await mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'audioinput');
}

export function isDuplicateCaptureStatus(status: BrowserMicrophoneStatus): boolean {
  return status === 'requesting-permission' || status === 'capturing' || status === 'paused';
}

function normalizeMicrophoneError(error: unknown): MicrophoneCaptureError {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return new MicrophoneCaptureError('permission-denied', 'Microphone permission denied.');
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return new MicrophoneCaptureError(
        'device-unavailable',
        'Selected microphone is unavailable.',
      );
    }
  }

  if (error instanceof Error) {
    return new MicrophoneCaptureError('unknown', error.message);
  }

  return new MicrophoneCaptureError('unknown', 'Microphone capture failed.');
}
