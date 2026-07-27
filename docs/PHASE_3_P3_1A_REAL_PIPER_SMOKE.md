# Phase 3 P3.1A - Real Piper Smoke Test

## Status

P3.1A passed.

Validation date: 2026-07-27

## Scope Guard

- Preserved Phase 1, closed Phase 2, P3.0 and P3.1.
- No production architecture changes were made.
- No listener delivery, audio synchronisation, mixing, HLS, WebRTC, plugins, APIs or billing were added.

## Piper Setup

- Piper binary used: `services/media-ingest/model_cache/piper/bin/piper/piper.exe`
- Piper release: `2023.11.14-2`
- Python `piper-tts==1.6.0` was installed, but the local Windows Application Control policy blocked its `espeakbridge` DLL, so the official Windows Piper binary was used for the real smoke test.
- Voice model: `es_ES-sharvard-medium`
- Model file: `services/media-ingest/model_cache/piper/es_ES-sharvard-medium/es_ES-sharvard-medium.onnx`
- Config file: `services/media-ingest/model_cache/piper/es_ES-sharvard-medium/es_ES-sharvard-medium.onnx.json`
- Target language: Spanish (`es`)
- Voice ID: `es_ES-sharvard-medium`

## Smoke Segment

- Sequence: `0`
- Segment timestamps: `0-3000 ms`
- Translated text: `Hola, esta es una prueba de Videofy Live.`

## Results

| Check | Result |
| --- | --- |
| WAV file created | Passed |
| Audio playable | Passed by ffprobe/read validation |
| Target language | `es` preserved |
| Voice | `es_ES-sharvard-medium` preserved |
| Sequence | `0` preserved |
| Timestamps | `0-3000 ms` preserved |
| Provider latency | `1342 ms` recorded |
| Retry | Passed |
| Failure reporting | Passed |

## Generated Audio

- Output filename: `tts-000000.wav`
- Codec: `pcm_s16le`
- Sample rate: `22050 Hz`
- Channels: `1`
- Duration: `2.742585 seconds`
- File size: `120,992 bytes`
- End-to-end smoke wall time: `1,469 ms`

## Failure And Retry Validation

The smoke runner intentionally failed the first TTS attempt. The session entered `failed`, the generated-audio event had status `failed`, and monitoring exposed `1 generated-audio segment failed.`.

Retrying the same segment with the real Piper provider completed the session, generated the WAV file, cleared monitoring errors and recorded a `retry-tts` recovery event.

## Defects Found

No application defects were found.

Environment finding: the Python `piper-tts` wheel could not be used on this machine because Windows Application Control blocked its `espeakbridge` DLL. The official Piper Windows binary worked with the same voice model.

## P3.2 Readiness

Ready for P3.2 generated audio file delivery to listener.
