# Troubleshooting

## Verifying that translation actually works

```bash
npm run dev -w services/media-ingest      # must be running
node scripts/verify-language-pair.mjs en fr
node scripts/verify-language-pair.mjs es en
```

This synthesises known sentences, runs them through the real pipeline as a
native-call session, and asserts on the transcript and the translation. It reads
`.env` itself, so nothing needs sourcing.

**Do not verify translation accuracy through a browser.** On at least one
development machine Chrome/Edge ignore `--use-fake-device-for-media-capture`
entirely and hand back the real microphone: the call then transcribes the room,
and speech recognition hallucinates plausible sentences on near-silence. That
failure is invisible — it looks like a passing test. Check with:

```js
await navigator.mediaDevices.getUserMedia({ audio: true })
  .then((s) => s.getAudioTracks()[0].label)
```

If that returns a hardware device name, the fake-audio flags are doing nothing.
A recurring `"Subtitles directed by the community of Amara.org"` caption is the
classic sign of recognition running on silence. Use a browser for what a browser
uniquely covers — transport, routing, caption delivery, the interface — and
verify content with the script.

## Captions stop, or one language never arrives

Check `http://localhost:3002/health` first:

- `"status": "degraded"` with `gatewayConnected: false` means media-ingest is
  running and transcribing, but nothing it produces can reach a participant. It
  reconnects on its own; if it does not, the gateway is down.
- `unavailableTranslationPairs` lists any language pair whose model cannot be
  resolved. A pair in that list is completely dead while the rest of the call
  looks healthy, because the speaker still sees their own captions.

A pair usually fails because its Hugging Face cache entry lost `refs/main`, so
with downloads disabled the resolver cannot map the repo id to its snapshot.
Repair it by writing the snapshot hash into that file:

```bash
cd services/media-ingest/model_cache/opus-mt
ls models--Helsinki-NLP--opus-mt-es-en/snapshots   # the hash
printf '%s' "<hash>" > models--Helsinki-NLP--opus-mt-es-en/refs/main
```


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
