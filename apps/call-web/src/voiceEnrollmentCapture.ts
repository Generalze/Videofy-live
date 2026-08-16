// Microphone capture for personal-voice enrollment.
//
// Two resources here leak silently and are easy to get wrong:
//
//   * a MediaStream track left running keeps the browser's recording indicator
//     lit long after enrollment is finished, which reads to a user as "this
//     site is still listening to me" — and for a feature about handing over
//     your voice, that is close to the worst possible impression;
//   * an object URL created for preview pins the recorded blob in memory until
//     the page is discarded, and re-recording a few times quietly accumulates
//     them.
//
// So every exit path — accept, re-record, close, error, permission denied —
// goes through the same teardown, and the teardown is safe to call twice.
//
// Failures are returned, never thrown. No enrollment problem may prevent
// somebody joining a call.

export type EnrollmentCaptureFailure =
  | 'permission-denied'
  | 'no-microphone'
  | 'recording-unsupported'
  | 'capture-interrupted'
  | 'nothing-recorded';

export interface EnrollmentRecording {
  readonly blob: Blob;
  readonly previewUrl: string;
  readonly mimeType: string;
}

/** A human sentence for each failure. The user is never shown the code. */
export function describeCaptureFailure(failure: EnrollmentCaptureFailure): string {
  switch (failure) {
    case 'permission-denied':
      return 'Microphone access was blocked. Allow it in your browser to record your voice.';
    case 'no-microphone':
      return 'No microphone was found. Connect one and try again.';
    case 'recording-unsupported':
      return 'This browser cannot record audio. Try Chrome or Edge.';
    case 'capture-interrupted':
      return 'The recording stopped unexpectedly. Please try again.';
    case 'nothing-recorded':
      return 'Nothing was recorded. Please try again.';
    default:
      return 'Your voice could not be recorded. Please try again.';
  }
}

/** Narrow surface so tests do not need a browser. */
export interface CaptureEnvironment {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createRecorder(stream: MediaStream, mimeType: string | undefined): MediaRecorderLike;
  isTypeSupported(mimeType: string): boolean;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface MediaRecorderLike {
  start(timesliceMs?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  readonly mimeType: string;
}

/** Preferred first; the browser picks the first it actually supports. */
const CANDIDATE_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export function defaultCaptureEnvironment(): CaptureEnvironment | null {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof MediaRecorder === 'undefined'
  ) {
    return null;
  }
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createRecorder: (stream, mimeType) =>
      new MediaRecorder(stream, mimeType ? { mimeType } : undefined) as unknown as MediaRecorderLike,
    isTypeSupported: (mimeType) => MediaRecorder.isTypeSupported(mimeType),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
}

/**
 * One enrollment capture, from microphone to a previewable recording.
 *
 * Deliberately a small state machine rather than a hook: the lifecycle is the
 * part worth testing, and it should not require React to exercise.
 */
export class VoiceEnrollmentCapture {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorderLike | null = null;
  private chunks: Blob[] = [];
  private previewUrl: string | null = null;

  constructor(private readonly environment: CaptureEnvironment | null) {}

  /** Begin recording, or report why it could not start. */
  async start(): Promise<{ ok: true } | { ok: false; failure: EnrollmentCaptureFailure }> {
    if (!this.environment) return { ok: false, failure: 'recording-unsupported' };
    // A previous attempt must not survive into this one.
    this.teardown();

    try {
      this.stream = await this.environment.getUserMedia({ audio: true });
    } catch (error) {
      return { ok: false, failure: classifyGetUserMediaError(error) };
    }

    const mimeType = CANDIDATE_MIME_TYPES.find((candidate) =>
      this.environment?.isTypeSupported(candidate),
    );

    try {
      this.recorder = this.environment.createRecorder(this.stream, mimeType);
    } catch {
      this.teardown();
      return { ok: false, failure: 'recording-unsupported' };
    }

    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start();
    return { ok: true };
  }

  /**
   * Stop and produce the recording.
   *
   * The microphone is released as soon as the recorder stops, not when the
   * panel closes: holding it through preview would leave the browser's
   * recording indicator lit while somebody listens back.
   */
  async stop(): Promise<
    { ok: true; recording: EnrollmentRecording } | { ok: false; failure: EnrollmentCaptureFailure }
  > {
    const recorder = this.recorder;
    const environment = this.environment;
    if (!recorder || !environment) return { ok: false, failure: 'capture-interrupted' };

    const mimeType = recorder.mimeType || 'audio/webm';
    const stopped = await new Promise<boolean>((resolve) => {
      recorder.onstop = () => resolve(true);
      recorder.onerror = () => resolve(false);
      try {
        recorder.stop();
      } catch {
        resolve(false);
      }
    });

    this.releaseMicrophone();
    this.recorder = null;

    if (!stopped) {
      this.chunks = [];
      return { ok: false, failure: 'capture-interrupted' };
    }
    if (this.chunks.length === 0) return { ok: false, failure: 'nothing-recorded' };

    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];
    if (blob.size === 0) return { ok: false, failure: 'nothing-recorded' };

    // Any previous preview URL is released before a new one replaces it.
    this.releasePreview();
    this.previewUrl = environment.createObjectURL(blob);
    return { ok: true, recording: { blob, previewUrl: this.previewUrl, mimeType } };
  }

  /** Release everything. Safe to call repeatedly and from any state. */
  teardown(): void {
    this.releaseMicrophone();
    this.releasePreview();
    this.recorder = null;
    this.chunks = [];
  }

  private releaseMicrophone(): void {
    this.stream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // A track that refuses to stop is not worth failing enrollment over.
      }
    });
    this.stream = null;
  }

  private releasePreview(): void {
    if (this.previewUrl && this.environment) {
      this.environment.revokeObjectURL(this.previewUrl);
    }
    this.previewUrl = null;
  }
}

function classifyGetUserMediaError(error: unknown): EnrollmentCaptureFailure {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-microphone';
  return 'capture-interrupted';
}
