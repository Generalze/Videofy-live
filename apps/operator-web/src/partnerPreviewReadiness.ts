/** @author masterzee001 */
import type {
  MediaStateEvent,
  SourceLanguageControlMetadata,
  TargetLanguageCapability,
  TextToSpeechSessionMetadata,
  TranslationSessionMetadata,
} from '@videofy-live/shared-types';
import type { ProgrammeSourceSnapshot } from './programmeSourceManager';

export type ReadinessState = 'ready' | 'warning' | 'blocked';

export interface PartnerPreviewReadinessInput {
  gatewayConnected: boolean;
  mediaIngestHealthy: boolean;
  programmeSource: ProgrammeSourceSnapshot;
  mediaState: MediaStateEvent | null;
  sourceLanguageControl?: SourceLanguageControlMetadata | undefined;
  targetLanguageCatalogue?: TargetLanguageCapability[] | undefined;
  translation?: TranslationSessionMetadata | null | undefined;
  generatedAudio?: TextToSpeechSessionMetadata | null | undefined;
  selectedTargetLanguages: readonly string[];
  /** The console's source-language choice before a session exists (the control above replaces it once one does). */
  sourceLanguage?: string | undefined;
  sourceLanguageMode?: 'manual' | 'auto-detect' | undefined;
}

export interface PartnerPreviewReadinessItem {
  id: string;
  label: string;
  state: ReadinessState;
  detail: string;
}

export function shouldShowMockControls(mediaState: MediaStateEvent | null): boolean {
  return mediaState?.videoSource === 'mock';
}

export function buildPartnerPreviewReadiness(
  input: PartnerPreviewReadinessInput,
): PartnerPreviewReadinessItem[] {
  const voicedTargets = input.selectedTargetLanguages
    .map((code) => input.targetLanguageCatalogue?.find((target) => target.language === code))
    .filter((target): target is TargetLanguageCapability => target?.voiceAvailable === true);
  const sourceReady =
    input.programmeSource.status === 'broadcasting' ||
    input.programmeSource.status === 'paused' ||
    input.programmeSource.previewReady ||
    input.mediaState?.sourceAudioActive === true;

  return [
    {
      id: 'gateway',
      label: 'Gateway',
      state: input.gatewayConnected ? 'ready' : 'blocked',
      detail: input.gatewayConnected ? 'Connected' : 'Disconnected',
    },
    {
      id: 'ingest',
      label: 'Media ingest',
      state: input.mediaIngestHealthy ? 'ready' : 'blocked',
      detail: input.mediaIngestHealthy ? 'Healthy' : 'Unavailable',
    },
    {
      id: 'source',
      label: 'Programme source',
      state: sourceReady ? 'ready' : 'warning',
      detail: sourceReady
        ? describeProgrammeSource(input.programmeSource, input.mediaState)
        : 'Select a live, screen, OBS, capture-device, or uploaded-video source.',
    },
    {
      id: 'language',
      label: 'Source language',
      state:
        input.sourceLanguageControl?.status === 'locked' ||
        input.sourceLanguageControl?.status === 'confirmed' ||
        input.sourceLanguageControl?.status === 'manual' ||
        (input.sourceLanguageControl === undefined && input.sourceLanguageMode === 'manual')
          ? 'ready'
          : 'warning',
      detail: input.sourceLanguageControl
        ? `${input.sourceLanguageControl.activeLanguage.toUpperCase()} - ${input.sourceLanguageControl.status} - rev ${input.sourceLanguageControl.revision}`
        : input.sourceLanguageMode === 'manual'
          ? `${(input.sourceLanguage ?? 'en').toUpperCase()} - set by you`
          : `Auto-detect: decided from the programme audio once it runs (${(input.sourceLanguage ?? 'en').toUpperCase()} until then); confirm or lock it after detection.`,
    },
    {
      id: 'targets',
      label: 'Target languages',
      state: voicedTargets.length > 0 ? 'ready' : 'warning',
      detail:
        voicedTargets.length > 0
          ? voicedTargets.map((target) => `${target.label} - ${target.availability}`).join('; ')
          : input.selectedTargetLanguages.length === 0
            ? 'Add at least one target language on the Languages page.'
            : 'No selected target language has a voice available yet.',
    },
    {
      id: 'translation',
      label: 'Translation provider',
      /* Whatever engine the deployment routes to (OPUS-MT, a commercial vendor, a specialist): ready means it said so. */
      state:
        input.translation?.providerStatus === 'ready'
          ? 'ready'
          : input.translation?.providerStatus === 'failed'
            ? 'blocked'
            : 'warning',
      detail: input.translation?.providerName
        ? `${input.translation.providerName}:${input.translation.providerStatus ?? input.translation.status}`
        : 'Translation engine status appears after session start.',
    },
    {
      id: 'tts',
      label: 'Speech provider',
      state:
        input.generatedAudio?.providerStatus === 'ready'
          ? 'ready'
          : input.generatedAudio?.providerStatus === 'failed'
            ? 'blocked'
            : 'warning',
      detail: input.generatedAudio?.providerName
        ? `${input.generatedAudio.providerName}:${input.generatedAudio.providerStatus ?? input.generatedAudio.status}`
        : 'Speech engine status appears after session start.',
    },
    {
      id: 'listeners',
      label: 'Viewers',
      state: (input.mediaState?.connectedListeners ?? 0) > 0 ? 'ready' : 'warning',
      detail: `${input.mediaState?.connectedListeners ?? 0} connected`,
    },
  ];
}

function describeProgrammeSource(
  source: ProgrammeSourceSnapshot,
  mediaState: MediaStateEvent | null,
): string {
  if (source.sourceType === 'none' && mediaState?.sourceAudioActive) {
    return `media ingest - ${mediaState.videoSource} - audio active`;
  }
  if (source.sourceType === 'none') return 'No source selected';
  const video = source.videoDetected ? 'video' : 'no video';
  const audio = source.audioDetected ? 'audio' : 'no programme audio';
  return `${source.sourceType} - ${source.status} - ${audio} - ${video}`;
}

/**
 * May this programme go live?
 *
 * Preflight has always computed an honest answer and nothing has ever asked
 * it. Going live depended on the source being ready and no service warning
 * standing -- so a red line saying the gateway is unreachable sat beside a
 * button that still worked, and the page's own promise that "every line below
 * is the live state of a real service" was true and useless.
 *
 * `blocked` and `warning` already carry the distinction the ruling asks for.
 * A blocked item is a hard dependency: no gateway, no ingest, no broadcast. A
 * warning is a capability the programme may legitimately run without -- nobody
 * is watching yet, or no target language has a voice, which is captions-only
 * and a real way to broadcast. So warnings inform and blockers refuse.
 */
export interface PreflightVerdict {
  readonly canGoLive: boolean;
  /** The labels of every hard dependency that is not satisfied. */
  readonly blockedBy: readonly string[];
  /** One sentence for the button's tooltip, or null when nothing blocks. */
  readonly refusal: string | null;
}

export function preflightVerdict(
  items: readonly PartnerPreviewReadinessItem[],
): PreflightVerdict {
  const blocked = items.filter((item) => item.state === 'blocked');
  if (blocked.length === 0) return { canGoLive: true, blockedBy: [], refusal: null };
  const labels = blocked.map((item) => item.label);
  return {
    canGoLive: false,
    blockedBy: labels,
    refusal:
      labels.length === 1
        ? `Not ready: ${labels[0]}.`
        : `Not ready: ${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}.`,
  };
}
