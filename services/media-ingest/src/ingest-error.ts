export type MediaIngestErrorCode =
  | 'audio-extraction-failed'
  | 'audio-timeline-invalid'
  | 'duplicate-processing'
  | 'duplicate-submission'
  | 'generated-audio-unavailable'
  | 'invalid-media'
  | 'invalid-transition'
  | 'microphone-device-disconnected'
  | 'source-media-unavailable'
  | 'unsafe-filename'
  | 'unsafe-path'
  | 'transcription-failed'
  | 'transcription-ffmpeg-unavailable'
  | 'transcription-gpu-unavailable'
  | 'transcription-model-unavailable'
  | 'transcription-python-unavailable'
  | 'transcription-timeout'
  | 'translation-failed'
  | 'translation-delayed'
  | 'translation-model-unavailable'
  | 'translation-python-unavailable'
  | 'translation-timeout'
  | 'stale-source-language'
  | 'tts-failed'
  | 'tts-ffmpeg-unavailable'
  | 'tts-model-unavailable'
  | 'tts-piper-unavailable'
  | 'tts-timeout'
  | 'unsupported-language'
  | 'unsupported-tts-language'
  | 'unsupported-tts-provider'
  | 'unsupported-tts-voice'
  | 'unsupported-transcription-provider'
  | 'unsupported-translation-provider'
  | 'viewer-ready-media-unavailable'
  | 'unsupported-extension'
  | 'unsupported-mime';

export class MediaIngestError<TSession = unknown> extends Error {
  constructor(
    message: string,
    readonly code: MediaIngestErrorCode,
    readonly statusCode: number,
    readonly session?: TSession,
  ) {
    super(message);
    this.name = 'MediaIngestError';
  }
}
