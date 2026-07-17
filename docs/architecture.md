# Architecture

## Overview

Videofy Live is a real-time multilingual video streaming and audio interpretation platform.

```
┌─────────────────────────────────────────────────────────────────┐
│  Live event input (mock / future: Zoom, OBS, RTMP, WebRTC)      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                  ┌────────▼────────┐
                  │  media-ingest   │  Node.js service
                  │  (mock mode)    │  – stream-state events
                  └────────┬────────┘  – video timestamp
                           │ Socket.IO (role=ingest)
                  ┌────────▼────────┐
                  │realtime-gateway │  Express + Socket.IO
                  │                 │  – event validation (Zod)
                  │                 │  – per-language rooms
                  │                 │  – duplicate rejection
                  │                 │  – sequence tracking
                  └──┬──────────┬───┘
         ┌───────────┘          └──────────────┐
         │ Socket.IO                           │ Socket.IO
┌────────▼────────┐                  ┌────────▼────────┐
│  listener-web   │                  │  operator-web   │
│  React + Vite   │                  │  React + Vite   │
│  – video player │                  │  – event status │
│  – subtitles    │                  │  – phrase log   │
│  – audio ctrl   │                  │  – latency data │
└─────────────────┘                  └─────────────────┘
         ▲
         │ translated phrases (Socket.IO, role=worker)
┌────────┴────────┐
│  speech-worker  │  Python service
│  (mock mode)    │  – mock phrases
│                 │  – sequence numbering
│                 │  – video timestamp
└─────────────────┘
```

## Component responsibilities

### realtime-gateway

- Central event bus for the system
- Validates all incoming events using Zod schemas
- Maintains per-language Socket.IO rooms (`lang:fr`, `lang:es`, …)
- Rejects duplicate translation events (by sequence number per language)
- Rejects stale events (more than 20 behind current sequence)
- Broadcasts media-state events to all clients
- Provides `GET /health`

### media-ingest

- Abstracts the video and audio input source
- In mock mode: generates a synthetic video timestamp ticker
- Emits `MediaStateEvent` to the gateway at 1-second intervals
- Provides `GET /health`
- Provider interface supports future: Zoom, Teams, Meet, OBS, RTMP, WebRTC, HLS

### speech-worker

- Abstracts the speech processing pipeline
- In mock mode: emits pre-written English-to-French phrase pairs
- Each event carries a `videoTimestampMs` for future sync alignment
- Provider interfaces support future: Whisper, OPUS-MT, Piper, cloud APIs

### listener-web

- Audience-facing interface
- Video player (mock source in this release)
- Language selector → joins corresponding Socket.IO room
- Translated subtitle display
- Original and translated audio volume controls
- Interpretation / replacement audio mode toggle
- Browser autoplay-policy compliant (requires user gesture)

### operator-web

- Internal dashboard
- Service health indicators
- Stream and media state monitoring
- Translation phrase log
- Latency breakdown table
- Language channel and mix configuration (UI only in this release)

## Shared packages

### @videofy-live/shared-types

TypeScript interfaces shared across all TypeScript services and applications:

- `TranslationEvent` – phrase with full latency metadata and video timestamp
- `MediaStateEvent` – snapshot of stream state
- `AudioSyncDescriptor` – audio-to-video alignment metadata
- `AudioModePreferences` – interpretation vs replacement settings
- `SOCKET_EVENTS` – event name constants
- `languageRoom()` – room name helper

### @videofy-live/media-contracts

Zod validation schemas derived from the shared types:

- `TranslationEventSchema`
- `MediaStateEventSchema`

## Data flow: translation event

```
speech-worker
  → emits WORKER_TRANSLATION (Socket.IO, role=worker)
realtime-gateway
  → validates with TranslationEventSchema (Zod)
  → checks duplicate/stale via EventStore
  → emits TRANSLATION_EVENT to lang:<targetLanguage> room
  → emits TRANSLATION_EVENT to operators room
listener-web (in lang:fr room)
  → receives TRANSLATION_EVENT
  → displays translated text as subtitle
  → queues audio (URL is null in this release)
```

## Audio-video synchronisation (design intent)

Interpreted audio will naturally play several seconds behind the original speaker because the audio must pass through speech recognition, translation, and text-to-speech generation.

Each `TranslationEvent` carries a `videoTimestampMs` field so the system can later buffer the video to reduce the apparent lag.

See `docs/audio-video-synchronization.md` for details.
