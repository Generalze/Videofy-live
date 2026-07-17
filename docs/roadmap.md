# Roadmap

## Phase 1 – Foundation (this release)

- [x] Monorepo structure (npm workspaces)
- [x] Shared TypeScript interfaces (`TranslationEvent`, `MediaStateEvent`, `AudioSyncDescriptor`)
- [x] Zod validation schemas
- [x] Realtime gateway (Express + Socket.IO)
- [x] Event deduplication and sequence tracking
- [x] Mock media-ingest service
- [x] Mock speech worker (Python)
- [x] Listener web application (React + Vite)
- [x] Operator web dashboard (React + Vite)
- [x] Mock end-to-end demonstration
- [x] Documentation

## Phase 2 – Local speech pipeline

- [ ] Browser microphone capture
- [ ] Local Whisper (faster-whisper) speech recognition
- [ ] Local OPUS-MT or Argos translation
- [ ] Local Piper text-to-speech
- [ ] Generated audio file delivery to listener
- [ ] Browser audio queue with video timestamp alignment
- [ ] Interpretation-mode audio mixing (Web Audio API)
- [ ] Replacement-mode audio (mute original)

## Phase 3 – Local video and HLS

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
