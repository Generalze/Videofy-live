import { describe, expect, it, vi } from 'vitest';
import {
  VoiceEnrollmentFlow,
  type EnrollmentInitializer,
  type EnrollmentUploader,
  type EnrollmentFlowState,
} from './voiceEnrollmentFlow';
import {
  VoiceEnrollmentCapture,
  type CaptureEnvironment,
  type MediaRecorderLike,
} from './voiceEnrollmentCapture';

function captureEnvironment(overrides: Partial<CaptureEnvironment> = {}): CaptureEnvironment {
  const track = () => ({ stop: () => undefined });
  return {
    getUserMedia: async () => ({ getTracks: () => [track()] }) as unknown as MediaStream,
    isTypeSupported: () => true,
    createRecorder: () => {
      const recorder: MediaRecorderLike = {
        mimeType: 'audio/webm',
        ondataavailable: null,
        onstop: null,
        onerror: null,
        start: () =>
          queueMicrotask(() => recorder.ondataavailable?.({ data: new Blob(['x']) })),
        stop: () => queueMicrotask(() => recorder.onstop?.()),
      };
      return recorder;
    },
    createObjectURL: () => 'blob:preview',
    revokeObjectURL: () => undefined,
    ...overrides,
  };
}

function createFlow(
  uploader: EnrollmentUploader,
  environment = captureEnvironment(),
  initializer: EnrollmentInitializer = {
    begin: async () => ({ voiceProfileId: 'vp1' }),
  },
): { flow: VoiceEnrollmentFlow; states: EnrollmentFlowState[] } {
  const states: EnrollmentFlowState[] = [];
  const flow = new VoiceEnrollmentFlow(
    new VoiceEnrollmentCapture(environment),
    uploader,
    (state) => states.push(state),
    initializer,
  );
  return { flow, states };
}

const BEGIN_INPUT = {
  token: 'session-token',
  consentTextVersion: 'voice-consent-v1',
  trainingUseGranted: false,
};

const ACCEPT_INPUT = {
  token: 'session-token',
  enrolledLanguage: 'en',
};

describe('a saved recording is not a personal voice', () => {
  it('reports personal voice unavailable even though the upload succeeded', async () => {
    // The distinction that keeps this honest. Until a cloning engine exists
    // the service accepts the recording and says so; showing "enrolled, all
    // done" would be a lie the user only discovers by hearing a stranger.
    const uploader: EnrollmentUploader = {
      upload: vi.fn(async () => ({
        personalVoiceReady: false,
        message: 'Your recording was saved. Personal voice is not available yet.',
      })),
    };
    const { flow, states } = createFlow(uploader);

    await flow.begin(BEGIN_INPUT);
    await flow.startRecording();
    await flow.stopRecording();
    await flow.accept(ACCEPT_INPUT);

    const final = states.at(-1);
    expect(final?.stage).toBe('enrolled');
    expect(final?.personalVoiceReady).toBe(false);
    expect(final?.error).toContain('not available yet');
  });

  it('reports readiness only when the service confirms a real asset', async () => {
    const uploader: EnrollmentUploader = {
      upload: vi.fn(async () => ({ personalVoiceReady: true, message: null })),
    };
    const { flow, states } = createFlow(uploader);

    await flow.begin(BEGIN_INPUT);
    await flow.startRecording();
    await flow.stopRecording();
    await flow.accept(ACCEPT_INPUT);

    expect(states.at(-1)?.personalVoiceReady).toBe(true);
  });
});

describe('nothing here can prevent joining a call', () => {
  it('surfaces a blocked microphone as a sentence and returns to consent', async () => {
    const environment = captureEnvironment({
      getUserMedia: async () => {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      },
    });
    const { flow, states } = createFlow({ upload: vi.fn() }, environment);

    await flow.startRecording();

    expect(states.at(-1)?.stage).toBe('consent');
    expect(states.at(-1)?.error).toContain('Microphone access was blocked');
  });

  it('keeps the take when the upload fails, so nothing is lost', async () => {
    // Losing the recording on a network blip would mean recording again for no
    // reason the user can see.
    const { flow, states } = createFlow({ upload: vi.fn(async () => null) });

    await flow.begin(BEGIN_INPUT);
    await flow.startRecording();
    await flow.stopRecording();
    await flow.accept(ACCEPT_INPUT);

    const final = states.at(-1);
    expect(final?.stage).toBe('preview');
    expect(final?.previewUrl).toBe('blob:preview');
    expect(final?.error).toContain('could not be saved');
  });

  it('does not upload when there is nothing recorded', async () => {
    // Consent given and the profile created, but the speaker accepted without
    // ever recording. Distinct from never having started enrollment at all.
    const upload = vi.fn();
    const { flow, states } = createFlow({ upload });
    await flow.begin(BEGIN_INPUT);

    await flow.accept(ACCEPT_INPUT);

    expect(upload).not.toHaveBeenCalled();
    expect(states.at(-1)?.error).toContain('Nothing was recorded');
  });
});

describe('re-recording', () => {
  it('discards the current take and returns to the start', async () => {
    const { flow, states } = createFlow({ upload: vi.fn() });
    await flow.begin(BEGIN_INPUT);
    await flow.startRecording();
    await flow.stopRecording();

    flow.reRecord();

    expect(states.at(-1)?.stage).toBe('consent');
    expect(states.at(-1)?.previewUrl).toBeNull();
  });

  it('does not upload a discarded take afterwards', async () => {
    const upload = vi.fn();
    const { flow } = createFlow({ upload });
    await flow.begin(BEGIN_INPUT);
    await flow.startRecording();
    await flow.stopRecording();

    flow.reRecord();
    await flow.accept(ACCEPT_INPUT);

    expect(upload).not.toHaveBeenCalled();
  });
});

describe('what is sent', () => {
  it('sends the owner identity and the recorded bytes, nothing more', async () => {
    const sentPayloads: { blob: Blob }[] = [];
    const upload = vi.fn(async (input: { blob: Blob }) => {
      sentPayloads.push(input);
      return { personalVoiceReady: false, message: null };
    });
    const { flow } = createFlow({ upload });

    await flow.begin(BEGIN_INPUT);
    await flow.startRecording();
    await flow.stopRecording();
    await flow.accept(ACCEPT_INPUT);

    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceProfileId: 'vp1',
        token: 'session-token',
        enrolledLanguage: 'en',
        mimeType: 'audio/webm',
      }),
    );
    expect(sentPayloads[0]?.blob.size).toBeGreaterThan(0);
  });
});

describe('consent is recorded before any audio exists', () => {
  it('refuses to upload when the profile was never created', async () => {
    // Without this, audio would be posted for a profile the server never
    // consented to hold — which is the 409 that proved Step A was not yet
    // functionally complete.
    const upload = vi.fn();
    const { flow, states } = createFlow({ upload });

    await flow.startRecording();
    await flow.stopRecording();
    await flow.accept(ACCEPT_INPUT);

    expect(upload).not.toHaveBeenCalled();
    expect(states.at(-1)?.error).toContain('could not be started');
  });

  it('sends call-use consent and passes training through unchanged', async () => {
    const begin = vi.fn(async () => ({ voiceProfileId: 'vp1' }));
    const { flow } = createFlow({ upload: vi.fn() }, captureEnvironment(), { begin });

    await flow.begin({ ...BEGIN_INPUT, trainingUseGranted: true });

    expect(begin).toHaveBeenCalledWith({
      token: 'session-token',
      consentTextVersion: 'voice-consent-v1',
      callUseGranted: true,
      trainingUseGranted: true,
    });
  });

  it('reports a failed start rather than proceeding to record', async () => {
    const { flow, states } = createFlow({ upload: vi.fn() }, captureEnvironment(), {
      begin: async () => null,
    });

    expect(await flow.begin(BEGIN_INPUT)).toBe(false);
    expect(states.at(-1)?.error).toContain('could not be started');
  });
});
