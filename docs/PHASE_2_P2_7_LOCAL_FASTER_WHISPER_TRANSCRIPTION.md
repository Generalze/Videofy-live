# Phase 2 P2.7 - Local faster-whisper Transcription Provider

## Scope

P2.7 adds a local `faster-whisper` transcription provider behind the existing `TranscriptionProvider` interface.

## Implemented

- `TRANSCRIPTION_PROVIDER=faster-whisper` provider selection.
- Mock transcription provider remains available and remains the default.
- Configurable local provider settings:
  - `FASTER_WHISPER_PYTHON`
  - `FASTER_WHISPER_FFMPEG`
  - `FASTER_WHISPER_MODEL_SIZE`
  - `FASTER_WHISPER_DEVICE`
  - `FASTER_WHISPER_COMPUTE_TYPE`
  - `FASTER_WHISPER_MODEL_CACHE_DIR`
  - `FASTER_WHISPER_ALLOW_GPU_FALLBACK`
  - `TRANSCRIPTION_TIMEOUT_MS`
- Non-WAV microphone chunks are normalised through FFmpeg to mono 16 kHz PCM16 WAV before transcription.
- Existing upload WAV chunks are passed directly to faster-whisper.
- Transcription events can include `providerLatencyMs`.
- Clear errors for missing Python, missing FFmpeg, missing model/cache, timeout, provider failure and unavailable GPU support.
- GPU-to-CPU fallback is disabled by default and only allowed when explicitly configured.

## Provider Setup

Install Python dependencies outside npm:

```text
pip install faster-whisper
```

For CPU:

```text
TRANSCRIPTION_PROVIDER=faster-whisper
FASTER_WHISPER_MODEL_SIZE=small
FASTER_WHISPER_DEVICE=cpu
FASTER_WHISPER_COMPUTE_TYPE=int8
```

For GPU:

```text
TRANSCRIPTION_PROVIDER=faster-whisper
FASTER_WHISPER_DEVICE=cuda
FASTER_WHISPER_COMPUTE_TYPE=float16
FASTER_WHISPER_ALLOW_GPU_FALLBACK=false
```

## Preservation

- Phase 1 mock flow remains available.
- P2.1-P2.6 session, ingest, upload, microphone capture, monitoring, retry, ordering and export behaviour remain in place.
- No translation providers, synthetic speech, voice cloning, multiple target languages, plugins, public APIs, broadcasting or billing were added.

## Known Limitations

- Model download/cache management is delegated to `faster-whisper`.
- The provider runs one local Python process per transcription request.
- Confidence is derived from faster-whisper language probability when available.
