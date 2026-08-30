# Mobile contract acceptance

`scripts/mobile-contract-acceptance.mjs` drives the whole HTTP surface the
phone app depends on, against a deployed Videofy Live, exactly as the app
does it. It exists for the days the APK cannot be built: what can still be
proven then is the contract, and this is that proof.

```
PROBE_PASSWORD_FILE=<path> node scripts/mobile-contract-acceptance.mjs https://staging.consummate7.com
```

Environment (names; the values are never printed):

| name | meaning |
| --- | --- |
| `PROBE_EMAIL` | the first probe account (default `probe-call-a@consummate7.com`) |
| `PROBE_PASSWORD_FILE` | file holding that account's password (required) |
| `PROBE_B_EMAIL` | a second probe account used as the messaging partner |
| `PROBE_B_PASSWORD_FILE` | its password file (falls back to `PROBE_PASSWORD_FILE`) |
| `PROBE_CREATED_PASSWORD_FILE` | where to save the credential of an account the run had to create |
| `STREAM_HANDLE` | a channel handle known to exist (default `meakzoe`) |

## What it transcribes

Every request is copied from `apps/mobile/src/api/client.ts` and
`apps/mobile/src/auth/authSessionManager.ts`: the same paths, methods, JSON
bodies and `authorization: Bearer` header, with `client: 'device'` on sign-in
so the 180-day device session class is what gets asserted.

Sections, in order: session (sign-in, `/sessions/current`, `/sessions/renew`,
bad token), profile (`/me`, `/me/counts`, `PATCH /profile` round trip with
restore, avatar, verification), contacts and presence, messaging (text, read
back, conversations, read receipt, mode, a real 1 s WAV voice note and its
byte-exact fetch, the translated-voice route, edit/reaction/pin/search/hide/
undo/mute), channels (`/streams/<handle>`, follow with reminder, interest,
`/me/counts.following`), calls (`/calls/public`, `/calls/:id/status`,
`/calls/direct/:id` anonymous refusal), `GET /media/voice-profiles/mine`,
`/rings`, and push device registration with a fake token followed by its
revocation.

## What it leaves behind

Messages are retracted, the device is revoked, profile fields are restored,
a follow or contact the run created is removed. Accounts cannot be deleted
over HTTP; if the run had to create a partner account it says so at the end.

## What it cannot prove

Anything native: push delivery, ringing on a locked phone, microphone
capture, the call screen. Those need the APK on a device. A PASS here means
the server side of every request the phone makes answers with the shape the
phone parses.
