# Phase 5 P5.2 - Open-Source AI Providers And Language Controls

Date: 2026-07-28

Branch: `phase-5-partner-preview`

Baseline: `3907c3843bdf644e870e3496f78b8a374fc44962`

## Scope

P5.2 adds and validates the local open-source provider path:

`programme audio -> VAD-aware segmentation -> faster-whisper -> OPUS-MT -> Piper -> existing translated-audio queue`

The implementation preserves Phase 1, closed Phase 2, Phase 3 playback, Phase 4 WebRTC delivery, P5.0 unified programme sources, and P5.1 external-source hardening. It does not add native Zoom, Teams, RTMP, SFU, MCU, agents in the real-time path, public APIs, plugins, billing, or P5.3 work.

## Provider Architecture

- Transcription still runs behind the existing `TranscriptionProvider` interface.
- faster-whisper is selected with `TRANSCRIPTION_PROVIDER=faster-whisper` and receives the operator source-language hint only when manual mode is selected.
- Translation still runs behind `TimestampedTranslationProvider`.
- OPUS-MT was added as a command-backed local provider beside the existing mock and Argos providers.
- OPUS-MT uses local `transformers`/Marian models with `local_files_only` unless `OPUS_MT_ALLOW_MODEL_DOWNLOAD=true`.
- Piper remains behind `TextToSpeechProvider`.
- Piper output is now normalized through FFmpeg to mono 16 kHz PCM 16-bit WAV before session validation and listener delivery.
- Text-only targets keep translated text output when no approved Piper voice is available.
- WebRTC audio chunking keeps the configurable VAD-style segmentation path, with fixed chunking available as fallback/default.

## Runtime Setup

The runtime was prepared in a project-local Python 3.11 virtual environment:

- Python: `3.11.9`
- Virtual environment: `.venv-ai`
- FFmpeg: `8.1.2`
- `faster-whisper==1.2.1`
- `ctranslate2==4.8.1`
- `transformers==5.14.1`
- `sentencepiece==0.2.2`
- `silero-vad==6.2.1`
- `torch==2.13.0+cpu`
- `torchaudio==2.11.0+cpu`
- `soundfile==0.14.0`
- `psutil==7.2.2`
- `huggingface-hub==1.25.1`

Pinned installation instructions are in `services/media-ingest/requirements-ai.txt` and the operator setup guide is in `docs/AI_RUNTIME_SETUP.md`.

## Models And Voice

Validated Spanish partner-preview path:

- VAD: `silero-vad==6.2.1`, validated in the local Python runtime.
- Transcription: `Systran/faster-whisper-small.en`, revision `d1d751a5f8271d482d14ca55d9e2deeebbae577f`, local cache size 486.1 MB.
- Translation: `Helsinki-NLP/opus-mt-en-es`, revision `5bc4493d463cf000c1f0b50f8d56886a392ed4ab`, local cache size 937.8 MB.
- TTS: Piper `1.2.0`, voice `es_ES-sharvard-medium`, 76.7 MB voice package.

Licence evidence:

- faster-whisper `small.en` local model card: MIT.
- OPUS-MT en-es local model card: Apache-2.0.
- Upstream `rhasspy/piper-voices` model card: MIT; upstream Piper voice list includes `es_ES/sharvard/medium`.

## Source-Language Controls

English remains the default source language.

Added session metadata and operator controls for:

- Manual source-language selection.
- Auto-detect Beta.
- Detected language and confidence.
- Confirm.
- Reject.
- Override.
- Lock.
- Unlock and detect again.

Manual mode overrides auto-detect. Auto-detect below the configured confidence threshold marks the language as requiring confirmation and does not silently switch the active language. Confirmed source-language changes increment a language revision and reset downstream translation/TTS queues so stale results from a previous revision are rejected.

## Target-Language Catalogue

Initial operator target candidates:

- Yoruba.
- Portuguese.
- Spanish.
- French.

Spanish is the validated complete path for P5.2 because translation and generated audio were both produced and played in the listener. Other targets remain unavailable, text-only, or experimental until translation model, voice, licence, and quality review are complete.

## Runtime Evidence

Deterministic validation file:

- `.videofy-dev-logs/p5.2/english-provider-validation.wav`
- WAV mono 16 kHz PCM 16-bit
- 7.951625 seconds
- 254,530 bytes
- Text: English provider-validation sentence for transcription, Spanish translation, and Spanish speech generation.

Standalone CPU provider chain:

- Silero detected 2 speech regions.
- faster-whisper CPU int8: load 1011 ms, transcription 2078 ms.
- Detected language: `en`, confidence `1`.
- Transcript: `Hello, this is a video feed live provider validation the program audio should be transcribed translated and spoken in Spanish`.
- OPUS-MT en-es: load 768 ms, translation 694 ms.
- Piper Spanish: provider latency 831 ms.
- Generated WAV: 322,720 bytes, 7317 ms, source voice native 22.05 kHz.
- Total wall time: 8864 ms.
- Process RSS: 1029.1 MB.

Real `ProcessingSessionStore` run:

- Session state: `completed`.
- Transcription status: `transcribed`.
- Translation status: `translated`.
- Generated audio status: `generated`.
- Target language: `es`.
- Transcription provider latency: 4233 ms.
- Translation provider latency: 4183 ms.
- Piper provider latency after normalization: 787 ms.
- Generated audio duration: 7120 ms.
- Monitoring progress: 100%.
- Failed segments: 0.
- Transcript and paired-translation exports were produced.

## GPU Benchmark

Machine GPU probe:

- GPU: NVIDIA GeForce RTX 5060 Laptop GPU.
- Driver: `592.19`.
- VRAM: 8151 MiB.
- CTranslate2 CUDA device count: 1.
- CUDA compute types advertised: `bfloat16`, `float16`, `float32`, `int8`, `int8_bfloat16`, `int8_float16`, `int8_float32`.

Benchmark on the 7.952-second deterministic WAV:

| Model | Device | Compute type | Load | Transcribe | Result |
| --- | --- | --- | ---: | ---: | --- |
| `small.en` | CPU | `int8` | 895 ms | 1348 ms | passed |
| `small.en` | CUDA | `float16` | 655 ms | 741 ms | passed |
| `small.en` | CUDA | `int8_float16` | 896 ms | failed | `CUBLAS_STATUS_NOT_SUPPORTED` |

No silent fallback occurred. CUDA `float16` is the validated GPU setting on this machine; CUDA `int8_float16` must remain disabled until the CTranslate2/cuBLAS combination is validated.

## Browser Evidence

Real Chrome harness:

- Chrome: `149.0.0.0`.
- Node: `v24.18.0`.
- Input: deterministic uploaded WAV through the operator media upload flow.
- Operator target: Spanish only.
- Source-language mode: Auto-detect Beta.
- Listener language: Spanish.

Observed operator state:

- Session completed.
- Source language displayed as EN, confirmed, revision 0.
- Extraction 100%, chunks 1.
- Transcription 100%, detected language EN.
- Translation 100%, provider `opus-mt:ready`, latency 4551 ms.
- Generated audio 100%, provider `piper:ready`, voice `es_ES-sharvard-medium`, latency 887 ms.
- Failed segments 0.
- Average latency 2719 ms, latest latency 887 ms.
- No unresolved operator console errors.

Observed listener state:

- One generated Spanish audio segment delivered.
- Manual replay started playback.
- Interpretation mode remained functional.
- Replacement mode muted original audio while preserving translated audio playback.
- Audio play calls: 3.
- Audio play failures: 0.
- Gateway emitted one `generatedAudioReady` event and three translation broadcasts.
- No unresolved gateway, ingest, operator, or listener errors remained.

## Production Defect Fixed

Root cause:

Piper `es_ES-sharvard-medium` emits native 22.05 kHz WAV. The generated-audio session validator requires mono 16 kHz PCM 16-bit WAV for listener delivery. The real session therefore failed after TTS generation with `Generated WAV must be mono 16 kHz PCM 16-bit.`

Fix:

- Piper now writes to a temporary raw Piper WAV.
- FFmpeg normalizes the generated audio to mono 16 kHz PCM 16-bit WAV at the requested output path.
- The temporary raw output is removed after normalization.
- Missing or failed FFmpeg normalization returns a clear `tts-ffmpeg-unavailable` or `tts-provider-failed` error.

Regression coverage was added in the text-to-speech provider tests.

## Validation Commands

Passed before closure:

- `.\.venv-ai\Scripts\python.exe -m pip check`
- Python import/runtime probe for faster-whisper, CTranslate2, Transformers, Silero VAD, Torch, Torchaudio, SoundFile, and Piper.
- Standalone CPU provider-chain benchmark.
- faster-whisper CPU/GPU benchmark.
- Real `ProcessingSessionStore` provider-chain harness.
- Real Chrome P5.2 browser harness.
- `npm test -w services/media-ingest -- src/__tests__/translation-provider.test.ts src/__tests__/transcription-session.test.ts src/__tests__/generated-audio-session.test.ts src/__tests__/text-to-speech-provider.test.ts`
- `npm test -w services/realtime-gateway -- src/__tests__/webrtc-transcription-chunker.test.ts src/__tests__/webrtc-transcription-bridge.test.ts`
- `npm test`
- `npm run build`
- `npm run lint`
- `npm run typecheck`
- `npm audit --omit=dev`

## Known Limitations

- Spanish is the only fully validated translation plus generated-audio target in P5.2.
- Yoruba remains blocked pending model, voice, licence, and quality review.
- Portuguese and French remain unclosed for generated audio until approved voices are selected and validated.
- Nigerian-accented English robustness was not measured because no approved deterministic accent fixture was available.
- One-hour stability was not run in this pass.
- GPU validation used `small.en`; a larger Whisper model was not benchmarked.
- CUDA `int8_float16` failed on this machine and is not an approved setting.
- The gateway low-latency WebRTC chunker still uses the deterministic VAD-style TypeScript path for live segmentation; real Silero execution was validated in the local runtime and faster-whisper path.
- Human translation quality, pronunciation quality, and commercial-use approval remain separate partner-review gates.
- No production TURN, horizontal scaling, persistent peer state, or native meeting-platform integration changes were added.

## Closure

P5.2 completion status: complete for the validated Spanish local-provider path.

P5.2 completion percentage: 100%.

Exact next milestone: `P5.3 partner-preview validation and closure`.
