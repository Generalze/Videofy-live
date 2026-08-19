# Connect Reference — web

The Connect Reference conference app: a first-party Videofy product built
exactly the way an external customer would build it. The ONLY Videofy code
this package touches is the public browser SDK, `@videofy/connect`; every
server conversation goes to the Connect Reference server (port 8790) in
product vocabulary — room ids (`room_…`), join tokens, host keys. The project
key and Connect's public ids never reach this app.

## Screens

- **Rooms** — every room with mode badge, schedule and live headcount; a
  create form (Normal or Translated, optional schedule); the host key
  revealed once at creation, with copy button and localStorage retention.
- **Lobby** — display name, languages from `/api/config`, a camera mirror on
  the plain `navigator.mediaDevices` API (tracks released the moment the
  preview stops or the person joins), and Join. A normal room shows no
  hearing-language or caption controls at all.
- **Room** — video tiles (`attachVideo`), per-speaker mute/volume for this
  listener's ears only, captions strip and transcript panel while the room
  runs translated, mid-call hearing-language change, audio-mode selector,
  mic/camera toggles, an enable-sound affordance when the browser blocks
  playback, and the host panel (mode switch, end room) for whoever holds the
  room's `host_` key. When the credential in hand is finished, the app fetches
  a fresh token from the KC server and rejoins on a bounded, visible plan.

## Running

```sh
npm run dev        # Vite on http://localhost:5300, /api proxied to :8790
npm test           # SDK dist build, vocab guard, then vitest
npm run typecheck
```

Environment: `VITE_GATEWAY_URL` (default `http://localhost:3001`) is the
Videofy gateway origin the SDK dials; `REF_SERVER_URL` points the dev proxy
at the Connect Reference server.

## The purity law

`scripts/check-vocab.mjs` fails the build if any source mentions internal
Videofy vocabulary, and `src/__tests__/purity.test.ts` asserts the
dependency allowlist. Screen tests additionally assert that rendered markup
carries no internal identifiers.
