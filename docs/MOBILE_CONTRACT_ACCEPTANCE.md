# Mobile contract acceptance

## What a green run establishes, and what it does not

**Founder ruling, 30 August 2026.** A full pass of this suite establishes
**"server contract ready for mobile"**. It **cannot** establish **"Android
client accepted"**.

Nothing in this suite runs the APK. It drives the server the way the app
drives it -- the same paths, methods, headers, bodies and sequencing -- and so
it can prove that every request the phone makes is answered with the shape the
phone parses. It cannot prove that the phone makes them: push delivery,
ringing on a locked device, the native answer receiver, microphone capture,
the call screen, the mesh and the audio are all outside it. Those are the
**physical APK acceptance on real devices, held to 1 September**, and no
number of passes here substitutes for it.

## The summary line, and the exit status

The summary is four numbers and always all four, including the zeroes:

```
118/118 checks passed — 0 failed, 0 blocked, 0 skipped
```

`118/118 checks passed` on its own is the line somebody screenshots, and it is
equally true of a run that verified two thirds of what its name covers. So the
other three numbers are printed beside it whatever they are: a reader who sees
`0 blocked` has learned something, a reader who sees no such word has learned
nothing.

**A BLOCKED check fails the run** (founder principle, 30 August 2026: *a gate
that passes while verifying nothing is the failure mode we hunt*). Keeping a
block out of the pass count was only half the fix -- the exit status is what CI,
a deploy script and `echo $?` actually read, and while it stayed `0` the suite
still announced success for a run the deployment had denied evidence to.

| outcome | counted as a pass | exit status |
| --- | --- | --- |
| `PASS` | yes | 0 |
| `FAIL` | no | **1** |
| `BLOCKED` -- the deployment withheld something the check needs | no | **1**, unless `--allow-blocked` |
| `SKIP` -- this invocation was not given the fixture | no | 0 |

The difference between a block and a skip is *whose* answer it is. A block is
the deployment's: the probe is unverified, the capability is absent, the
directory listed no channel. A skip is ours: `PROBE_B_EMAIL` was not set, so
there is no partner to message. Only the first is evidence about the thing
under test, so only the first fails the run.

## Running it

```
PROBE_PASSWORD_FILE=<path> PROBE_B_EMAIL=probe-call-b@consummate7.com \
  node scripts/mobile-contract-acceptance.mjs https://staging.consummate7.com
```

Options (the base URL is positional and may appear before or after them):

| option | meaning |
| --- | --- |
| `--allow-blocked` | exit `0` even with blocked checks, because the founder has SEEN them and accepted them. The blocks are still printed, still excluded from the pass count, and the run still says out loud that they were accepted rather than resolved. |

An unrecognised option is refused with exit `2` rather than ignored: silently
dropping a misspelt `--allow-blocked-checks` would hand back exactly the exit
status the caller was trying to change.

Environment (names; the values are never printed):

| name | meaning |
| --- | --- |
| `PROBE_EMAIL` | the first probe account (default `probe-call-a@consummate7.com`) |
| `PROBE_PASSWORD_FILE` | file holding that account's password (required) |
| `PROBE_B_EMAIL` | a second probe account: the messaging partner and the callee |
| `PROBE_B_PASSWORD_FILE` | its password file (falls back to `PROBE_PASSWORD_FILE`) |
| `PROBE_HOST_EMAIL` | an account holding `session.host`, used to CREATE a direct call |
| `PROBE_HOST_PASSWORD_FILE` | its password file (falls back to `PROBE_PASSWORD_FILE`) |
| `PROBE_CREATED_PASSWORD_FILE` | where to save the credential of an account the run had to create |
| `STREAM_HANDLE` | a channel handle known to exist (default `meakzoe`) |
| `PROBE_NO_ANSWER_WAIT` | `0` skips the 35 s wait that proves NO ANSWER |

`socket.io-client` must be installed (it is, from the repo root): two of the
phone's surfaces -- the programme directory and creating a direct call -- have
no HTTP form at all, by design, and are driven over a real socket.

## The surfaces it covers

Except for the one exception named below, every request is transcribed from
`apps/mobile/src`: `api/client.ts`, `auth/authSessionManager.ts`,
`call/directCallApi.ts`, `call/callConnection.ts`, `api/channelDirectory.ts`
and `push/deviceRegistrationService.ts`. Not simplified substitutes -- the same
header shape, the same `client: 'device'` sign-in class, the same
`role: 'call-participant'` socket handshake.

**The exception: `GET /channels/mine` is not a phone route.** It belongs to the
operator console (`apps/operator-web/src/premium/channelIdentity.ts`). It is
driven here only as the owner-side baseline for the rows beneath it: the public
views the phone does reach must be shown NOT to carry `ownerAccountId`, and
without first reading the owner view the suite would be asserting a field is
absent without ever establishing it exists. Those rows are a statement about
the server's channel serialisation, not about the phone's own request set.

| surface | what is driven |
| --- | --- |
| authentication | `POST /sessions` as `client: 'device'`, the 180-day class, `/sessions/current`, `/sessions/renew`, a bad token refused 401, sign-out killing the token |
| profile / avatar | `/me`, `/me/counts`, `PATCH /profile` round trip and restore, `/avatars/:id`, `/verification` |
| contacts | `/contacts`, `/contacts/suggestions`, request / accept by username, `/presence/heartbeat`, `/presence` |
| messages | send, read back, conversations with unread, read receipt, mode, edit, reaction, pin + pinned list, search, hide + undo, per-thread mute |
| voice notes | a real 1 s 16 kHz WAV posted to `/messages/with/:id/voice`, fetched back byte-identical, refused anonymously |
| translated-note assets | `translatedAudioAvailable` agreed with `GET /messages/:id/voice/translated`; a present asset must be real `audio/*` bytes; refused without a session |
| call creation | `POST /contacts/:id/ring` (the phone joins first and rings second), `reachedDevices`, `GET /rings`, `POST /rings/:id/dismiss` |
| ringing ack | `POST /calls/direct/:id/ringing` -> `{ live }`, and the state moving `calling -> ringing` |
| decline / answer lifecycle | `POST .../answering` -> `{ held }`, the callee's socket join marking `answered`, `POST .../decline` -> `declined`, the 30 s window closing to `no_answer`, hang-up ending it |
| stale calls | a call the server never had: 404 to the pre-join check, `live=false`, `held=false`, `declined=false` -- a stale push must never ring a phone |
| call history | `GET /messages/with/:id` as ONE timeline, `kind: 'call'` items with direction/outcome/duration, newest first |
| C7 Streams | `GET /streams/:handle`, unknown handle 404, follow with reminder, `/channels/interest`, `/me/counts.following` |
| channel identity (server serialisation; the owner route is the console's, not the phone's -- see above) | `GET /channels/mine` (owner view, `ownerAccountId` present) against the two public views, which must not carry it, and must agree on handle / name / category / visibility |
| programme listing | a real listener socket, `channel:directory`, parsed by the phone's own rules: tiered visibility required, `handle` on `CHANNEL_HANDLE_SHAPE` or null, `category` one of the twelve controlled ids or null, `avatarUrl` and `currentProgramme` present |
| person profile | `GET /profiles/:accountId`: `spokenLanguage` present, the listening language absent, twelve owner-only names absent, no field the phone does not parse, 401 anonymously, 404 for an unknown account |
| ICE / TURN | `GET /webrtc/ice`: STUN and a TURN entry, TURN over UDP and TCP, the TURN host resolved and checked against Cloudflare's published edge ranges and against the app host's own addresses, and the credential proved time-limited -- by parsing the expiry, never by printing it |
| push devices | register with a fake token, listed without the token, revoked, unknown platform refused |

## What it never prints

No body that could carry a token. No `authorization` header, no session token,
no TURN username or secret -- the TURN check prints only *"expires in N s"* and
*"secret present=true"*. Statuses, byte counts and field names only.

## What it cleans up

Messages it sent are retracted, the device it registered is revoked, profile
fields it changed are restored, a follow or contact it created is removed, a
ring it dispatched is dismissed, and every socket it opened is disconnected.
Accounts cannot be deleted over HTTP, so an account the run had to create is
listed at the end rather than pretended away.

## Blocked, and why that is not a pass

`session.host` -- the capability the gateway requires to CREATE a call -- is
granted only to a **verified** account. When no probe holds it the suite still
drives the creation attempt and asserts that the gateway refuses it **by
name** (`host-not-authorized`); a gate that failed open would be the defect.
The lifecycle itself is then reported `BLOCKED`, listed at the end, excluded
from the pass count, **and it fails the run**. Give the run `PROBE_HOST_EMAIL`
and `PROBE_HOST_PASSWORD_FILE` for a verified account and the whole state
machine runs and the block disappears -- which is the resolution. Passing
`--allow-blocked` is the other answer, and it is a different sentence: not *the
call lifecycle is verified* but *the call lifecycle is unverified and I have
decided to proceed anyway*. Use it when that is what you mean, and never in a
report that claims coverage.
