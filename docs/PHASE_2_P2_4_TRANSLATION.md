# Phase 2 P2.4 - Timestamped Translation

## Scope

P2.4 adds timestamped translation for P2.3 transcription segments. It consumes only segments marked `transcribed` and produces ordered per-segment translation events.

## Implemented

- Translation provider interface.
- Single configured provider: `mock`.
- Operator-selected target language per uploaded media session.
- Provider timeout handling.
- Per-segment translation states:
  - queued
  - translating
  - translated
  - failed
  - retrying
- Per-segment translation output:
  - session ID
  - segment ID
  - sequence number
  - source language
  - target language
  - source text
  - translated text
  - start and end timestamps
  - status
  - latency
- Ordered translation processing by transcription sequence.
- Timestamped translation events relayed through the gateway to operators.
- Operator translation status, progress, failures, latency, retry controls, and export.
- Retry of failed translation segments without restarting the full session.
- Paired source and translated text export as plain text.
- Unsupported target languages rejected clearly before session processing starts.

## Preservation

- Phase 1 mock controls and phrase log remain available.
- P2.1 media validation and session creation remain in place.
- P2.2 audio extraction and chunking remain in place.
- P2.3 timestamped transcription and transcript export remain in place.
- No synthetic voice, multiple target languages, microphone capture, live streaming, external plugins, public APIs, or real partner integrations were added.

## Known Limitations

- The only configured provider is `mock`; it is an interface-backed placeholder for a future local provider.
- Translation state remains in memory.
- Translation export requires all transcribed segments to be translated.
- Failed segments must be retried individually.
