import type {
  MediaStateEvent,
  OperatorProgrammeSessionConfig,
  TimestampedTranslationEvent,
  TranscriptionEvent,
  WebRtcSignallingClientSnapshot,
} from '@videofy-live/shared-types';
import type { ProgrammeSourceSnapshot, ProgrammeSourceType } from './programmeSourceManager';

export interface ProgrammeSessionBinding {
  sessionId: string | null;
  broadcastId: string | null;
  sourceType: ProgrammeSourceType;
  sourceRevision: number;
  rtmpPlaybackUrl?: string | null;
  pending: boolean;
}

export interface ProgrammeLanguageSelection {
  targetLanguage: string;
  targetLanguages: string[];
  sourceLanguage: string;
  sourceLanguageMode: 'manual' | 'auto-detect';
}

export function createPendingProgrammeSessionBinding(
  source: ProgrammeSourceSnapshot,
): ProgrammeSessionBinding {
  return {
    sessionId: null,
    broadcastId: null,
    sourceType: source.sourceType,
    sourceRevision: source.revision,
    rtmpPlaybackUrl: source.rtmpPlaybackUrl,
    pending: true,
  };
}

export function createActiveProgrammeSessionBinding(
  signalling: WebRtcSignallingClientSnapshot,
  source: ProgrammeSourceSnapshot,
): ProgrammeSessionBinding {
  if (!signalling.sessionId) {
    throw new Error('A broadcaster signalling session is required before binding programme processing.');
  }
  return {
    sessionId: signalling.sessionId,
    broadcastId: signalling.broadcastId,
    sourceType: source.sourceType,
    sourceRevision: source.revision,
    rtmpPlaybackUrl: source.rtmpPlaybackUrl,
    pending: false,
  };
}

export function buildOperatorProgrammeSessionConfig(
  binding: ProgrammeSessionBinding,
  language: ProgrammeLanguageSelection,
): OperatorProgrammeSessionConfig {
  if (!binding.sessionId || !binding.broadcastId) {
    throw new Error('Programme processing session is not ready to configure.');
  }
  return {
    sessionId: binding.sessionId,
    broadcastId: binding.broadcastId,
    sourceRevision: binding.sourceRevision,
    programmeSourceType: binding.sourceType,
    ...(binding.sourceType === 'rtmp' && binding.rtmpPlaybackUrl
      ? { rtmpPlaybackUrl: binding.rtmpPlaybackUrl }
      : {}),
    targetLanguage: language.targetLanguage,
    targetLanguages: language.targetLanguages,
    sourceLanguage: language.sourceLanguage,
    sourceLanguageMode: language.sourceLanguageMode,
  };
}

export function shouldAcceptMediaStateForProgrammeBinding(
  state: MediaStateEvent,
  binding: ProgrammeSessionBinding | null,
): boolean {
  if (!binding) return true;
  if (!binding.sessionId) return false;
  return state.processingSessionId === binding.sessionId;
}

export function shouldAcceptProcessingEventForProgrammeBinding(
  event: TranscriptionEvent | TimestampedTranslationEvent,
  binding: ProgrammeSessionBinding | null,
): boolean {
  if (!binding) return true;
  if (!binding.sessionId) return false;
  return event.sessionId === binding.sessionId;
}
