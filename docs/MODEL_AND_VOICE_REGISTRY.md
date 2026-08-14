# Model And Voice Registry

Repository owner: masterzee001

Date: 2026-07-28

## P6-G0 Authority and Readiness Meaning

This document is the human-readable evidence catalogue. The machine-readable policy contract and
current classifications live in `services/ai-registry/src/registry.ts`. A row marked `validated`
below records development/demo evidence only; it does **not** imply
`commercialUseState=approved` or `productionApproved=true`.

NLLB-200 and MMS-TTS remain `blocked-noncommercial`. Existing Piper voice records do not yet carry
verified Male/Female and per-voice rights metadata, so no language is currently declared fully
voice-ready. The active runtime remains `development-demo` until an explicit later integration
milestone enforces a commercially approved complete provider chain. Media-ingest rejects every
other profile at startup during P6-G0, so an environment label cannot imply commercial readiness.

This registry documents local open-source AI assets approved or proposed for partner-preview validation. A target is not production-ready until the model, voice, licence, runtime, quality, and partner constraints have been validated on the demonstration machine.

Local validation on 2026-07-28 used FFmpeg 8.1.2, Python 3.11.9 in `.venv-ai`, Piper 1.2.0, and an NVIDIA GeForce RTX 5060 Laptop GPU. Model, voice, generated media, and browser evidence are stored only in ignored local paths.

## Validated P5.2-P5.3 Path

| Provider       | Model or voice                    | Language           | Version or revision                                 | Licence evidence                                                                | Commercial review | Local path or cache                                                                             | Hardware               | Quality status                                         | Status    |
| -------------- | --------------------------------- | ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------ | --------- |
| Silero VAD     | `silero-vad`                      | speech activity    | package `6.2.1`                                     | package metadata and upstream review required before production                 | reviewable        | `.venv-ai` package cache                                                                        | CPU                    | detected 2 speech regions in deterministic P5.2 WAV    | validated |
| faster-whisper | `Systran/faster-whisper-small.en` | English ASR        | revision `d1d751a5f8271d482d14ca55d9e2deeebbae577f` | local model card: MIT                                                           | reviewable        | `services/media-ingest/model_cache/faster-whisper/.../d1d751a5f8271d482d14ca55d9e2deeebbae577f` | CPU int8, CUDA float16 | CPU and GPU transcription validated                    | validated |
| OPUS-MT        | `Helsinki-NLP/opus-mt-en-es`      | English to Spanish | revision `5bc4493d463cf000c1f0b50f8d56886a392ed4ab` | local model card: Apache-2.0                                                    | reviewable        | `services/media-ingest/model_cache/opus-mt/.../5bc4493d463cf000c1f0b50f8d56886a392ed4ab`        | CPU                    | real translation validated                             | validated |
| Piper          | `es_ES-sharvard-medium`           | Spanish TTS        | voice config `piper_version` 1.0.0; runtime 1.2.0   | upstream `rhasspy/piper-voices`: MIT; local config has no embedded licence file | reviewable        | `services/media-ingest/model_cache/piper/es_ES-sharvard-medium`                                 | CPU                    | real speech generation and listener playback validated | validated |

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

## P6.1A Development Provider Validation

Validated 2026-08-14 on the demonstration machine (Windows 11, CPU int8 inference,
FFmpeg 8.1.2, Python 3.11 in `.venv-ai`, Piper 1.2.0). This section is the evidence target of
`services/ai-registry/src/registry.ts` entries marked
`docs/MODEL_AND_VOICE_REGISTRY.md#p61a-development-provider-validation`. All results are
development/demo evidence under `AI_RUNTIME_PROFILE=development-demo`; nothing here claims
commercial approval, production readiness, or full voice-ready status.

| Provider | Model or voice | Capability | Version / revision | Licence | Commercial state | Result |
| --- | --- | --- | --- | --- | --- | --- |
| faster-whisper | `Systran/faster-whisper-small` (multilingual) | STT en+es | `536b0662742c02347bc0e980a01041f333bce120` | MIT | review-required | EN and ES synthetic phrases transcribed exactly; correct language detected for both |
| OPUS-MT | `Helsinki-NLP/opus-mt-es-en` | Translation es→en | `c96e2c5399ebfae4fc43d9669556b9afa74bb69d` | Apache-2.0 | review-required | "Hola, buenos días." → "Hello, good morning." |
| OPUS-MT | `Helsinki-NLP/opus-mt-en-es` | Translation en→es | `5bc4493d463cf000c1f0b50f8d56886a392ed4ab` | Apache-2.0 | review-required | "Hello, good morning." → "Hola, buenos días." |
| Piper | `en_US-hfc_male-medium` | English TTS, Male | `sha256:d11e403a02bdf5a670c877b3dc56e0e1c8cece6fb30289586314dffdc0a78cb0` | CC-BY-NC-SA-4.0 | **blocked-noncommercial** | Real WAV generated and normalized |
| Piper | `en_US-hfc_female-medium` | English TTS, Female | `sha256:914c473788fc1fa8b63ace1cdcdb44588f4ae523d3ab37df1536616835a140b7` | CC-BY-NC-SA-4.0 | **blocked-noncommercial** | Real WAV generated and normalized |
| Piper | `es_ES-sharvard-medium` speaker 0 (`M`) | Spanish TTS, Male | `sha256:40febfb1679c69a4505ff311dc136e121e3419a13a290ef264fdf43ddedd0fb1` | CC-BY-3.0 | review-required | Real WAV generated; `--speaker 0` proven at the CLI |
| Piper | `es_ES-sharvard-medium` speaker 1 (`F`) | Spanish TTS, Female | same model hash | CC-BY-3.0 | review-required | Real WAV generated; `--speaker 1` proven at the CLI |

Measured provider latencies on this run (CPU, including persistent-worker cold start; measurements,
not guarantees): Piper 509–568 ms per clip; OPUS-MT 4 867 ms (en→es) and 5 735 ms (es→en);
faster-whisper 5 459 ms (en) and 6 720 ms (es).

Reproduce with `RUN_P6_1A_REAL_PROVIDER_TESTS=true` via
`services/media-ingest/src/__tests__/p6-1a-real-providers.test.ts`; generated audio and the
evidence JSON stay in ignored local paths (`P6_1A_EVIDENCE_DIR` or the OS temp directory).

### French validation (EN–FR constant development pair)

By owner decision on 2026-08-14, **English–French is the constant development pair** (French
verifiers are easier to source than Spanish); Spanish remains supported with its evidence above.
The same gated acceptance run now also proves, on the same machine and profile:

| Provider | Model or voice | Capability | Version / revision | Licence | Commercial state | Result |
| --- | --- | --- | --- | --- | --- | --- |
| faster-whisper | `Systran/faster-whisper-small` | STT fr | `536b0662742c02347bc0e980a01041f333bce120` | MIT | review-required | "Bonjour, ceci est un test en français." transcribed exactly; `fr` detected |
| OPUS-MT | `Helsinki-NLP/opus-mt-en-fr` | Translation en→fr | `dd7f6540a7a48a7f4db59e5c0b9c42c8eea67f18` | Apache-2.0 | review-required | "Hello, good morning." → "Bonjour." |
| OPUS-MT | `Helsinki-NLP/opus-mt-fr-en` | Translation fr→en | `c4aed37b318c763fd177aa449b44e3b783cc6c02` | Apache-2.0 | review-required | "Bonjour, bonne journée." → "Good morning, good day." |
| Piper | `fr_FR-upmc-medium` speaker 1 (`pierre`) | French TTS, Male | `sha256:9abb3800c199148897a9ed64e100d224f3de83579f100044174ad19418f1786f` | CC-BY-SA-4.0 | review-required | Real WAV generated; `--speaker 1` proven at the CLI |
| Piper | `fr_FR-siwis-medium` | French TTS, Female | `sha256:641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99` | CC-BY-4.0 | review-required | Real WAV generated (single speaker, no `--speaker` flag) |

Rejected candidate: `fr_FR-tom-medium` was downloaded, its MODEL_CARD declares **AGPLv3**, and it
was removed rather than registered — copyleft obligations are unsuitable for the proprietary
product direction, and `upmc`/`siwis` cover both genders under CC-BY-SA/CC-BY.

Explicitly still open for P6.1A closure:

- Human voice-quality review: all four voices remain `qualityStatus=development`, so English and
  Spanish are **not** declared fully voice-ready and
  `evaluateStandardVoiceReadiness` truthfully reports them not ready.
- The English HFC voice pair is CC-BY-NC-SA-4.0 and therefore development/demo only; a
  commercially licensed English Male/Female pair is a separate C-AI1 work item.
- Nigerian-accented English and the wider §31.1 human test corpus remain pending.

## Proposed Or Blocked Targets

The rows below are the 2026-07-28 P5.2 planning snapshot. Where they conflict with the
2026-08-08 Multi-Voice Configuration section above (French/Portuguese Piper voices, the
Yoruba NLLB+MMS route, and Latin via `opus-mt-en-ROMANCE` + `mms-tts-lat` are now installed
in the development/demo profile), the later section records the current state. Commercial
review remains pending for all of them.

| Provider    | Model or voice                    | Language                                                   | Licence evidence           | Commercial review | Local path or cache                                                     | Status   |
| ----------- | --------------------------------- | ---------------------------------------------------------- | -------------------------- | ----------------- | ----------------------------------------------------------------------- | -------- |
| OPUS-MT     | `Helsinki-NLP/opus-mt-en-fr`      | English to French                                          | model-dependent            | pending           | not validated in P5.2                                                   | proposed |
| OPUS-MT     | `Helsinki-NLP/opus-mt-en-ROMANCE` | English to Portuguese                                      | model-dependent            | pending           | not validated in P5.2                                                   | proposed |
| M2M100      | `facebook/m2m100_418M`            | English to Spanish, French, Portuguese, Yoruba and Chinese | MIT model card             | reviewable        | runtime support implemented; local model and quality validation pending | proposed |
| Local model | Latin candidate                   | English to Latin                                           | no approved model selected | pending           | unsupported and hidden from selectable outputs                          | blocked  |
| Piper       | French voice candidate            | French                                                     | voice-dependent            | pending           | not selected                                                            | blocked  |
| Piper       | Portuguese voice candidate        | Portuguese                                                 | voice-dependent            | pending           | not selected                                                            | blocked  |
| Piper       | Yoruba voice candidate            | Yoruba                                                     | voice-dependent            | pending           | not selected                                                            | blocked  |

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
