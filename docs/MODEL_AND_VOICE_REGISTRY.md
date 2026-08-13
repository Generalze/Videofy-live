# Model And Voice Registry

Date: 2026-07-28

This registry documents local open-source AI assets approved or proposed for partner-preview validation. A target is not production-ready until the model, voice, licence, runtime, quality, and partner constraints have been validated on the demonstration machine.

Local validation on 2026-07-28 used FFmpeg 8.1.2, Python 3.11.9 in `.venv-ai`, Piper 1.2.0, and an NVIDIA GeForce RTX 5060 Laptop GPU. Model, voice, generated media, and browser evidence are stored only in ignored local paths.

## Validated P5.2-P5.3 Path

| Provider | Model or voice | Language | Version or revision | Licence evidence | Commercial review | Local path or cache | Hardware | Quality status | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Silero VAD | `silero-vad` | speech activity | package `6.2.1` | package metadata and upstream review required before production | reviewable | `.venv-ai` package cache | CPU | detected 2 speech regions in deterministic P5.2 WAV | validated |
| faster-whisper | `Systran/faster-whisper-small.en` | English ASR | revision `d1d751a5f8271d482d14ca55d9e2deeebbae577f` | local model card: MIT | reviewable | `services/media-ingest/model_cache/faster-whisper/.../d1d751a5f8271d482d14ca55d9e2deeebbae577f` | CPU int8, CUDA float16 | CPU and GPU transcription validated | validated |
| OPUS-MT | `Helsinki-NLP/opus-mt-en-es` | English to Spanish | revision `5bc4493d463cf000c1f0b50f8d56886a392ed4ab` | local model card: Apache-2.0 | reviewable | `services/media-ingest/model_cache/opus-mt/.../5bc4493d463cf000c1f0b50f8d56886a392ed4ab` | CPU | real translation validated | validated |
| Piper | `es_ES-sharvard-medium` | Spanish TTS | voice config `piper_version` 1.0.0; runtime 1.2.0 | upstream `rhasspy/piper-voices`: MIT; local config has no embedded licence file | reviewable | `services/media-ingest/model_cache/piper/es_ES-sharvard-medium` | CPU | real speech generation and listener playback validated | validated |

## P5.3 Quality Review Status

The English-to-Spanish technical path remains validated for local Chrome partner-preview use.

Latest P5.3 evidence:

- faster-whisper transcript confidence: `1` on the deterministic English validation WAV.
- OPUS-MT translated the deterministic English sentence to Spanish with provider latency `4485 ms` in the browser run.
- Piper generated Spanish listener audio with provider latency `845 ms` in the browser run.
- Listener playback succeeded with 3 audio play calls and 0 audio play failures.

Human review remains pending for:

- Nigerian-accented English.
- Names.
- Numbers and dates.
- Meeting or presentation language.
- Difficult or noisy audio.
- Commercial voice and translation quality approval.

Final P5.3 acceptance did not complete those human-review items because no human reviewer or approved physical audio samples were available in the Codex environment.

## Multi-Voice Configuration

Multiple Piper voices can now be configured simultaneously via `PIPER_VOICES`
(comma-separated entries of `language|voiceId|modelPath[|configPath]`; fields
are pipe-separated because Windows paths contain colons). Per-voice prosody and
sample-rate overrides go in `PIPER_VOICE_SETTINGS` (JSON keyed by voiceId:
`lengthScale`, `noiseScale`, `noiseW`, `sentenceSilence`, `sampleRateHz`).
When `PIPER_VOICES` is set, the supported TTS language list is derived from the
configured voices; the legacy `PIPER_VOICE_ID`/`PIPER_MODEL_PATH` vars remain a
single-voice fallback. Use forward slashes in Windows paths inside `.env`.

As of 2026-08-08 the local machine has Piper voices for es
(`es_ES-sharvard-medium`), fr (`fr_FR-siwis-medium`), pt (`pt_BR-faber-medium`),
ar (`ar_JO-kareem-medium`), zh (`zh_CN-huayan-medium`), ru
(`ru_RU-irina-medium`), and el (`el_GR-rapunzelina-low` — the only open Greek
voice, low-quality tier), with OPUS-MT models for en->es/fr/ar/zh/ru/el plus
`opus-mt-en-ROMANCE` serving pt and la (multi-target models get the `>>lang<<`
control token automatically). The fallback chain
`TRANSLATION_FALLBACK_PROVIDER=nllb200` routes pairs OPUS-MT cannot serve
(en->yo) through `facebook/nllb-200-distilled-600M`, which replaced M2M100 after
side-by-side testing showed M2M100's Yoruba degenerating into repetition while
NLLB produced fluent tonal Yoruba. `TEXT_TO_SPEECH_PROVIDER=piper+mms` covers yo
(`facebook/mms-tts-yor`) and la (`facebook/mms-tts-lat`). **Licence caution:
NLLB-200 and all MMS voices are CC-BY-NC-4.0 (non-commercial) — review before
any commercial deployment.** All generation is repetition-hardened
(`no_repeat_ngram_size=3`; beams on the multilingual models). Generated audio is kept at the voice's native sample rate
(default 22 050 Hz), loudness-normalised (`loudnorm I=-19`), and time-compressed
(max 1.25×) only when a clip overruns its segment window. Adding a spoken
language now requires only downloading a voice model and adding one
`PIPER_VOICES` entry.

## Proposed Or Blocked Targets

| Provider | Model or voice | Language | Licence evidence | Commercial review | Local path or cache | Status |
| --- | --- | --- | --- | --- | --- | --- |
| OPUS-MT | `Helsinki-NLP/opus-mt-en-fr` | English to French | model-dependent | pending | not validated in P5.2 | proposed |
| OPUS-MT | `Helsinki-NLP/opus-mt-en-ROMANCE` | English to Portuguese | model-dependent | pending | not validated in P5.2 | proposed |
| M2M100 | `facebook/m2m100_418M` | English to Spanish, French, Portuguese, Yoruba and Chinese | MIT model card | reviewable | runtime support implemented; local model and quality validation pending | proposed |
| Local model | Latin candidate | English to Latin | no approved model selected | pending | unsupported and hidden from selectable outputs | blocked |
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
