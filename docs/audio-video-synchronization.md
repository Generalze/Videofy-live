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

- `videoTimestampMs` is carried in every event ✅
- `AudioSyncDescriptor` interface is defined ✅
- No video buffering is implemented ❌
- No audio queue is implemented ❌
- Translated audio is not generated ❌

## Planned synchronisation flow (next phase)

1. The browser maintains a running estimate of `synchronizationOffsetMs` based on received events.
2. When a translation event arrives with `audioUrl` set, the browser:
   a. Reads `videoTimestampMs` from the event.
   b. Reads the current video playhead position.
   c. Waits until `Math.abs(videoPlayhead - videoTimestampMs) < threshold` before playing.
3. If the offset is consistently large, the browser increases the video buffer.

## Audio mode trade-offs

### Interpretation mode

The original speaker is heard at reduced volume alongside the translated voice. Music and applause remain audible. This is the most natural mode for conference interpretation.

### Replacement mode

The original speech is muted entirely. Only translated speech is heard. This is simpler to synchronise but loses the speaker's emotion and intonation cues.

## Known limitations

- In a live stream, perfect frame-accurate synchronisation is very difficult without a shared clock between the video source and the translation pipeline.
- Network jitter and variable model latency mean the offset fluctuates.
- The design accommodates these constraints by using a configurable buffer rather than trying to achieve zero offset.
