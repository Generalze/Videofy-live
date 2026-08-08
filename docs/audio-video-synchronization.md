# Audio-video synchronisation

## The fundamental challenge

Interpreted audio necessarily lags behind the original speaker. The pipeline is:

```
microphone → speech recognition → text translation → text-to-speech → audio delivery
```

Even with the fastest local models, this pipeline introduces several seconds of latency. The listener hears translated speech that corresponds to words spoken 3–10 seconds ago.

## Design approach

Rather than attempting perfect synchronisation (which would require either:
- holding the video behind until translated audio is ready, or
- discarding audio frames that arrive too late),

Videofy Live is designed to support **video buffering** as the synchronisation mechanism.

The live video feed is buffered by a configurable offset so the listener sees the video event at approximately the same time they hear the translated audio.

## Video timestamp field

Every `TranslationEvent` carries a `videoTimestampMs` field:

```typescript
interface TranslationEvent {
  videoTimestampMs: number; // ms from stream start
  // ...
}
```

This field records the position in the video stream that corresponds to the original speech segment. When the browser receives a translation event, it can:

1. Check whether the video playhead is near `videoTimestampMs`
2. Decide whether to play the translated audio immediately or queue it
3. Adjust the video buffer offset for future events

## AudioSyncDescriptor

The `AudioSyncDescriptor` interface (`packages/shared-types/src/audio-sync.ts`) carries the full set of metadata needed for alignment:

```typescript
interface AudioSyncDescriptor {
  eventId: string;
  sequence: number;
  sourceTimestamp: string;     // when audio was captured
  videoTimestampMs: number;    // position in video stream
  translatedAudioDurationMs: number | null;
  deliveryTimestamp: string;   // when audio was queued for delivery
  synchronizationOffsetMs: number; // positive = audio lags video
}
```

## Current state (this release)

- `videoTimestampMs` in `media:state` now reports the real programme position
  (max `endMs` across processed transcription chunks, monotonic per session)
  instead of a hardcoded 0.
- The listener clock anchor is forward-only: `media:state` snapshots can no
  longer reset the programme clock backwards mid-session.
- Speech is segmented per Whisper segment (sentence-sized, accurate
  `startMs`/`endMs`), not per fixed 15 s / 5 s chunk, so audio and captions are
  scheduled at utterance granularity.
- Generated clips are duration-fitted at synthesis time: when a translated clip
  overruns its segment window by more than 5 %, an `atempo` filter (clamped to
  1.25×) compresses it to approximately fit.
- Late playback catch-up is gentle: clips late by less than the drop tolerance
  play from the start at 1.1× rather than being seek-trimmed mid-word; only
  clips past the drop tolerance are trimmed or skipped.
- Uploaded programmes gate the initial video start until the first translated
  clip for the selected language is buffered (or 15 s elapse), instead of
  starting the video ahead of generation.
- Live VAD is enabled by default, ending live segments at natural pauses
  (600 ms end-silence, 7 s max segment).
- Tuning knobs: `VITE_VIEWER_SYNC_DELAY_MS` (audio schedule delay, default
  8000 ms) and `VITE_VIEWER_LATE_DROP_TOLERANCE_MS` (default 2500 ms).

## Remaining gaps (next phase)

1. Live WebRTC video is not yet delayed to match the audio-side sync delay —
   set `receiver.jitterBufferTarget`/`playoutDelayHint` on the listener's
   RTCRtpReceivers so live video renders ~`VIEWER_SYNC_DELAY_MS` late and lips
   align with interpretation.
2. Derive the sync delay from measured pipeline latency instead of a fixed
   constant, updating the receiver delay and audio clock offset together.
3. `AudioSyncDescriptor` is still defined but not yet constructed/attached to
   delivery events.

## Audio mode trade-offs

### Interpretation mode

The original speaker is heard at reduced volume alongside the translated voice. Music and applause remain audible. This is the most natural mode for conference interpretation.

### Replacement mode

The original speech is muted entirely. Only translated speech is heard. This is simpler to synchronise but loses the speaker's emotion and intonation cues.

## Known limitations

- In a live stream, perfect frame-accurate synchronisation is very difficult without a shared clock between the video source and the translation pipeline.
- Network jitter and variable model latency mean the offset fluctuates.
- The design accommodates these constraints by using a configurable buffer rather than trying to achieve zero offset.
