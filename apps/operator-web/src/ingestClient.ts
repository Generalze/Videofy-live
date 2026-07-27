import type {
  AudioExtractionMetadata,
  MediaFileMetadata,
  MicrophoneCaptureMetadata,
  SessionMonitoringMetadata,
  StreamStatus,
  TextToSpeechSessionMetadata,
  TranslationSessionMetadata,
  TranscriptionSessionMetadata,
} from '@videofy-live/shared-types';

export interface ProcessingSessionDto {
  id: string;
  streamId: string;
  state: StreamStatus;
  sourceKind: 'upload' | 'microphone';
  media: MediaFileMetadata | null;
  audioExtraction: AudioExtractionMetadata;
  microphoneCapture: MicrophoneCaptureMetadata;
  transcription: TranscriptionSessionMetadata;
  translation: TranslationSessionMetadata;
  generatedAudio: TextToSpeechSessionMetadata;
  monitoring: SessionMonitoringMetadata;
  targetLanguage: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export class IngestClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'IngestClientError';
  }
}

export async function createProcessingSession(
  ingestUrl: string,
  file: File,
  targetLanguage?: string,
): Promise<ProcessingSessionDto> {
  const body = new FormData();
  body.append('media', file);
  if (targetLanguage) {
    body.append('targetLanguage', targetLanguage);
  }

  const response = await fetch(`${ingestUrl.replace(/\/$/, '')}/sessions`, {
    method: 'POST',
    body,
  });

  const payload = (await response.json().catch(() => null)) as {
    session?: ProcessingSessionDto;
    error?: string;
    code?: string;
  } | null;

  if (!response.ok) {
    throw new IngestClientError(
      payload?.error ?? `Media ingest failed with HTTP ${response.status}.`,
      response.status,
      payload?.code,
    );
  }

  if (!payload?.session) {
    throw new IngestClientError(
      'Media ingest returned an invalid session response.',
      response.status,
    );
  }

  return payload.session;
}

export async function createMicrophoneSession(
  ingestUrl: string,
  input: { deviceId?: string; deviceLabel?: string; targetLanguage?: string },
): Promise<ProcessingSessionDto> {
  const response = await fetch(`${ingestUrl.replace(/\/$/, '')}/microphone/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  return await readSessionResponse(response);
}

export async function sendMicrophoneChunk(
  ingestUrl: string,
  sessionId: string,
  input: {
    blob: Blob;
    sequence: number;
    startMs: number;
    endMs: number;
  },
): Promise<ProcessingSessionDto> {
  const body = new FormData();
  body.append('audio', input.blob, `mic-chunk-${String(input.sequence).padStart(6, '0')}.webm`);
  body.append('sequence', String(input.sequence));
  body.append('startMs', String(input.startMs));
  body.append('endMs', String(input.endMs));

  const response = await fetch(
    `${ingestUrl.replace(/\/$/, '')}/microphone/sessions/${encodeURIComponent(sessionId)}/chunks`,
    {
      method: 'POST',
      body,
    },
  );

  return await readSessionResponse(response);
}

export async function stopMicrophoneSession(
  ingestUrl: string,
  sessionId: string,
): Promise<ProcessingSessionDto> {
  return await sendSessionCommand(
    ingestUrl,
    `/microphone/sessions/${encodeURIComponent(sessionId)}/stop`,
    'POST',
  );
}

export async function reportMicrophoneDeviceDisconnected(
  ingestUrl: string,
  sessionId: string,
): Promise<ProcessingSessionDto> {
  return await sendSessionCommand(
    ingestUrl,
    `/microphone/sessions/${encodeURIComponent(sessionId)}/device-disconnected`,
    'POST',
  );
}

export async function retryAudioExtraction(
  ingestUrl: string,
  sessionId: string,
): Promise<ProcessingSessionDto> {
  return await sendSessionCommand(
    ingestUrl,
    `/sessions/${encodeURIComponent(sessionId)}/audio/retry`,
    'POST',
  );
}

export async function cleanupFailedAudio(
  ingestUrl: string,
  sessionId: string,
): Promise<ProcessingSessionDto> {
  return await sendSessionCommand(
    ingestUrl,
    `/sessions/${encodeURIComponent(sessionId)}/audio`,
    'DELETE',
  );
}

export async function pauseProcessingSession(
  ingestUrl: string,
  sessionId: string,
): Promise<ProcessingSessionDto> {
  return await sendSessionCommand(
    ingestUrl,
    `/sessions/${encodeURIComponent(sessionId)}/pause`,
    'POST',
  );
}

export async function resumeProcessingSession(
  ingestUrl: string,
  sessionId: string,
): Promise<ProcessingSessionDto> {
  return await sendSessionCommand(
    ingestUrl,
    `/sessions/${encodeURIComponent(sessionId)}/resume`,
    'POST',
  );
}

export async function cancelProcessingSession(
  ingestUrl: string,
  sessionId: string,
): Promise<ProcessingSessionDto> {
  return await sendSessionCommand(
    ingestUrl,
    `/sessions/${encodeURIComponent(sessionId)}/cancel`,
    'POST',
  );
}

export async function retryTranscriptionChunk(
  ingestUrl: string,
  sessionId: string,
  chunkId: string,
): Promise<ProcessingSessionDto> {
  return await sendSessionCommand(
    ingestUrl,
    `/sessions/${encodeURIComponent(sessionId)}/transcription/chunks/${encodeURIComponent(chunkId)}/retry`,
    'POST',
  );
}

export async function exportTranscript(ingestUrl: string, sessionId: string): Promise<string> {
  const response = await fetch(
    `${ingestUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}/transcript`,
  );

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    throw new IngestClientError(
      payload?.error ?? `Transcript export failed with HTTP ${response.status}.`,
      response.status,
      payload?.code,
    );
  }

  return await response.text();
}

export async function retryTranslationSegment(
  ingestUrl: string,
  sessionId: string,
  segmentId: string,
): Promise<ProcessingSessionDto> {
  return await sendSessionCommand(
    ingestUrl,
    `/sessions/${encodeURIComponent(sessionId)}/translation/segments/${encodeURIComponent(segmentId)}/retry`,
    'POST',
  );
}

export async function exportPairedTranslation(
  ingestUrl: string,
  sessionId: string,
): Promise<string> {
  const response = await fetch(
    `${ingestUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}/translation/export`,
  );

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
    } | null;
    throw new IngestClientError(
      payload?.error ?? `Translation export failed with HTTP ${response.status}.`,
      response.status,
      payload?.code,
    );
  }

  return await response.text();
}

export async function retryGeneratedAudioSegment(
  ingestUrl: string,
  sessionId: string,
  segmentId: string,
): Promise<ProcessingSessionDto> {
  return await sendSessionCommand(
    ingestUrl,
    `/sessions/${encodeURIComponent(sessionId)}/generated-audio/segments/${encodeURIComponent(segmentId)}/retry`,
    'POST',
  );
}

async function sendSessionCommand(
  ingestUrl: string,
  path: string,
  method: 'DELETE' | 'POST',
): Promise<ProcessingSessionDto> {
  const response = await fetch(`${ingestUrl.replace(/\/$/, '')}${path}`, { method });
  return await readSessionResponse(response);
}

async function readSessionResponse(response: Response): Promise<ProcessingSessionDto> {
  const payload = (await response.json().catch(() => null)) as {
    session?: ProcessingSessionDto;
    error?: string;
    code?: string;
  } | null;

  if (!response.ok) {
    throw new IngestClientError(
      payload?.error ?? `Media ingest failed with HTTP ${response.status}.`,
      response.status,
      payload?.code,
    );
  }

  if (!payload?.session) {
    throw new IngestClientError(
      'Media ingest returned an invalid session response.',
      response.status,
    );
  }

  return payload.session;
}
