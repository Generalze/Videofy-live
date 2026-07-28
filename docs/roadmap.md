# Roadmap

## Phase 1 - Foundation

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

## Phase 2 - Local speech pipeline

- [x] P2.1 media ingest and processing-session creation
- [x] P2.2 audio extraction and chunking
- [x] P2.3 timestamped transcription
- [x] P2.4 timestamped translation
- [x] P2.5 operator monitoring and recovery
- [x] P2.6 browser microphone capture
- [x] P2.7 local faster-whisper speech recognition provider
- [x] P2.8 local Argos translation provider
- [x] P2.9 Phase 2 validation and closure

## Phase 3 - Local generated audio and browser playback

- [x] P3.0 real local-provider smoke test
- [x] P3.1 local Piper text-to-speech foundation
- [x] P3.1A real Piper smoke test
- [x] P3.2 generated audio delivery to listener
- [x] P3.3 browser audio queue synchronization and timestamp-aligned playback
- [x] P3.4 interpretation-mode audio mixing
- [x] P3.5 replacement-mode audio
- [x] P3.6 Phase 3 browser playback validation and closure

## Phase 4 - WebRTC

- [x] P4.0 architecture and WebRTC signalling contracts
- [x] P4.1 browser broadcaster media capture
- [x] P4.2 client signalling and peer-session lifecycle orchestration
- [x] P4.3 backend WebRTC termination and broadcaster-to-server audio ingest
- [x] P4.4 WebRTC audio chunking and transcription-pipeline bridge
- [x] P4.5 listener WebRTC programme-audio delivery
- [x] P4.6 reconnect, failure recovery, security hardening, and observability
- [x] P4.7 full end-to-end browser validation and Phase 4 closure

## Phase 5 - Partner preview programme sources

- [x] P5.0 unified live and uploaded-video programme sources
- [x] P5.1 OBS/capture-device partner-preview hardening
- [x] P5.2 real open-source AI providers and operator language controls
- [ ] P5.3 partner-preview validation and closure (local technical validation and P5 recovery harness passed; physical-device, network/TURN, additional-browser, one-hour stability, and human language-quality acceptance pending)

## Phase 6 - Scale and production

- [ ] Multiple concurrent language channels
- [ ] Redis for distributed event state
- [ ] Authentication and access control
- [ ] Managed event lifecycle
- [ ] Transcripts and recordings
- [ ] Cloud deployment (Docker / Kubernetes)
- [ ] CDN distribution for HLS where a future HLS milestone explicitly requires it
- [ ] High listener concurrency
