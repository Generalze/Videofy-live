# Local development

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Node.js | 20.x |
| npm | 10.x |
| Python | 3.11 |

## First-time setup

### 1. Clone and install Node.js dependencies

```bash
git clone <repo-url>
cd videofy-live
npm install
```

### 2. Set up the Python virtual environment

```bash
cd services/speech-worker
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cd ../..
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

The defaults in `.env.example` work for local development.

## Running services

### All services at once (Unix)

```bash
./scripts/dev.sh
```

### All services at once (Windows)

```powershell
.\scripts\dev.ps1
```

### Individual services

```bash
# Realtime gateway – http://localhost:3001
npm run dev -w services/realtime-gateway

# Media ingest – http://localhost:3002
npm run dev -w services/media-ingest

# Listener web app – http://localhost:5173
npm run dev -w apps/listener-web

# Operator web app – http://localhost:5174
npm run dev -w apps/operator-web

# Speech worker (mock)
cd services/speech-worker
source .venv/bin/activate
SPEECH_WORKER_MODE=mock python3 main.py
```

## Running tests

```bash
# All TypeScript tests
npm test

# Specific workspace
npm run test -w packages/shared-types
npm run test -w packages/media-contracts
npm run test -w services/realtime-gateway

# Python tests
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

## Health checks

| Service | URL |
|---------|-----|
| Realtime gateway | http://localhost:3001/health |
| Media ingest | http://localhost:3002/health |
| Speech worker | http://localhost:8001/health |

## Ports

| Service | Default port |
|---------|-------------|
| realtime-gateway | 3001 |
| media-ingest | 3002 |
| speech-worker (health) | 8001 |
| listener-web (dev) | 5173 |
| operator-web (dev) | 5174 |
