# Videofy Live

> Real-time multilingual video streaming and audio interpretation platform.

Videofy Live allows audiences to watch a live event while hearing the speaker in a language they understand. This repository is the proof-of-concept foundation — separate from Videofy Studio, Videofy Watch, and Videofy Promote.

## Architecture

```
apps/
  listener-web/      React + Vite – audience-facing player and subtitle UI
  operator-web/      React + Vite – internal event management dashboard

services/
  realtime-gateway/  Node.js + Express + Socket.IO – event routing hub
  media-ingest/      Node.js – mock video source and stream-state broadcaster
  speech-worker/     Python – mock translation phrase generator

packages/
  shared-types/      TypeScript interfaces (TranslationEvent, MediaStateEvent, …)
  media-contracts/   Zod validation schemas
```

## Quick start

### Prerequisites

- Node.js ≥ 20
- npm ≥ 10
- Python ≥ 3.11

### 1 – Install Node.js dependencies

```bash
npm install
```

### 2 – Set up Python speech worker

```bash
cd services/speech-worker
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cd ../..
```

### 3 – Configure environment

```bash
cp .env.example .env
# Edit .env as needed — defaults work for local development
```

### 4 – Start all services (Unix / macOS)

```bash
./scripts/dev.sh
```

Or start services individually:

```bash
# Terminal 1 – Realtime Gateway
npm run dev -w services/realtime-gateway

# Terminal 2 – Media Ingest
npm run dev -w services/media-ingest

# Terminal 3 – Listener app  →  http://localhost:5173
npm run dev -w apps/listener-web

# Terminal 4 – Operator app  →  http://localhost:5174
npm run dev -w apps/operator-web

# Terminal 5 – Speech worker (mock mode)
cd services/speech-worker && source .venv/bin/activate
SPEECH_WORKER_MODE=mock python3 main.py
```

### Windows

```powershell
.\scripts\dev.ps1
```

## Testing

```bash
# TypeScript packages and gateway
npm test

# Individual workspace
npm run test -w packages/shared-types
npm run test -w packages/media-contracts
npm run test -w services/realtime-gateway

# Python speech worker
cd services/speech-worker
source .venv/bin/activate
python3 -m pytest tests/ -v
```

## Type checking

```bash
npm run typecheck
```

## Building for production

```bash
npm run build
```

## Mock end-to-end demonstration

1. Start the realtime gateway (`npm run dev -w services/realtime-gateway`)
2. Start the media-ingest service (`npm run dev -w services/media-ingest`)
3. Start the listener app and open http://localhost:5173
4. Start the operator app and open http://localhost:5174
5. Click **Start Listening** in the listener app
6. Start the Python speech worker in mock mode
7. Watch translated phrases appear in the listener subtitle panel
8. Watch the operator dashboard update with phrase log and media state

Actual generated speech audio is not included in this release. The event model and browser audio queue are ready for audio files in the next development phase.

## Known limitations

- No production streaming (WebRTC, HLS, RTMP, Zoom, Teams, Meet)
- No generated speech audio (text-only in this release)
- No real speech recognition or translation (mock phrases only)
- No authentication, billing, or databases
- Audio-video synchronisation is designed but not enforced in this release
- Interpreted audio will naturally lag the speaker by several seconds in production

## Recommended next phase

1. Browser microphone capture or local audio file input
2. Local Whisper speech recognition
3. Local OPUS-MT or Argos translation
4. Local Piper text-to-speech
5. Browser audio queue with video timestamp alignment
6. Interpretation-mode audio mixing

See `docs/roadmap.md` for the full roadmap.

## Documentation

| File | Description |
|------|-------------|
| [docs/architecture.md](docs/architecture.md) | System components and data flow |
| [docs/product-scope.md](docs/product-scope.md) | Product boundary and approved scope |
| [docs/local-development.md](docs/local-development.md) | Detailed setup instructions |
| [docs/realtime-event-contract.md](docs/realtime-event-contract.md) | Socket.IO event schemas |
| [docs/media-streaming-plan.md](docs/media-streaming-plan.md) | Future streaming integration plan |
| [docs/audio-video-synchronization.md](docs/audio-video-synchronization.md) | Sync design and trade-offs |
| [docs/roadmap.md](docs/roadmap.md) | Development phases |
