# Troubleshooting

## Gateway Disconnected

- Confirm the realtime gateway process is running on port `3001`.
- Refresh operator and listener tabs after gateway restart.
- Use broadcaster or listener recover controls when available.
- For P5 programme sources, recover the signalling session and restart or reselect the programme source if the recovered source is not broadcasting.

## Media Ingest Unavailable

- Confirm the media-ingest service is running on port `3002`.
- Check FFmpeg availability.
- Do not retry unsupported files by renaming extensions.

## No Programme Audio

- Confirm the selected source exposes an audio track.
- For OBS Virtual Camera, select a separate programme-audio device.
- For screen capture, enable browser shared audio if available.
- If the browser or platform does not provide audio, use a capture device or virtual audio cable.

## No Programme Video

- Confirm camera permission was granted.
- Confirm the selected camera or capture card is still connected.
- For uploaded media, use a browser-compatible video codec.

## AI Provider Fails

- Check `.venv-ai` exists.
- Run `.\.venv-ai\Scripts\python.exe -m pip check`.
- Confirm faster-whisper and OPUS-MT model caches are present.
- Confirm Piper executable, model, and config paths are present.
- Confirm GPU settings are explicit; do not rely on silent CPU fallback.

## Unsupported Language

- Use Spanish for the validated complete speech path.
- Treat unavailable targets as blocked until model, voice, licence, and quality review are complete.

## Slow Or Delayed Audio

- Check monitoring average and latest latency.
- Prefer CPU `int8` or validated CUDA `float16` settings.
- Keep chunk sizes short for live demonstrations.
- Avoid noisy inputs until the audio path has been validated.

## Browser Capture Limits

- Browsers may hide device labels until permission is granted.
- Screen/window capture audio support depends on browser, OS, and platform.
- Device removal creates a source-ended or interrupted state and requires source restart.
- A browser `play()` interruption during rapid stream reassignment can be non-fatal if live audio and video tracks remain attached and recovery completes.

## TURN Or Separate Network Failure

- Confirm the ICE server configuration is loaded by both broadcaster and listener.
- Inspect WebRTC stats for selected candidate-pair relay protocol and relay candidate type.
- Do not claim TURN validation from local-host or same-network host-candidate tests.
- If relay is unavailable, keep the partner preview limited to same-network or local validation.

## Cleanup

After a failed run:

- Stop programme source.
- Clear source.
- Close or recover signalling sessions.
- Refresh listener tabs.
- Confirm no active object URLs, stale tracks, duplicate peers, or unresolved errors remain.
