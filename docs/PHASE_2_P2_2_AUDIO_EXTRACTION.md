# Phase 2 P2.2 - Audio Extraction And Chunking

## Scope

P2.2 adds local audio extraction and deterministic chunk metadata for uploaded P2.1 media sessions.

## Implemented

- FFmpeg audio extraction from validated uploaded media.
- WAV output settings:
  - mono
  - 16 kHz
  - PCM 16-bit (`pcm_s16le`)
- Ordered 15-second audio chunks.
- Short final chunk support.
- Chunk metadata:
  - index
  - filename
  - start timestamp
  - end timestamp
  - duration
  - status
- Timeline validation for:
  - gaps
  - overlaps
  - wrong ordering
  - total duration mismatch
- Processing status persisted on in-memory sessions.
- Operator extraction status, chunk count, progress, errors, retry, and cleanup controls.
- Retry and cleanup endpoints for failed extraction.
- Unsafe uploaded filenames and unsafe chunk output paths are rejected.

## Preserved

- Phase 1 mock provider and operator controls remain available.
- P2.1 media validation, metadata extraction, stream IDs, and processing-session IDs remain in place.
- Gateway media-state broadcasting remains the operator/listener state path.

## Explicitly Not Implemented

- Microphone capture.
- Live streaming.
- Transcription.
- Translation.
- Synthetic voice generation.
- External plugins or APIs.

## Known Limitations

- Session and chunk metadata remain in memory.
- Cleanup removes generated audio chunks, not the original uploaded source file, so failed sessions can be retried.
- FFmpeg and ffprobe must be available on PATH.
- Extraction progress is stage-based, not FFmpeg frame-progress based.
