# Phase 3 P3.1 - Local Piper Text-to-Speech Foundation

## Status

P3.1 complete.

Validation date: 2026-07-27

## Scope

- Added a text-to-speech provider interface with `mock` and `piper` implementations.
- Generated one WAV file per translated segment.
- Stored generated audio under the existing session processing directory: `<outputBaseDir>/<sessionId>/tts/tts-000000.wav`.
- Preserved session ID, segment ID, sequence, target language, start/end timestamps, provider latency and generation status.
- Added retry for failed generated-audio segments.
- Added generated-audio progress, provider status and failures to operator monitoring.
- Listener audio delivery, sync, mixing, HLS and WebRTC remain out of scope.

## Piper Setup

Environment variables:

```text
TEXT_TO_SPEECH_PROVIDER=piper
TEXT_TO_SPEECH_TIMEOUT_MS=30000
TEXT_TO_SPEECH_SUPPORTED_LANGUAGES=fr
TEXT_TO_SPEECH_DEFAULT_VOICE_ID=fr-default
PIPER_EXECUTABLE=piper
PIPER_VOICE_ID=fr-default
PIPER_VOICE_LANGUAGE=fr
PIPER_MODEL_PATH=../../models/piper/model.onnx
PIPER_CONFIG_PATH=
```

The mock provider remains the default for tests and local development without Piper.

## Voice And Model Configuration

- P3.1 supports one configured Piper voice.
- Voice selection is server-side: `TEXT_TO_SPEECH_DEFAULT_VOICE_ID`.
- The configured voice language must match the session target language.
- Missing Piper executable, missing model/config file, unsupported voice and unsupported language fail explicitly.

## Generated Format

- Container: WAV
- Codec expectation: PCM 16-bit WAV output from Piper
- File naming: `tts-000000.wav`, ordered by translated segment sequence

## Tests

Added provider and session coverage for:

- Mock preservation
- Successful Piper generation
- Timestamp and sequence preservation
- Unsupported language or voice
- Missing Piper executable/model
- Timeout
- Provider failure
- Retry
- Duplicate prevention
- Cleanup of failed partial output
- No silent fallback

## Known Limitations

- No listener delivery yet.
- No browser audio queue integration yet.
- No audio/video timestamp alignment yet.
- No interpretation or replacement mixing yet.
- P3.1 supports one configured Piper voice, not a voice catalog.

## Next Milestone

P3.2: generated audio file delivery to listener.
