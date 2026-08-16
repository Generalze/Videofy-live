/** @owner masterzee001 */
/**
 * What the viewer is told when something is wrong.
 *
 * The rule this module exists to enforce: a viewer is told what it means for
 * them, in their own terms, and whether they can keep watching. They are never
 * shown the machinery. "Spanish audio is temporarily unavailable. Captions
 * will continue." is the whole message; the synthesis worker, the provider id
 * and the revision counter that produced it belong in diagnostics.
 *
 * `programmeContinues` is the part that matters most. Most failures in this
 * product are partial — translated audio dies while video, original audio and
 * captions carry on — and a viewer who is not told that will assume the whole
 * thing broke and close the tab.
 */
import { viewerLanguageLabel } from './listenerLanguageSelection';
import type { TargetLanguageOutputStatus } from '@videofy-live/shared-types';

export type ViewerStatusTone = 'info' | 'warn' | 'danger';

export interface ViewerStatus {
  tone: ViewerStatusTone;
  message: string;
  /** Whether there is still something worth watching. */
  programmeContinues: boolean;
}

export type ViewerConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface ViewerStatusInput {
  connectionStatus: ViewerConnectionStatus;
  /** The language the viewer chose, or `null` when watching the original. */
  targetLanguage: string | null;
  languageOutputStatus: TargetLanguageOutputStatus | null;
  buffering: boolean;
  /** A failure from the audio mixer or synthesis queue, in engineering terms. */
  audioFailure: boolean;
  programmeCompleted: boolean;
}

/**
 * The single most important message, or `null` when nothing needs saying.
 *
 * Deliberately one message rather than a list. A viewer reading three
 * simultaneous status lines is being asked to triage, which is the job this
 * function is supposed to have done for them.
 */
export function resolveViewerStatus(input: ViewerStatusInput): ViewerStatus | null {
  // Connection first: when the stream is gone, nothing downstream of it is
  // worth reporting, and reporting it anyway would be misleading.
  if (input.connectionStatus === 'error' || input.connectionStatus === 'disconnected') {
    return {
      tone: 'warn',
      message: 'Reconnecting to the programme…',
      programmeContinues: false,
    };
  }
  if (input.connectionStatus === 'connecting' || input.connectionStatus === 'idle') {
    return { tone: 'info', message: 'Connecting to the programme…', programmeContinues: false };
  }

  if (input.programmeCompleted) {
    return { tone: 'info', message: 'This programme has ended.', programmeContinues: false };
  }

  const language = input.targetLanguage ? viewerLanguageLabel(input.targetLanguage) : null;

  // A viewer watching the original has no translation to fail, so translation
  // status must not be reported to them at all.
  if (language) {
    switch (input.languageOutputStatus) {
      case 'failed':
        return {
          tone: 'warn',
          message: `${language} audio is temporarily unavailable. Captions will continue.`,
          programmeContinues: true,
        };
      case 'unavailable':
        return {
          tone: 'warn',
          message: `${language} is not available for this programme.`,
          programmeContinues: true,
        };
      case 'captions-ready':
        return {
          tone: 'info',
          message: `${language} captions are ready. Translated audio is still starting.`,
          programmeContinues: true,
        };
      case 'translating':
        return {
          tone: 'info',
          message: `Preparing ${language} captions…`,
          programmeContinues: true,
        };
      case 'generating-audio':
        return {
          tone: 'info',
          message: `Preparing ${language} audio…`,
          programmeContinues: true,
        };
      default:
        break;
    }
  }

  // Reported after translation state, because a viewer whose language failed
  // needs to hear about the language, not about a buffer.
  if (input.audioFailure) {
    return {
      tone: 'warn',
      message: language
        ? `${language} audio stopped. Video and captions will continue.`
        : 'Audio stopped. Video will continue.',
      programmeContinues: true,
    };
  }

  if (input.buffering) {
    return { tone: 'info', message: 'Buffering…', programmeContinues: true };
  }

  return null;
}
