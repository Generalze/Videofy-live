// The enrollment state machine: capture → preview → upload.
//
// Kept out of the panel so the flow can be tested without React, and out of
// the capture class so the capture class stays about microphones. What lives
// here is the sequencing and the honesty about outcomes.
//
// One rule governs every path: no enrollment failure may prevent joining a
// call. Every method returns; nothing throws.
import {
  describeCaptureFailure,
  VoiceEnrollmentCapture,
  type EnrollmentRecording,
} from './voiceEnrollmentCapture';
import type { VoiceEnrollmentStage } from './VoiceEnrollmentPanel';

export interface EnrollmentUploadResult {
  /** True only when a real personal voice asset was produced. */
  personalVoiceReady: boolean;
  /** A human sentence, or null when there is nothing to say. */
  message: string | null;
}

export interface EnrollmentUploader {
  upload(input: {
    voiceProfileId: string;
    ownerId: string;
    blob: Blob;
    mimeType: string;
    enrolledLanguage: string;
  }): Promise<EnrollmentUploadResult | null>;
}

export interface EnrollmentFlowState {
  stage: VoiceEnrollmentStage;
  previewUrl: string | null;
  error: string | null;
  personalVoiceReady: boolean;
}

export const INITIAL_ENROLLMENT_STATE: EnrollmentFlowState = {
  stage: 'consent',
  previewUrl: null,
  error: null,
  personalVoiceReady: false,
};

export class VoiceEnrollmentFlow {
  private recording: EnrollmentRecording | null = null;

  constructor(
    private readonly capture: VoiceEnrollmentCapture,
    private readonly uploader: EnrollmentUploader,
    private readonly emit: (state: EnrollmentFlowState) => void,
  ) {}

  async startRecording(): Promise<void> {
    this.emit({ ...INITIAL_ENROLLMENT_STATE, stage: 'recording' });
    const started = await this.capture.start();
    if (!started.ok) {
      this.emit({
        ...INITIAL_ENROLLMENT_STATE,
        stage: 'consent',
        error: describeCaptureFailure(started.failure),
      });
    }
  }

  async stopRecording(): Promise<void> {
    const stopped = await this.capture.stop();
    if (!stopped.ok) {
      this.recording = null;
      this.emit({
        ...INITIAL_ENROLLMENT_STATE,
        stage: 'consent',
        error: describeCaptureFailure(stopped.failure),
      });
      return;
    }
    this.recording = stopped.recording;
    this.emit({
      stage: 'preview',
      previewUrl: stopped.recording.previewUrl,
      error: null,
      personalVoiceReady: false,
    });
  }

  /**
   * Send the recording.
   *
   * A successful upload does NOT imply a personal voice exists. Until a
   * cloning engine is validated the service accepts the recording and reports
   * that personal voice is unavailable, and this reports the same thing rather
   * than showing a success that would be a lie.
   */
  async accept(input: { voiceProfileId: string; ownerId: string; enrolledLanguage: string }): Promise<void> {
    const recording = this.recording;
    if (!recording) {
      this.emit({ ...INITIAL_ENROLLMENT_STATE, error: 'Nothing was recorded. Please try again.' });
      return;
    }

    this.emit({ stage: 'saving', previewUrl: recording.previewUrl, error: null, personalVoiceReady: false });
    const result = await this.uploader.upload({
      ...input,
      blob: recording.blob,
      mimeType: recording.mimeType,
    });

    if (!result) {
      this.emit({
        stage: 'preview',
        previewUrl: recording.previewUrl,
        error: 'Your voice could not be saved. Please try again.',
        personalVoiceReady: false,
      });
      return;
    }

    // The preview is released here: the recording now lives on the service.
    this.capture.teardown();
    this.recording = null;
    this.emit({
      stage: 'enrolled',
      previewUrl: null,
      error: result.message,
      personalVoiceReady: result.personalVoiceReady,
    });
  }

  /** Discard the current take without touching anything already accepted. */
  reRecord(): void {
    this.recording = null;
    this.capture.teardown();
    this.emit({ ...INITIAL_ENROLLMENT_STATE });
  }

  close(): void {
    this.recording = null;
    this.capture.teardown();
  }
}

/** Posts to the media-ingest enrollment endpoint. */
export function createEnrollmentUploader(ingestUrl: string): EnrollmentUploader {
  return {
    async upload({ voiceProfileId, ownerId, blob, mimeType, enrolledLanguage }) {
      try {
        const response = await fetch(
          `${ingestUrl}/voice-profiles/${encodeURIComponent(voiceProfileId)}/enrollment`,
          {
            method: 'POST',
            headers: {
              'content-type': mimeType,
              'x-videofy-voice-owner': ownerId,
              'x-videofy-enrolled-language': enrolledLanguage,
            },
            body: blob,
          },
        );
        const body = (await response.json().catch(() => ({}))) as {
          personalVoiceReady?: boolean;
          message?: string;
          error?: string;
        };
        if (!response.ok) {
          return { personalVoiceReady: false, message: body.error ?? 'Your voice could not be saved.' };
        }
        return {
          personalVoiceReady: body.personalVoiceReady === true,
          message: body.message ?? null,
        };
      } catch {
        // The network failing is not a reason to break the call the user came for.
        return null;
      }
    },
  };
}
