import { describe, expect, it } from 'vitest';
import {
  createMicrophoneConstraints,
  isDuplicateCaptureStatus,
  listMicrophoneDevices,
  MicrophoneCaptureError,
  requestMicrophoneStream,
} from './microphoneCapture';

describe('browser microphone capture helpers', () => {
  it('requests microphone permission with the selected device', async () => {
    const stream = {} as MediaStream;
    const mediaDevices = {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        expect(constraints).toEqual({
          audio: {
            deviceId: { exact: 'device-1' },
          },
        });
        return stream;
      },
    } as MediaDevices;

    await expect(requestMicrophoneStream(mediaDevices, 'device-1')).resolves.toBe(stream);
  });

  it('reports permission denial clearly', async () => {
    const mediaDevices = {
      getUserMedia: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    } as unknown as MediaDevices;

    await expect(requestMicrophoneStream(mediaDevices)).rejects.toMatchObject({
      name: 'MicrophoneCaptureError',
      code: 'permission-denied',
      message: 'Microphone permission denied.',
    });
  });

  it('reports unsupported browser capture clearly', async () => {
    await expect(requestMicrophoneStream(undefined)).rejects.toBeInstanceOf(
      MicrophoneCaptureError,
    );
  });

  it('lists only audio input devices', async () => {
    const mediaDevices = {
      enumerateDevices: async () =>
        [
          { kind: 'audioinput', deviceId: 'mic-1', label: 'Desk mic' },
          { kind: 'videoinput', deviceId: 'cam-1', label: 'Camera' },
        ] as MediaDeviceInfo[],
    } as MediaDevices;

    await expect(listMicrophoneDevices(mediaDevices)).resolves.toEqual([
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Desk mic' },
    ]);
  });

  it('builds default constraints and duplicate capture guards', () => {
    expect(createMicrophoneConstraints()).toEqual({ audio: true });
    expect(isDuplicateCaptureStatus('requesting-permission')).toBe(true);
    expect(isDuplicateCaptureStatus('capturing')).toBe(true);
    expect(isDuplicateCaptureStatus('paused')).toBe(true);
    expect(isDuplicateCaptureStatus('stopped')).toBe(false);
  });
});
