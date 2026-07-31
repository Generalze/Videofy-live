import type { MediaStateEvent } from '@videofy-live/shared-types';
import type { ProgrammeSourceSnapshot } from './programmeSourceManager';

export type OperatorSessionStatus = 'Ready' | 'Starting' | 'Live' | 'Completed' | 'Needs attention';

export interface OperatorWorkflowInput {
  connected: boolean;
  ingestHealthy: boolean;
  programmeSource: ProgrammeSourceSnapshot;
  mediaState: MediaStateEvent | null;
  streamStatus: string;
  starting: boolean;
  mediaError: string | null;
}

export interface OperatorWorkflowSummary {
  status: OperatorSessionStatus;
  actionableWarning: string | null;
  canStartInterpretation: boolean;
  canPause: boolean;
  canResume: boolean;
  canEnd: boolean;
  progressLabel: string;
}

export function buildOperatorWorkflowSummary(
  input: OperatorWorkflowInput,
): OperatorWorkflowSummary {
  const source = input.programmeSource;
  const sourceSelected = source.sourceType !== 'none';
  const sourceReady = source.previewReady && source.audioDetected && source.videoDetected;
  const activeError = input.mediaError ?? source.error?.message ?? null;
  const serviceWarning = !input.connected
    ? 'Realtime gateway is unavailable. Start the gateway before interpretation.'
    : !input.ingestHealthy
      ? 'Media ingest is unavailable. Start media ingest before interpretation.'
      : null;

  if (activeError || source.status === 'failed') {
    return {
      status: 'Needs attention',
      actionableWarning: activeError ?? 'Programme source failed. Select the source again.',
      canStartInterpretation: false,
      canPause: false,
      canResume: false,
      canEnd: sourceSelected,
      progressLabel: 'Needs attention',
    };
  }

  if (source.sourceType === 'uploaded-video' && source.status === 'ended') {
    return {
      status: 'Completed',
      actionableWarning: null,
      canStartInterpretation: false,
      canPause: false,
      canResume: false,
      canEnd: true,
      progressLabel: 'Completed',
    };
  }

  if (input.starting || source.status === 'selecting') {
    return {
      status: 'Starting',
      actionableWarning: null,
      canStartInterpretation: false,
      canPause: false,
      canResume: false,
      canEnd: sourceSelected,
      progressLabel: source.status === 'selecting' ? 'Validating source' : 'Starting interpretation',
    };
  }

  if (source.status === 'broadcasting' || input.streamStatus === 'processing') {
    return {
      status: 'Live',
      actionableWarning: null,
      canStartInterpretation: false,
      canPause: source.canPause && source.status === 'broadcasting',
      canResume: source.canResume && source.status === 'paused',
      canEnd: true,
      progressLabel: input.mediaState?.sourceAudioActive ? 'Programme audio active' : 'Waiting for programme audio',
    };
  }

  if (source.status === 'paused') {
    return {
      status: 'Live',
      actionableWarning: null,
      canStartInterpretation: false,
      canPause: false,
      canResume: source.canResume,
      canEnd: true,
      progressLabel: 'Paused',
    };
  }

  return {
    status: sourceReady && !serviceWarning ? 'Ready' : 'Needs attention',
    actionableWarning:
      serviceWarning ??
      (!sourceSelected
        ? 'Select an uploaded video, camera, screen, or OBS meeting source.'
        : !source.videoDetected
          ? 'Selected source does not have video.'
          : !source.audioDetected
            ? source.audioMissingReason ?? 'Selected source does not have programme audio.'
            : null),
    canStartInterpretation: Boolean(sourceReady && !serviceWarning),
    canPause: false,
    canResume: false,
    canEnd: sourceSelected,
    progressLabel: sourceReady ? 'Ready to start' : 'Waiting for source',
  };
}
