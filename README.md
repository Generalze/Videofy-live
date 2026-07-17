# Videofy Live

Real-time multilingual video streaming and spoken-audio interpretation platform.

This repository is a Phase 1 mock proof of concept. It does not include real AI
speech recognition, translation, text-to-speech, production streaming,
authentication, billing, databases, or cloud integrations.

## Architecture

```text
apps/
  listener-web/      React + Vite audience player
  operator-web/      React + Vite operator dashboard

services/
  realtime-gateway/  Node.js + Express + Socket.IO event routing hub
  media-ingest/      Node.js mock media-state broadcaster
  speech-worker/     Python Socket.IO mock translation worker

packages/
  shared-types/      TypeScript event interfaces and Socket.IO names
  media-contracts/   Zod validation schemas
```

## Prerequisites

- Node.js >= 20
- npm >= 10
- Python >= 3.11

## Windows PowerShell Setup

```powershell
git clone https://github.com/masterzee001/videofy-live.git
cd videofy-live
git checkout copilot/initial-repo-foundation

npm ci

cd services\speech-worker
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .[dev]
cd ..\..

Copy-Item .env.example .env
.\scripts\dev.ps1
```

Local URLs:

- Listener app: http://localhost:5173
- Operator app: http://localhost:5174
- Realtime gateway health: http://localhost:3001/health
- Media ingest health: http://localhost:3002/health
- Speech worker health: http://localhost:8001/health

## Unix / macOS Setup

```bash
npm ci
cd services/speech-worker
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
cd ../..
cp .env.example .env
./scripts/dev.sh
```

## What Works In Phase 1

- Browser listener shows a deterministic animated mock video using
  `canvas.captureStream()`.
- Python mock worker connects to the gateway with the official
  `python-socketio` client and emits `worker:translation`.
- Gateway validates translation and media-state events before broadcast.
- Translation ordering is scoped by `eventId + targetLanguage`.
- Listener queues translated audio clips and generates short local mock tones
  when real audio URLs are absent.
- Operator dashboard shows gateway, media ingest, and speech worker connection
  status from gateway status events.
- Operator mock controls can start/stop the mock stream, trigger a phrase, and
  reset the mock sequence. Production use requires operator authorization.

## Validation

```powershell
npm ci
npm test
npm run lint
npm run typecheck
npm run build

cd services\speech-worker
.\.venv\Scripts\python.exe -m pytest -v
cd ..\..

npm run test:integration
```

## Known Limitations

- No OpenAI API integration or cloud AI provider integration.
- No Whisper, translation model, Piper, voice cloning, or lip-sync.
- No Zoom, Teams, Google Meet, WebRTC, HLS, or RTMP production infrastructure.
- No authentication, billing, databases, Redis, or production deployment.
- Mock audio is a generated browser tone, not translated speech.
- Mock video is browser-generated canvas animation, not a live event feed.

See `docs/roadmap.md` for planned phases.
