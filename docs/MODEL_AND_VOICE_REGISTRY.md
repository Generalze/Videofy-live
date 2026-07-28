# Model And Voice Registry

Date: 2026-07-28

This registry documents local open-source AI assets approved or proposed for partner-preview validation. A target is not production-ready until the model, voice, licence, runtime, quality, and partner constraints have been validated on the demonstration machine.

Local validation on 2026-07-28 used FFmpeg 8.1.2, Python 3.11.9 in `.venv-ai`, Piper 1.2.0, and an NVIDIA GeForce RTX 5060 Laptop GPU. Model, voice, generated media, and browser evidence are stored only in ignored local paths.

## Validated P5.2 Path

| Provider | Model or voice | Language | Version or revision | Licence evidence | Commercial review | Local path or cache | Hardware | Quality status | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Silero VAD | `silero-vad` | speech activity | package `6.2.1` | package metadata and upstream review required before production | reviewable | `.venv-ai` package cache | CPU | detected 2 speech regions in deterministic P5.2 WAV | validated |
| faster-whisper | `Systran/faster-whisper-small.en` | English ASR | revision `d1d751a5f8271d482d14ca55d9e2deeebbae577f` | local model card: MIT | reviewable | `services/media-ingest/model_cache/faster-whisper/.../d1d751a5f8271d482d14ca55d9e2deeebbae577f` | CPU int8, CUDA float16 | CPU and GPU transcription validated | validated |
| OPUS-MT | `Helsinki-NLP/opus-mt-en-es` | English to Spanish | revision `5bc4493d463cf000c1f0b50f8d56886a392ed4ab` | local model card: Apache-2.0 | reviewable | `services/media-ingest/model_cache/opus-mt/.../5bc4493d463cf000c1f0b50f8d56886a392ed4ab` | CPU | real translation validated | validated |
| Piper | `es_ES-sharvard-medium` | Spanish TTS | voice config `piper_version` 1.0.0; runtime 1.2.0 | upstream `rhasspy/piper-voices`: MIT; local config has no embedded licence file | reviewable | `services/media-ingest/model_cache/piper/es_ES-sharvard-medium` | CPU | real speech generation and listener playback validated | validated |

## Proposed Or Blocked Targets

| Provider | Model or voice | Language | Licence evidence | Commercial review | Local path or cache | Status |
| --- | --- | --- | --- | --- | --- | --- |
| OPUS-MT | `Helsinki-NLP/opus-mt-en-fr` | English to French | model-dependent | pending | not validated in P5.2 | proposed |
| OPUS-MT | `Helsinki-NLP/opus-mt-en-ROMANCE` | English to Portuguese | model-dependent | pending | not validated in P5.2 | proposed |
| OPUS-MT | Yoruba candidate | English to Yoruba | model-dependent | pending | not selected | blocked |
| Piper | French voice candidate | French | voice-dependent | pending | not selected | blocked |
| Piper | Portuguese voice candidate | Portuguese | voice-dependent | pending | not selected | blocked |
| Piper | Yoruba voice candidate | Yoruba | voice-dependent | pending | not selected | blocked |

## Local Asset Sizes

- `Systran/faster-whisper-small.en`: 486,102,512 bytes.
- `Helsinki-NLP/opus-mt-en-es`: 937,838,339 bytes.
- Piper `es_ES-sharvard-medium`: 76,738,518 bytes.
- Piper Windows binary directory: 38,846,222 bytes.

## Rules

- No model download may occur during an active session unless the operator explicitly prepared models before the session.
- Mock providers remain for tests only.
- GPU mode must fail clearly if CUDA support is unavailable unless fallback is explicitly configured.
- Do not silently fall back from real providers to mocks.
- Raw audio, transcripts that contain private user content, SDP, ICE, credentials, and local model secrets must not be logged.
- Generated audio, browser evidence, model files, voice files, and local virtual environments stay ignored.
