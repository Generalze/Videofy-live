# Roadmap

## Phase 1 – Foundation (this release)

- [x] Monorepo structure (npm workspaces)
- [x] Shared TypeScript interfaces (`TranslationEvent`, `MediaStateEvent`, `AudioSyncDescriptor`)
- [x] Zod validation schemas
- [x] Realtime gateway (Express + Socket.IO)
- [x] Event deduplication and ordered delivery per event-language channel
- [x] Mock media-ingest service
- [x] Mock speech worker (Python Socket.IO client)
- [x] Listener web application (React + Vite)
- [x] Browser mock video feed and basic mock translated-audio queue
- [x] Operator web dashboard (React + Vite)
- [x] Mock end-to-end demonstration
- [x] Documentation

## Phase 2 – Local speech pipeline

- [x] P2.1 media ingest and processing-session creation
- [x] P2.2 audio extraction and chunking
- [x] P2.3 timestamped transcription
- [x] P2.4 timestamped translation
- [x] P2.5 operator monitoring and recovery
- [x] P2.6 browser microphone capture
- [x] P2.7 local faster-whisper speech recognition provider
- [x] P2.8 local Argos translation provider
- [x] P2.9 Phase 2 validation and closure

## Phase 3A - Local generated audio foundation

- [x] P3.0 real local-provider smoke test
- [x] P3.1 local Piper text-to-speech foundation
- [x] P3.1A real Piper smoke test
- [ ] Generated audio file delivery to listener
- [ ] Browser audio queue with video timestamp alignment
- [ ] Interpretation-mode audio mixing (Web Audio API)
- [ ] Replacement-mode audio (mute original)

## Phase 3B - Local video and HLS

- [ ] Local camera/microphone input
- [ ] FFmpeg audio extraction from video
- [ ] HLS packaging (ffmpeg + nginx-rtmp)
- [ ] HLS playback in listener (`<video>` with hls.js)
- [ ] Video buffering for sync offset

## Phase 4 – WebRTC

- [ ] mediasoup or Janus WebRTC ingest
- [ ] WebRTC playback in listener
- [ ] Low-latency audio delivery

## Phase 5 – External integrations

- [ ] Zoom audio/video capture
- [ ] Microsoft Teams capture
- [ ] Google Meet capture
- [ ] OBS WebSocket integration
- [ ] RTMP ingest

## Phase 6 – Scale and production

- [ ] Multiple concurrent language channels
- [ ] Redis for distributed event state
- [ ] Authentication and access control
- [ ] Managed event lifecycle
- [ ] Transcripts and recordings
- [ ] Cloud deployment (Docker / Kubernetes)
- [ ] CDN distribution for HLS
- [ ] High listener concurrency
