# Operator Guide

## Partner Preview Setup

Use the operator application to choose the programme source, language controls, target language, and recovery actions.

For final partner-preview acceptance, run on the actual demo machine and network. Do not mark the run accepted unless the physical devices, TURN relay, separate-network listener, multiple listeners, additional browser, one-hour stability, and human language-review checks are complete.

The `Preview readiness` panel is the first check before a partner run:

- `Gateway` must be connected.
- `Media ingest` must be healthy.
- `Programme source` must show a selected or active source.
- `Source language` should show English confirmed or locked for the validated flow.
- `Spanish target` should show selected and voice-available.
- `Translation provider` should show `opus-mt:ready` after session start.
- `Speech provider` should show `piper:ready` after session start.
- `Listeners` should be greater than zero before showing listener delivery.

The `EN to ES preset` configures only the validated demo controls. It does not start capture, upload media, or create a false ready state.

## Uploaded Media

1. Choose an MP4, MOV, MP3, WAV, or browser-compatible uploaded video fixture.
2. Confirm filename, MIME type, duration, audio presence, video presence, and codec details.
3. Start processing.
4. Watch extraction, transcription, translation, and generated-audio progress.

## Live Sources

For camera, OBS, or capture card:

1. Select the video device.
2. Select a separate programme-audio device when required.
3. Start programme.
4. Confirm audio and video track diagnostics.
5. Confirm listener delivery before starting the AI demonstration.

For screen or tab capture:

1. Select screen.
2. Choose the browser tab/window/screen.
3. Enable shared audio in the picker if the browser offers it.
4. Treat missing screen audio as a browser/platform limitation.

## Language Controls

- Manual source language sends the selected source language to transcription.
- Auto-detect uses provider detection and confidence.
- Confirm accepts the detected source language.
- Reject keeps the current active language and records the rejected detection.
- Override creates a new language revision.
- Lock prevents accidental source-language changes.
- Unlock allows a new detection or override.

## Recovery

Use session monitoring for:

- Pause and resume.
- Cancel.
- Failed transcription retry.
- Failed translation retry.
- Failed TTS retry.
- Source stop, restart, and clear.
- Listener reconnect.
- Broadcaster transport recovery.

Do not hide a failed segment during a demonstration. Show the visible error and retry only the failed item.

The current recovery harness validates the P5 programme-source architecture by recovering camera programme audio/video after a gateway interruption and listener rejoin. Treat any stale legacy local-microphone-only recovery evidence as obsolete.
