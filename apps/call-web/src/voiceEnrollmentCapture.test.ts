import { describe, expect, it } from 'vitest';
import {
  describeCaptureFailure,
  VoiceEnrollmentCapture,
  type CaptureEnvironment,
  type MediaRecorderLike,
} from './voiceEnrollmentCapture';

interface Harness {
  environment: CaptureEnvironment;
  stoppedTracks: number;
  revokedUrls: string[];
  recorder: MediaRecorderLike | null;
}

function createHarness(overrides: Partial<CaptureEnvironment> = {}): Harness {
  const harness: Harness = {
    stoppedTracks: 0,
    revokedUrls: [],
    recorder: null,
    environment: undefined as unknown as CaptureEnvironment,
  };
  let urlSerial = 0;

  const track = () => ({
    stop: () => {
      harness.stoppedTracks += 1;
    },
  });

  harness.environment = {
    getUserMedia: async () =>
      ({ getTracks: () => [track(), track()] }) as unknown as MediaStream,
    isTypeSupported: () => true,
    createRecorder: () => {
      const recorder: MediaRecorderLike = {
        mimeType: 'audio/webm;codecs=opus',
        ondataavailable: null,
        onstop: null,
        onerror: null,
        start: () => {
          // Deliver one chunk the way a real recorder does.
          queueMicrotask(() =>
            recorder.ondataavailable?.({ data: new Blob(['abc'], { type: 'audio/webm' }) }),
          );
        },
        stop: () => queueMicrotask(() => recorder.onstop?.()),
      };
      harness.recorder = recorder;
      return recorder;
    },
    createObjectURL: () => `blob:preview-${++urlSerial}`,
    revokeObjectURL: (url) => {
      harness.revokedUrls.push(url);
    },
    ...overrides,
  };
  return harness;
}

describe('microphone lifecycle', () => {
  it('releases the microphone as soon as recording stops, not when the panel closes', async () => {
    // A track left running keeps the browser recording indicator lit while the
    // user listens back — for a feature about handing over your voice, close to
    // the worst possible impression.
    const harness = createHarness();
    const capture = new VoiceEnrollmentCapture(harness.environment);

    await capture.start();
    expect(harness.stoppedTracks).toBe(0);
    await capture.stop();

    expect(harness.stoppedTracks).toBe(2);
  });

  it('does not leak a microphone when a second recording starts', async () => {
    const harness = createHarness();
    const capture = new VoiceEnrollmentCapture(harness.environment);

    await capture.start();
    await capture.start();

    // The first stream was released when the second attempt began.
    expect(harness.stoppedTracks).toBe(2);
  });

  it('is safe to tear down repeatedly and from any state', async () => {
    const harness = createHarness();
    const capture = new VoiceEnrollmentCapture(harness.environment);

    expect(() => capture.teardown()).not.toThrow();
    await capture.start();
    capture.teardown();
    expect(() => capture.teardown()).not.toThrow();
  });
});

describe('preview URLs', () => {
  it('revokes the previous preview before creating another', async () => {
    // Re-recording a few times otherwise accumulates pinned blobs.
    const harness = createHarness();
    const capture = new VoiceEnrollmentCapture(harness.environment);

    await capture.start();
    const first = await capture.stop();
    await capture.start();
    await capture.stop();

    expect(first.ok && harness.revokedUrls).toContain('blob:preview-1');
  });

  it('revokes the preview on teardown', async () => {
    const harness = createHarness();
    const capture = new VoiceEnrollmentCapture(harness.environment);
    await capture.start();
    await capture.stop();

    capture.teardown();

    expect(harness.revokedUrls).toContain('blob:preview-1');
  });
});

describe('failures are returned, never thrown', () => {
  it('reports a blocked microphone as permission denied', async () => {
    const harness = createHarness({
      getUserMedia: async () => {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      },
    });
    const capture = new VoiceEnrollmentCapture(harness.environment);

    const result = await capture.start();

    expect(result).toEqual({ ok: false, failure: 'permission-denied' });
  });

  it('reports a missing microphone distinctly from a blocked one', async () => {
    const harness = createHarness({
      getUserMedia: async () => {
        throw Object.assign(new Error('none'), { name: 'NotFoundError' });
      },
    });

    expect(await new VoiceEnrollmentCapture(harness.environment).start()).toEqual({
      ok: false,
      failure: 'no-microphone',
    });
  });

  it('reports an unsupported browser without a recorder', async () => {
    expect(await new VoiceEnrollmentCapture(null).start()).toEqual({
      ok: false,
      failure: 'recording-unsupported',
    });
  });

  it('releases the microphone when the recorder itself will not start', async () => {
    const harness = createHarness({
      createRecorder: () => {
        throw new Error('no recorder');
      },
    });
    const capture = new VoiceEnrollmentCapture(harness.environment);

    const result = await capture.start();

    expect(result).toEqual({ ok: false, failure: 'recording-unsupported' });
    expect(harness.stoppedTracks).toBe(2);
  });

  it('reports an interrupted capture and keeps nothing', async () => {
    const harness = createHarness();
    harness.environment.createRecorder = () => {
      const recorder: MediaRecorderLike = {
        mimeType: 'audio/webm',
        ondataavailable: null,
        onstop: null,
        onerror: null,
        start: () => undefined,
        stop: () => queueMicrotask(() => recorder.onerror?.(new Error('interrupted'))),
      };
      return recorder;
    };
    const capture = new VoiceEnrollmentCapture(harness.environment);
    await capture.start();

    expect(await capture.stop()).toEqual({ ok: false, failure: 'capture-interrupted' });
    expect(harness.stoppedTracks).toBe(2);
  });

  it('reports a silent capture rather than storing an empty recording', async () => {
    const harness = createHarness();
    harness.environment.createRecorder = () => {
      const recorder: MediaRecorderLike = {
        mimeType: 'audio/webm',
        ondataavailable: null,
        onstop: null,
        onerror: null,
        start: () => undefined,
        stop: () => queueMicrotask(() => recorder.onstop?.()),
      };
      return recorder;
    };
    const capture = new VoiceEnrollmentCapture(harness.environment);
    await capture.start();

    expect(await capture.stop()).toEqual({ ok: false, failure: 'nothing-recorded' });
  });

  it('reports stopping when nothing was ever started', async () => {
    const capture = new VoiceEnrollmentCapture(createHarness().environment);

    expect(await capture.stop()).toEqual({ ok: false, failure: 'capture-interrupted' });
  });
});

describe('describeCaptureFailure', () => {
  it('gives a human sentence and never the failure code', () => {
    expect(describeCaptureFailure('permission-denied')).toContain('Microphone access was blocked');
    expect(describeCaptureFailure('no-microphone')).not.toContain('no-microphone');
  });
});

describe('successful capture', () => {
  it('returns a previewable recording', async () => {
    const harness = createHarness();
    const capture = new VoiceEnrollmentCapture(harness.environment);

    await capture.start();
    const result = await capture.stop();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recording.previewUrl).toBe('blob:preview-1');
    expect(result.recording.blob.size).toBeGreaterThan(0);
    expect(result.recording.mimeType).toContain('audio/webm');
  });
});
