# Phase 2 P2.8 - Real Translation Provider

## Scope

P2.8 adds one real local translation provider behind the existing timestamped translation interface.

## Implemented

- `TRANSLATION_PROVIDER=argos` provider selection.
- Mock translation provider remains available and remains the default.
- Local Argos Translate provider using Python `argostranslate`.
- Per-session target language is passed to the provider for every segment.
- Source text, source language, target language, sequence, timestamps, retries and latency are preserved.
- Empty source text returns an empty translation without invoking Python.
- Clear errors for unsupported language, timeout, missing Python/package and provider failure.
- No silent fallback from Argos to mock translation.
- Translation session metadata includes provider name and provider status for operator monitoring.
- Translation export remains unchanged.

## Configuration

```text
TRANSLATION_PROVIDER=argos
TRANSLATION_TIMEOUT_MS=30000
TRANSLATION_SUPPORTED_TARGET_LANGUAGES=fr,es,de,pt,it,ja,zh,ar
ARGOS_TRANSLATE_PYTHON=python
ARGOS_TRANSLATE_PACKAGE_DIR=
```

Install Python dependencies and Argos language packages outside npm:

```text
pip install argostranslate
```

## Preservation

- Phase 1 mock flow remains available.
- P2.1-P2.7 upload ingest, microphone capture, transcription, retry, monitoring and exports remain in place.
- No text-to-speech, synthetic voice, voice cloning, multiple target languages, plugins, public APIs, broadcasting or billing were added.

## Known Limitations

- Argos package installation and language-pair availability are managed outside npm.
- The provider runs one local Python process per segment translation.
- Unsupported installed language pairs fail clearly instead of falling back.
