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
        input.sourceLanguageControl?.status === 'manual'
          ? 'ready'
          : 'warning',
      detail: input.sourceLanguageControl
        ? `${input.sourceLanguageControl.activeLanguage.toUpperCase()} - ${input.sourceLanguageControl.status} - rev ${input.sourceLanguageControl.revision}`
        : 'English is the default; confirm or lock after detection.',
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
      state:
        input.translation?.providerName === 'opus-mt' && input.translation.providerStatus === 'ready'
          ? 'ready'
          : input.translation?.providerStatus === 'failed'
            ? 'blocked'
            : 'warning',
      detail: input.translation?.providerName
        ? `${input.translation.providerName}:${input.translation.providerStatus ?? input.translation.status}`
        : 'OPUS-MT status appears after session start.',
    },
    {
      id: 'tts',
      label: 'Speech provider',
      state:
        input.generatedAudio?.providerName === 'piper' && input.generatedAudio.providerStatus === 'ready'
          ? 'ready'
          : input.generatedAudio?.providerStatus === 'failed'
            ? 'blocked'
            : 'warning',
      detail: input.generatedAudio?.providerName
        ? `${input.generatedAudio.providerName}:${input.generatedAudio.providerStatus ?? input.generatedAudio.status}`
        : 'Piper status appears after session start.',
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
