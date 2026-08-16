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

/**
 * The wording a speaker agreed to. Bumped whenever the consent text changes,
 * so a stored profile records which version it was granted under.
 */
export const VOICE_CONSENT_TEXT_VERSION = 'voice-consent-v1';

export interface EnrollmentUploadResult {
  /** True only when a real personal voice asset was produced. */
  personalVoiceReady: boolean;
  /** A human sentence, or null when there is nothing to say. */
  message: string | null;
}

/**
 * The consent transaction that must precede any recording.
 *
 * Separate from upload because the upload endpoint must never create a profile
 * on its own: letting audio arrival manufacture the permission to store audio
 * would be circular.
 */
export interface EnrollmentInitializer {
  begin(input: {
    ownerId: string;
    consentTextVersion: string;
    callUseGranted: boolean;
    trainingUseGranted: boolean;
  }): Promise<{ voiceProfileId: string } | null>;
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

  /** Set once the server has created the profile this recording belongs to. */
  private voiceProfileId: string | null = null;

  constructor(
    private readonly capture: VoiceEnrollmentCapture,
    private readonly uploader: EnrollmentUploader,
    private readonly emit: (state: EnrollmentFlowState) => void,
    private readonly initializer?: EnrollmentInitializer,
  ) {}

  /**
   * Create the profile and record consent, before any audio exists.
   *
   * Called when somebody affirmatively proceeds, never when the panel opens:
   * inspecting a screen must not manufacture a consent record.
   */
  async begin(input: {
    ownerId: string;
    consentTextVersion: string;
    trainingUseGranted: boolean;
  }): Promise<boolean> {
    if (!this.initializer) return false;
    const created = await this.initializer.begin({ ...input, callUseGranted: true });
    if (!created) {
      this.emit({
        ...INITIAL_ENROLLMENT_STATE,
        error: 'Enrollment could not be started. Please try again.',
      });
      return false;
    }
    this.voiceProfileId = created.voiceProfileId;
    return true;
  }

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
  async accept(input: { ownerId: string; enrolledLanguage: string }): Promise<void> {
    const recording = this.recording;
    const voiceProfileId = this.voiceProfileId;
    if (!voiceProfileId) {
      this.emit({
        ...INITIAL_ENROLLMENT_STATE,
        error: 'Enrollment could not be started. Please try again.',
      });
      return;
    }
    if (!recording) {
      this.emit({ ...INITIAL_ENROLLMENT_STATE, error: 'Nothing was recorded. Please try again.' });
      return;
    }

    this.emit({ stage: 'saving', previewUrl: recording.previewUrl, error: null, personalVoiceReady: false });
    const result = await this.uploader.upload({
      voiceProfileId,
      ownerId: input.ownerId,
      enrolledLanguage: input.enrolledLanguage,
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

/** Creates the profile and records consent before any audio is captured. */
export function createEnrollmentInitializer(ingestUrl: string): EnrollmentInitializer {
  return {
    async begin(input) {
      try {
        const response = await fetch(`${ingestUrl}/voice-profiles`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-videofy-voice-owner': input.ownerId,
          },
          body: JSON.stringify({
            consentTextVersion: input.consentTextVersion,
            callUseGranted: input.callUseGranted,
            trainingUseGranted: input.trainingUseGranted,
          }),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { voiceProfileId?: string };
        return body.voiceProfileId ? { voiceProfileId: body.voiceProfileId } : null;
      } catch {
        return null;
      }
    },
  };
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
