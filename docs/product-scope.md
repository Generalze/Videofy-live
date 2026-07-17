# Product scope

## What Videofy Live is

Videofy Live is a real-time multilingual video streaming and audio interpretation platform.

It allows audiences to watch a live event while hearing the speaker in a language they understand.

## What this repository contains

This repository is specifically for Videofy Live.

It is **separate** from:

- Videofy Studio
- Videofy Watch
- Videofy Promote

## Approved current scope (this PR)

- Repository foundation and monorepo structure
- Listener web interface with mock video and subtitle display
- Operator web dashboard with event monitoring
- Mock video-source and stream-state events
- Mock translation events (English → French sample phrases)
- Audio/video timestamp contracts
- End-to-end mock demonstration

## Explicitly excluded from this release

- Production deployment or cloud infrastructure
- Billing, authentication, or user accounts
- Databases or Redis
- Voice cloning or lip-sync
- Mobile applications
- Production RTMP, WebRTC, or HLS infrastructure
- Zoom SDK, Microsoft Teams SDK, or Google Meet SDK
- Cloud AI APIs (no paid services)
- Downloaded local AI models (no large files)
- Production speech recognition
- Production text translation
- Production text-to-speech or generated audio
- Production audio-video synchronisation
- Production audio mixing
- Recordings or transcripts
