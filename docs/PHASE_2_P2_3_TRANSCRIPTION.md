# Phase 2 P2.3 - Timestamped Transcription

## Scope

P2.3 adds timestamped transcription for P2.2 audio chunks. It consumes only chunks marked `ready` and produces ordered per-chunk transcription events.

## Implemented

- Transcription provider interface.
- Single configured provider: `mock`.
- Provider timeout handling.
- Per-chunk transcription states:
  - queued
  - transcribing
  - transcribed
  - failed
  - retrying
- Per-chunk transcript output:
  - session ID
  - chunk ID
  - sequence number
  - source text
  - detected language
  - start and end timestamps
  - confidence when available
  - status
- Ordered transcription processing by chunk index.
- Operator transcription event feed via gateway relay.
- Operator transcript status, progress, detected language, failures, retry controls, and export.
- Retry of failed chunks without restarting the full session.
- Completed transcript export as plain text.

## Preservation

- Phase 1 mock controls remain available.
- P2.1 media validation and session creation remain in place.
- P2.2 audio extraction and chunking remain in place.
- No translation, synthetic voice, microphone capture, live streaming, multiple providers, external plugins, or public APIs were added.

## Known Limitations

- The only configured provider is `mock`; it is an interface-backed placeholder for a future local provider.
- Transcript state remains in memory.
- Transcript export requires all ready chunks to be transcribed.
- Failed chunks must be retried individually.
