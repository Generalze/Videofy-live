# Quickstart: your first translated call

By the end of this page two browsers are in the same call, each speaking one
language and hearing the other translated. Total new code: one small server
file and one small web page.

## What you need

- A running Videofy gateway (the development demo listens on port **3001**;
  `GATEWAY_PORT` changes it).
- Node.js **18 or newer** for your server.
- The two SDK packages, `@videofy/server-sdk` and `@videofy/connect`. In the
  development demo they are installed from tarballs produced with `npm pack`
  in the Videofy repository (`packages/connect-server-sdk` and
  `packages/connect-sdk`); once published, a plain `npm install` works the
  same way.

## Step 1 — Configure the gateway

Connect is off until the gateway has both of these:

```bash
# Signs join tokens. Minimum 32 characters; keep it secret, rotate by redeploy.
CONNECT_AUTH_SECRET="a-long-random-string-of-at-least-32-chars"

# Where the project registry lives (default: ./connect-projects.json).
CONNECT_PROJECTS_PATH="./connect-projects.json"
```

Without a project registry, every `/v1` request answers `503
UNSUPPORTED_CAPABILITY`. Without the secret, everything works except minting
join tokens. A malformed registry file stops the gateway at startup on
purpose — silently running with half a security config is worse.

In the development demo, start the gateway from the Videofy repository with
both variables set:

```bash
CONNECT_AUTH_SECRET="a-long-random-string-of-at-least-32-chars" CONNECT_PROJECTS_PATH="/absolute/path/to/connect-projects.json" npm run dev -w services/realtime-gateway
```

(`CONNECT_PROJECTS_PATH` is resolved against the gateway's own working
directory, so an absolute path is the reliable choice.)

**Translated calls need one more service.** Speech recognition, translation,
and generated voices run in the media-ingest service — without it, calls
connect and original audio flows, but no captions or translated speech are
produced. Start it alongside the gateway:

```bash
npm run dev -w services/media-ingest
```

Its AI providers warm up on start (a few seconds to a minute); captions begin
flowing once it logs `AI provider warmed`.

## Step 2 — Provision a project

A *project* is your credential scope: an id, an API key, and the browser
origins allowed to join with your tokens. On the machine that runs the
gateway, in the Videofy repository:

```bash
npm run connect:project:create -- \
  --name "My App" \
  --origin http://localhost:5173
```

Flags: `--origin` is repeatable and exact-match (no wildcards);
`--allow-originless` permits joins with no `Origin` header (native or
scripted clients — off by default); `--path` overrides the registry file.

The output shows your `proj_...` id and — **exactly once** — your API key:

```
  API key (shown ONCE, stored only as a sha256 hash — save it now):

    vfk_dev_9f2c...
```

Save the key now: only its hash is stored, so it cannot be shown again (lose
it and you provision a new project). Restart the gateway to pick up the new
registry.

## Step 3 — Secrets in the right places

- `vfk_...` API key → your **server's** environment (`VIDEOFY_API_KEY`
  below). Never in a browser bundle, never in client-side code.
- `CONNECT_AUTH_SECRET` → the **gateway's** environment only. Your code never
  sees it.
- Join tokens → minted per person, handed to the browser over your own
  authenticated channel, used once.

## Step 4 — Server: create a call, mint tokens

```js
// server.mjs — Node 18+, run with: VIDEOFY_API_KEY=vfk_dev_... node server.mjs
import http from 'node:http';
import { createVideofyConnect } from '@videofy/server-sdk';

const videofy = createVideofyConnect({
  apiKey: process.env.VIDEOFY_API_KEY,
  baseUrl: 'http://localhost:3001',
});

// One demo call for everyone who hits this server.
const call = await videofy.calls.create({
  type: 'personal',          // 2 seats; 'conference' has 4
  mode: 'translated',
});

http.createServer(async (req, res) => {
  // /token?subject=customer_1&name=Ada&speak=en&hear=en
  const url = new URL(req.url, 'http://localhost:8787');
  if (url.pathname !== '/token') { res.writeHead(404).end(); return; }
  const grant = await videofy.joinTokens.create(call.callId, {
    participant: {
      subject: url.searchParams.get('subject'),   // YOUR stable id for this person
      displayName: url.searchParams.get('name'),
      speakLanguage: url.searchParams.get('speak'),
      hearLanguage: url.searchParams.get('hear'),
    },
    // expiresInSeconds: 300  (default; 1..900)
  });
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.end(JSON.stringify({ token: grant.token }));
}).listen(8787);

console.log('call', call.callId, '— token server on :8787');
```

In production the `/token` endpoint sits behind your own login: `subject` is
*your* user id (Videofy never interprets it), and minting a token is how you
admit someone to a call.

## Step 5 — Browser: join

```js
// app.js — bundle with your usual tooling (the dev origin here is Vite's :5173)
import { createVideofyClient } from '@videofy/connect';

const params = new URLSearchParams(location.search);
const reply = await fetch(
  `http://localhost:8787/token?subject=${params.get('me')}` +
  `&name=${params.get('name')}&speak=${params.get('lang')}&hear=${params.get('lang')}`,
);
const { token } = await reply.json();

const client = createVideofyClient({ baseUrl: 'http://localhost:3001' });
const call = await client.join({ token, media: { microphone: true } });

call.on('state', (snapshot) => {
  document.querySelector('#status').textContent =
    `${snapshot.connection} — ${snapshot.participants.length} other participant(s)`;
});
call.on('caption', (caption) => {
  document.querySelector('#caption').textContent =
    `${caption.displayName}: ${caption.text}`;
});
// Browsers require a user gesture before audio may play:
call.on('audioBlocked', () => {
  const button = document.querySelector('#enable-audio');
  button.hidden = false;
  button.onclick = () => call.enableAudio();
});
call.on('needsNewJoinToken', () => {
  // The credential is finished (restart, or the seat was reaped).
  // Fetch a fresh token from your server and join again.
});
```

## Step 6 — Hear the translation

Open two browser tabs (or two machines) against your page:

```
http://localhost:5173/?me=customer_1&name=Ada&lang=en
http://localhost:5173/?me=customer_2&name=Beatriz&lang=es
```

Ada speaks English and hears Beatriz in English; Beatriz speaks Spanish and
hears Ada in Spanish. Captions arrive in each listener's own language. Each
participant's `deliveryState` in the snapshot tells you how you are hearing
them right now: `translated`, `original`, or `reduced` (original held quietly
under a live interpretation).

## When something refuses

| Symptom | Likely cause |
| --- | --- |
| `503 UNSUPPORTED_CAPABILITY` from `/v1` | Gateway has no project registry, or (token minting only) no `CONNECT_AUTH_SECRET` |
| `401 AUTH_INVALID_KEY` | Wrong or missing API key in `Authorization: Bearer ...` |
| Join refused `FORBIDDEN_ORIGIN` | Your page's origin is not in the project's `allowedOrigins` — re-provision or add the origin, then mint a **fresh** token (the refused one is burned) |
| Join refused `AUTH_TOKEN_USED` | Tokens are single-use; mint one per join attempt |
| Everything dead after a gateway restart | Expected: calls and tokens are in-memory. Create a new call, mint new tokens |

Next: the [worked examples](README.md#documentation-map), or
[Authentication & security](auth-security.md) for the rules behind steps 2–3.
