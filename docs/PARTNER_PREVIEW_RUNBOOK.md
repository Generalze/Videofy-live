# Partner Preview Runbook

Date: 2026-07-28

## Purpose

This runbook prepares a controlled English-to-Spanish Videofy Live partner preview. It assumes Phase 4 and P5.0-P5.3 code on branch `phase-5-partner-preview`.

## Required Local Services

Start the normal development stack:

```text
npm run dev
```

Required local AI settings for the validated Spanish path:

- `TRANSCRIPTION_PROVIDER=faster-whisper`
- `TIMESTAMPED_TRANSLATION_PROVIDER=opus-mt`
- `TEXT_TO_SPEECH_PROVIDER=piper`
- `FASTER_WHISPER_MODEL_SIZE=small.en`
- `FASTER_WHISPER_DEVICE=cpu` or validated `cuda`
- `FASTER_WHISPER_COMPUTE_TYPE=int8` for CPU or `float16` for CUDA on the validated machine
- `OPUS_MT_MODELS` includes `en:es:Helsinki-NLP/opus-mt-en-es:<local path>`
- `PIPER_VOICE_ID=es_ES-sharvard-medium`

Use `docs/AI_RUNTIME_SETUP.md` for exact environment commands.

## Pre-Demo Checklist

- Confirm gateway and media ingest are healthy.
- Open one operator tab and at least one listener tab.
- Apply `EN to ES preset`.
- Confirm source language shows English.
- Confirm Spanish target is selected.
- Confirm OPUS-MT and Piper provider status after session start.
- Confirm listener count is non-zero before showing translated audio delivery.
- Confirm `.videofy-dev-logs/` is not committed.
- Confirm TURN is configured and verify relay usage through WebRTC stats before any separate-network partner run.
- Confirm physical microphone, OBS/capture device, virtual audio cable, and meeting-platform sources on the actual demo machine.
- Confirm the one-hour stability plan and human language reviewer are available before marking final acceptance.

## Source Options

Uploaded media:

- Use a browser-playable MP4/WebM for programme audio/video delivery.
- Use WAV/MP3 for AI-only audio validation when video is not needed.
- Confirm metadata, duration, audio presence, video presence, and codec information are displayed.

Live camera or capture device:

- Select the video device.
- Select the programme-audio device when separate audio is needed.
- Start programme.
- Confirm one audio and one video track are visible in listener diagnostics.

OBS:

- Start OBS Virtual Camera before opening the operator page.
- Select OBS Virtual Camera as the video source.
- Select a separate programme-audio device if OBS camera does not expose audio.
- Treat OBS as a normal browser camera source.

Screen or browser tab:

- Select screen capture.
- Choose the tab/window/screen.
- Enable audio in the browser picker when available.
- If audio is missing, the operator should show a warning and transcription cannot proceed from that source.

## Demonstration Flow

1. Show the operator readiness checklist.
2. Apply `EN to ES preset`.
3. Select uploaded video and start programme.
4. Confirm listener receives source audio and video.
5. Show language controls: auto-detect, confirm, override, lock, unlock.
6. Show real transcript, Spanish translation, and generated Spanish audio.
7. Toggle Interpretation Mode.
8. Toggle Replacement Mode.
9. Switch to a live camera or screen source.
10. Stop and clear the source.
11. Demonstrate recovery by refreshing or reconnecting the listener.

## Pass Criteria

- No critical operator or listener error remains visible.
- Listener receives expected audio/video tracks for video sources.
- Transcription, translation, and TTS reach 100% for the validated Spanish path.
- Failed workers or segments remain visible and retryable.
- Cleanup returns object URLs, media tracks, peers, listeners, and timers to baseline.

Final partner-preview acceptance also requires:

- Physical mic speech capture.
- Nigerian-accented English review.
- Human transcript, translation, and voice approval.
- OBS or capture-device validation with separate programme audio.
- Real meeting-platform capture.
- Separate-network and TURN relay proof.
- Multiple listeners.
- Chrome plus one additional browser.
- One-hour stability.

## Known Demo Limits

- Spanish is the only complete speech target.
- TURN relay and separate-network behaviour must be validated on the target network.
- OBS, capture cards, physical microphones, and virtual audio cables require hardware-specific validation.
- Human language-quality approval is separate from technical pass/fail.
