# Videofy Live

Real-time multilingual video streaming and spoken-audio interpretation platform.

This repository is a local-first working prototype. It runs a real open-source
AI interpretation pipeline (energy-gate VAD, faster-whisper speech recognition,
OPUS-MT translation with M2M100/NLLB-200 fallback, Piper and MMS
text-to-speech) over live WebRTC capture, uploaded media, and RTMP/HLS
programme sources. It does not include production streaming infrastructure,
authentication, billing, databases, or cloud integrations.

## Phase Status

Phases 1 through 5 are complete. P6-G0 governance and the additive P6.0
participant/call/recipient-routing contracts are implemented. The working Live
runtime remains the Phase 5 partner preview: P6.0 does not claim a native call
runtime, call UI, external-platform adapter, or commercial launch.

The platform includes the listener app with a nine-language viewer menu
(Spanish, French, Portuguese, Arabic, Russian, Greek, Yoruba, Chinese, Latin),
the operator dashboard with source- and target-language controls, the
Socket.IO gateway with WebRTC signalling and listener delivery, the
media-ingest service that orchestrates the local AI pipeline, shared event
contracts, local development launchers, and automated validation. Programme
sources cover browser camera/screen capture, uploaded video and audio files,
OBS Virtual Camera, and RTMP ingest via MediaMTX with HLS playback. The
validated end-to-end speech path is English to Spanish; other catalogue
languages are enabled per configured model and voice. The Python speech-worker
remains a mock contract worker used for tests; real AI providers run inside
media-ingest through the `.venv-ai` runtime (see
[docs/AI_RUNTIME_SETUP.md](docs/AI_RUNTIME_SETUP.md)).

Current limitations remain intentional: no production deployment, no
authentication or authorization, no database, no billing, no persistence, and
local polling transport is used for Windows compatibility.

See
[docs/P6_0_IMPLEMENTATION_REPORT.md](docs/P6_0_IMPLEMENTATION_REPORT.md) for the
P6.0 contract-extraction evidence,
[docs/P6_G0_CLOSURE_REPORT.md](docs/P6_G0_CLOSURE_REPORT.md) for the governance
and provider-boundary evidence,
[docs/PHASE_5_PARTNER_PREVIEW_CLOSURE_REPORT.md](docs/PHASE_5_PARTNER_PREVIEW_CLOSURE_REPORT.md)
for the Phase 5 closure record,
[docs/PHASE_5_MULTI_LANGUAGE_VIEWER_DELIVERY.md](docs/PHASE_5_MULTI_LANGUAGE_VIEWER_DELIVERY.md)
for the multi-language viewer design, and
[docs/PHASE_1_CLOSURE.md](docs/PHASE_1_CLOSURE.md) through the Phase 4 closure
report for earlier phase records.

## Architecture

```text
apps/
  listener-web/      React + Vite audience player
  operator-web/      React + Vite operator dashboard

services/
  ai-registry/       Runtime-profile and provider/model/voice policy registry
  language-router/   Pure recipient-output and legacy programme audience policy
  realtime-gateway/  Node.js + Express + Socket.IO event routing and WebRTC signalling hub
  media-ingest/      Node.js media processing service: uploads, audio extraction,
                     faster-whisper transcription, OPUS-MT/M2M100/NLLB-200 translation,
                     Piper/MMS text-to-speech orchestration
  speech-worker/     Python Socket.IO mock translation worker (contract tests)

packages/
  participant-contracts/  Canonical participant, media, capability and preference contracts
  call-contracts/         Call/session, routed-event, programme projection and compatibility contracts
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
git checkout main

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

## What Works Today

- Live programme capture in the browser (camera, screen/tab, OBS Virtual
  Camera) delivered to listeners over WebRTC, plus uploaded video/audio files
  and RTMP ingest via MediaMTX with HLS playback.
- Real local AI pipeline in media-ingest: energy-gate VAD chunking, faster-whisper
  transcription, OPUS-MT translation with M2M100/NLLB-200 fallback, and Piper
  or MMS text-to-speech (validated end-to-end for English to Spanish).
- Listener viewer with a per-session language menu, incremental captions, and
  a translated-audio queue with sidechain ducking of programme audio.
- Operator dashboard with source-language detection/confirmation controls,
  target-language readiness, AI provider status, and session monitoring with
  pause/resume/retry recovery actions.
- Gateway validates translation and media-state events before broadcast, and
  translation ordering is scoped by `eventId + targetLanguage`.
- Python mock speech worker still connects with the official `python-socketio`
  client and emits `worker:translation` for contract and integration tests.

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

- No cloud AI provider integration; all AI models run locally and require the
  separate `.venv-ai` runtime described in
  [docs/AI_RUNTIME_SETUP.md](docs/AI_RUNTIME_SETUP.md).
- No voice cloning or lip-sync.
- No native Zoom, Teams, or Google Meet meeting capture; RTMP/HLS ingest is a
  local MediaMTX bridge, not production streaming infrastructure.
- No authentication, billing, databases, Redis, or production deployment.
- TURN relay and separate-network WebRTC delivery are not yet validated.
- Only English to Spanish is validated end-to-end with human-reviewable
  output; other languages depend on configured models and voices, and
  NLLB-200 fallback is licensed for non-commercial use only.

See [Architecture V3](docs/VIDEOFY_MASTER_ARCHITECTURE.md) and the
[Phase 6 execution plan](docs/PHASE_6_EXECUTION_PLAN.md) for the authoritative sequence;
`docs/roadmap.md` is historical context.

## Ownership and License

Repository owner: **masterzee001**.

Videofy is distributed under the **Videofy by TAC Proprietary Software
License**. All Rights Reserved. See [LICENSE.md](LICENSE.md).
