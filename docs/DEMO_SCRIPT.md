# Demo Script

## Opening

Videofy Live turns a live or uploaded programme source into translated listener audio while preserving the original programme media. This preview shows the local English-to-Spanish path with browser programme delivery, local open-source AI providers, and listener playback modes.

## Uploaded-Video Demonstration

1. Open the operator and listener.
2. Apply `EN to ES preset`.
3. Select an uploaded browser-compatible video.
4. Confirm metadata, duration, audio, video, and codec diagnostics.
5. Start programme.
6. Confirm the listener receives one audio and one video track.
7. Pause, resume, seek, and restart the uploaded video.
8. Confirm source revision changes after seek or restart.

## Live-Source Demonstration

1. Select a camera, OBS Virtual Camera, capture card, or screen source.
2. Select a separate programme-audio device if required.
3. Start programme.
4. Confirm source diagnostics: labels, track state, dimensions, frame rate, and audio presence.
5. Confirm listener audio/video delivery.

## Source-Language Control

1. Show English as the default source language.
2. Switch to Auto-detect Beta.
3. Show detected language and confidence.
4. Confirm the language.
5. Override the language and show the revision change.
6. Lock and unlock the language.

## Translation And Speech

1. Show faster-whisper transcript text.
2. Show OPUS-MT Spanish translation.
3. Show Piper generated Spanish audio.
4. Show progress, provider status, latency, and failed segment count.
5. Export transcript and paired translation.

## Listener Language Selection

1. Select Spanish on the listener.
2. Confirm delivered generated audio uses target language `es`.
3. Confirm the segment shows sequence, timestamps, duration, voice, and latency.

## Interpretation Mode

1. Select Interpretation.
2. Confirm original audio remains reduced.
3. Confirm translated audio remains at full level.

## Replacement Mode

1. Select Replacement.
2. Confirm original audio is muted.
3. Confirm video continues when the source includes video.
4. Confirm translated audio still plays.

## Recovery Demonstration

1. Refresh the listener.
2. Rejoin or recover.
3. Stop and restart the programme source.
4. Show failed segment retry if a controlled failure is available.
5. Clear source and confirm cleanup.

## Quality Review Demo Set

Use these prompts for human review on demo hardware:

- Ordinary speech: "Hello, this is the Videofy Live partner preview."
- Nigerian-accented English: read the ordinary and meeting prompts with a Nigerian English speaker or approved recording.
- Names: "Ada Okafor and Jose Martinez will join the Lagos session."
- Numbers and dates: "The meeting starts at 14:30 on 28 July 2026, with 375 attendees."
- Meeting language: "Please move to slide four and review the action items before questions."
- Difficult or noisy audio: repeat one prompt with controlled background noise and record the latency and accuracy impact.

Record each prompt separately:

- Technical pipeline success.
- Transcript corrections.
- Translation corrections.
- Piper pronunciation or intelligibility notes.
- Latency and any dropped, delayed, stale, or duplicate segment.

## Closing

The validated preview demonstrates that Videofy Live can preserve original programme delivery while producing ordered local transcription, Spanish translation, generated speech, listener playback, and visible recovery controls. Production readiness still requires partner hardware validation, network/TURN validation, long-duration stability, and human language-quality approval.
