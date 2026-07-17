# Media streaming plan

## Current state (this release)

The `media-ingest` service runs in mock mode. It generates a synthetic video timestamp ticker and emits `MediaStateEvent` updates to the gateway at 1-second intervals. No real video is captured or streamed.

The `listener-web` application attaches a deterministic browser-generated canvas stream to the `<video>` element with `canvas.captureStream()`. No real live stream is delivered and no media file is committed.

## Provider interface

The `MediaProvider` interface (`services/media-ingest/src/providers/index.ts`) defines the contract for all future input sources:

```typescript
interface MediaProvider {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isAudioActive(): boolean;
  getVideoTimestampMs(): number;
}
```

## Planned input sources

| Provider | Notes |
|----------|-------|
| `MockProvider` | ✅ Implemented – synthetic timestamp |
| `LocalFileProvider` | Pre-recorded video for testing |
| `LocalCameraProvider` | Browser webcam + microphone |
| `ObsProvider` | OBS WebSocket integration |
| `RtmpProvider` | RTMP ingest (e.g. OBS → nginx-rtmp) |
| `WebRtcProvider` | WebRTC ingest (mediasoup / Janus) |
| `HlsProvider` | HLS output (ffmpeg → CDN) |
| `ZoomProvider` | Zoom meeting/webinar capture |
| `TeamsProvider` | Microsoft Teams capture |
| `MeetProvider` | Google Meet capture |

## Planned output formats

| Format | Notes |
|--------|-------|
| Browser `<video>` with HLS | Recommended for production |
| WebRTC | Low-latency option |
| Mock `<video>` | ✅ Used in this release |

## Implementation phases

### Phase 2 (next)

- Local camera/microphone capture in the browser
- `<video>` element with a local file for testing

### Phase 3

- FFmpeg integration for audio extraction
- HLS packaging with nginx-rtmp or a managed service

### Phase 4

- WebRTC ingest (mediasoup)
- Multi-CDN distribution

### Phase 5

- Zoom, Teams, Meet SDK integration
- OBS WebSocket integration
- RTMP ingest
