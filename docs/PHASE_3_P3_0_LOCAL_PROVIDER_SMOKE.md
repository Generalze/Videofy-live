# Phase 3 P3.0 - Local Provider Smoke Test

## Status

P3.0 passed.

Validation date: 2026-07-27

## Scope Guard

- Phase 1 and closed Phase 2 behaviour were preserved.
- No production architecture changes were made.
- No TTS, HLS, WebRTC, plugins, external integrations, broadcasting or billing were added.

## Dependencies Installed

- Local Python virtual environment: `services/media-ingest/.venv`
- `faster-whisper==1.2.1`
- `argostranslate==1.11.0`
- `ctranslate2==4.8.1`
- `torch==2.13.0`
- faster-whisper model: `small`
- faster-whisper cache: `services/media-ingest/model_cache/faster-whisper`
- Cached model size: 486,213,474 bytes
- Argos language package: English to Spanish
- Installed Argos languages: English (`en`), Spanish (`es`)

## Local Configuration

- Node.js: `v24.18.0`
- npm: `11.17.0`
- Python: `3.11.9`
- FFmpeg/ffprobe: `8.1.2`
- CPU: Intel(R) Core(TM) Ultra 7 255H, 16 cores, 16 logical processors
- GPU detected: NVIDIA GeForce RTX 5060 Laptop GPU, driver 592.19, 8151 MiB
- Smoke transcription device: CPU
- Smoke compute type: `int8`
- GPU fallback: disabled
- Target language: Spanish (`es`)

## Smoke Media

- Source fixture: OpenAI Whisper JFK speech fixture downloaded to a temp directory.
- Uploaded-audio sample: 8-second WAV, mono, 16 kHz, PCM 16-bit.
- Browser-microphone sample: 8-second WebM/Opus, passed through microphone chunk ingest and normalised before transcription.
- No generated media was committed.

## Results

| Path | State | Chunks | Transcript | Language | Translation | Timestamp | Export | Wall time |
| --- | --- | ---: | --- | --- | --- | --- | --- | ---: |
| Uploaded audio | completed | 1 | `And so my fellow Americans, ask not what your country can do for you.` | `en`, confidence 0.9580 | Spanish produced | `0-8000 ms` | passed | 145,799 ms |
| Browser microphone | completed | 1 | `And so, my fellow Americans, ask not what your country can do for you.` | `en`, confidence 0.9383 | Spanish produced | `0-8000 ms` | passed | 31,893 ms |

## Measured Provider Latency

| Path | Transcription provider latency | Translation latency | Monitoring progress | Monitoring errors |
| --- | ---: | ---: | ---: | --- |
| Uploaded audio | 123,542 ms | 21,986 ms | 100% | none |
| Browser microphone | 16,823 ms | 15,039 ms | 100% | none |

The uploaded-audio path includes the initial faster-whisper `small` model load/download cost. The browser-microphone path ran after the model was cached and loaded faster.

## Defects Found

None.

## Roadmap Cleanup

The following items were moved out of Phase 2 and into Phase 3A:

- Local Piper text-to-speech
- Generated audio file delivery to listener
- Browser audio queue with video timestamp alignment
- Interpretation-mode audio mixing
- Replacement-mode audio

The previous local video/HLS section is now Phase 3B.

## Piper TTS Readiness

Ready to begin Piper TTS foundation work. Entry criteria met: local transcription and translation providers are installed, real upload and microphone samples complete, timestamps are preserved, exports work and monitoring reports progress/latency without silent fallback.
