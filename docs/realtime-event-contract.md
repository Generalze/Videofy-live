# Realtime event contract

All events flow through the realtime gateway using Socket.IO.

## Connection

Connect to `ws://localhost:3001` with a `role` query parameter:

| Role | Value | Description |
|------|-------|-------------|
| Listener | `role=listener` | Audience member |
| Operator | `role=operator` | Event manager |
| Speech worker | `role=worker` | Translation pipeline |
| Media ingest | `role=ingest` | Video/audio source |

## Rooms

| Room | Members | Purpose |
|------|---------|---------|
| `lang:fr` | Listeners (FR) | French translation events |
| `lang:es` | Listeners (ES) | Spanish translation events |
| `operators` | Operators | All events for monitoring |
| `workers` | Speech workers | Translation submission |
| `ingest` | Media-ingest services | State submission |

## Events

### `translation:event` (gateway → listener, operator)

Broadcast when a validated translation phrase is received from the speech worker.

```json
{
  "eventId": "demo-event",
  "sequence": 1,
  "sourceLanguage": "en",
  "targetLanguage": "fr",
  "sourceText": "Welcome to the programme.",
  "translatedText": "Bienvenue au programme.",
  "audioUrl": null,
  "audioFormat": null,
  "audioDurationMs": null,
  "final": true,
  "videoTimestampMs": 5000,
  "createdAt": "2026-07-17T00:00:00.000Z",
  "latency": {
    "audioCaptureMs": 0,
    "transcriptionMs": 0,
    "translationMs": 0,
    "speechGenerationMs": 0,
    "deliveryMs": 0,
    "synchronizationOffsetMs": 0
  }
}
```

### `media:state` (gateway → all)

Broadcast when the media-ingest service emits a state update.

```json
{
  "eventId": "demo-event",
  "streamStatus": "live",
  "videoSource": "mock",
  "videoTimestampMs": 5000,
  "sourceAudioActive": true,
  "translatedLanguages": ["fr"],
  "connectedListeners": 1,
  "createdAt": "2026-07-17T00:00:00.000Z"
}
```

### `stream:status` (gateway → all)

Sent when stream lifecycle state changes.

```json
{ "status": "live", "timestamp": "2026-07-17T00:00:00.000Z" }
```

### `join:language` (listener → gateway)

Subscribe to a language room.

```
socket.emit('join:language', 'fr')
```

### `leave:language` (listener → gateway)

Unsubscribe from a language room.

```
socket.emit('leave:language', 'fr')
```

### `worker:translation` (worker → gateway)

Submit a translation event. The gateway validates it with Zod before broadcasting.

Payload: same shape as `translation:event` above.

### `ingest:state` (ingest → gateway)

Submit a media-state update. The gateway validates it with Zod before broadcasting.

Payload: same shape as `media:state` above.

### `service:status` (gateway -> operator)

Reports gateway-observed connection status for Phase 1 services.

```json
{ "service": "speech-worker", "status": "healthy", "timestamp": "2026-07-17T00:00:00.000Z" }
```

### `operator:control` (operator -> gateway)

Accepted mock actions are `start-mock-stream`, `stop-mock-stream`,
`trigger-mock-phrase`, and `reset-mock-sequence`.

```json
{ "action": "trigger-mock-phrase", "eventId": "demo-event", "targetLanguage": "fr" }
```

Production use requires operator authorization; authentication is not implemented in Phase 1.

## Validation

All incoming events from workers and ingest services are validated using Zod schemas.
Invalid events are rejected with an `error` event:

```json
{ "message": "Invalid translation event", "issues": [...] }
```

## Duplicate, stale, and out-of-order handling

The gateway maintains an `EventStore` per `eventId + targetLanguage` channel.

- **In order**: `1, 2, 3` is delivered immediately.
- **Out of order**: `1, 3, 2` buffers `3` and then delivers `2, 3` when `2` arrives.
- **Duplicate or stale**: a sequence lower than the next expected sequence is rejected.
- **Large gap**: a sequence more than 20 ahead of the next expected sequence is rejected.
- **Reset**: a reset can target one event-language channel.
