# connect-reference-server

The Connect Reference product server (P6.6): durable conference ROOMS, host
keys, and join tokens — built entirely on the PUBLIC Videofy surface, exactly
like an external customer. Every Connect interaction goes through
`@videofy/server-sdk`; the only other runtime dependencies are `express` and
`zod` from public npm.

## The product model

A ROOM (`room_...`, durable, stored in `connect-reference-rooms.json`) maps to a
Connect call that is deliberately ephemeral. The mapping lives in memory
only: when the Videofy gateway restarts and forgets the call, the next join
notices (CALL answers not-found/ended), creates a fresh conference call in
the room's mode, and replaces the mapping — one extra create, no ceremony.
Establishment is single-flight per room, so two simultaneous joiners can
never mint two calls.

The host holds the room's `host_...` key, shown ONCE at creation. Only its
sha256 hash is stored; verification hashes the presented key and compares
with `timingSafeEqual`. Members need no account: the browser keeps a stable
`guest_...` id in localStorage.

## Environment

| Variable              | Required | Default                        |
| --------------------- | -------- | ------------------------------ |
| `VIDEOFY_API_KEY`     | yes      | — (`vfk_...`, server-side only) |
| `VIDEOFY_CONNECT_URL` | no       | `http://localhost:3001`        |
| `REF_ROOMS_PATH`       | no       | `./connect-reference-rooms.json` |
| `PORT`                | no       | `8790`                         |

`REF_ROOMS_PATH` resolves against the process working directory — prefer an
ABSOLUTE path so restarts from another directory keep finding the same rooms.
Writes are atomic (temp file, then rename).

## Routes

| Route                                | What it does |
| ------------------------------------ | ------------ |
| `POST /api/rooms`                    | create a room; answers `{room, hostKey}` — the key's only appearance |
| `GET  /api/rooms`                    | rooms with `live` + `participantCount`; degrades to `live:false` when Connect is down, never errors |
| `GET  /api/rooms/:roomId`            | room detail; live members as `{index, displayName, speakLanguage, hearLanguage, connected}` |
| `POST /api/rooms/:roomId/join-tokens`| ensure a live call, mint via the SDK; answers `{token, expiresAt}` |
| `POST /api/rooms/:roomId/mode`       | host-only; forwards the mode switch to the live call and persists it |
| `POST /api/rooms/:roomId/end`        | host-only; ends the live call, keeps the room as history |
| `GET  /api/config`                   | `{languages, limits}` proxied from Connect capabilities, cached 60s, stale-served on outage |

Failures use the KC envelope `{error: {code, message}}` with `REF_`-prefixed
codes. The `vfk_` key and Connect `vc_` ids never appear in any response or
log line — upstream failures are re-told in Connect Reference words and every
outgoing string is scrubbed besides.

## Running

```
npm run dev        # tsx watch, port 8790
npm test           # vocabulary guard + vitest
npm run typecheck
```

The purity law is enforced twice here: `scripts/check-vocab.mjs` fails the
test run if any source names internal Videofy vocabulary, and
`src/__tests__/purity.test.ts` asserts the dependency allowlist.
