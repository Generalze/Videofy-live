# Account identity — human acceptance

**Owner:** masterzee001 · **Prepared:** 2026-08-17 · **Environment verified:** 2026-08-17 · **Status:** awaiting human passes

Four manual passes remain before P6.3 can be marked closed for development. Everything that can be proved without a browser has been, so these
passes cover only what a browser uniquely proves: that the app **stores, clears
and re-presents a session** correctly, and that the result **sounds right**.

## Before you start

The voice engine starts **separately** and is the only piece with a wait:

```powershell
.\.venv-openvoice-clean\Scripts\python.exe services\openvoice-service\server.py
```

Give it about 21 seconds, then check it is genuinely ready:

```
curl http://127.0.0.1:3005/health
```

```json
{ "ready": true, "languages": ["en","es","fr"], "provenanceVerified": true }
```

`ready: false` with an empty `languages` list is correct and temporary — the
models are still loading. A language is not advertised until it can answer
inside a caller's timeout, which is what stopped the first utterance of every
call coming out in the wrong voice. Do not start testing before `ready: true`.

Then everything else:

```
npm run dev
```

That starts the gateway, media-ingest, the account service and the three apps.
Every service reads `.env` itself rather than inheriting whatever terminal
started it, and `VIDEOFY_AUTH_SECRET` is already generated there (git-ignored).

Three checks that the wiring is live, all of which should pass before you touch
a browser:

```
node scripts/verify-call-join-identity.mjs   # 7/7  gateway derives identity from a token
node scripts/verify-account-identity.mjs     # 8/8  A/B isolation and cross-client continuity
node scripts/verify-personal-voice.mjs en es # 14/14 full lifecycle
```

If personal voice silently does nothing, the first suspect is the secret. A
service without it **fails closed on purpose** — refusing rather than trusting
the client — and the symptom looks exactly like a broken sign-in. The first
script above tells you which: it distinguishes "the gateway rejected a forged
token" from "the gateway rejects everything".

## Already proved without you

| Claim | Evidence |
|---|---|
| A is heard in A's own voice | `verify-account-identity.mjs` 8/8 |
| B never inherits A's voice, before or after enrolling | same |
| Nobody signed in gets the standard voice | same |
| A signing in from a **second client** finds A's voice with no re-recording | same |
| A second sign-in issues a different token naming the same account | same |
| Enrolment refuses a forged token, and an absent one | live, against the running service |
| The live gateway accepts a valid token and derives the account from it | `verify-call-join-identity.mjs` 7/7 |
| A forged token joins the call but gets no voice identity | same |
| Naming an account in the join payload grants nothing | same |
| First utterance after a restart is personal, not a fallback | 5 cold restarts, 0/5 fallbacks |
| A valid token enrols, speaks, withdraws and deletes end to end | `verify-personal-voice.mjs` 14/14 |
| Forged / expired / foreign-signed / edited tokens yield no owner | 201 gateway tests |
| Resume re-derives identity; B never inherits A on resume | same |

The server half of both passes below is therefore already green. What remains is
the browser.

## PASS 1 — shared browser

The failure the old `localStorage` identity could not survive. One browser
profile, two people.

| # | Step | Required |
|---|---|---|
| 1 | Sign in as **A** | Voice panel opens past the sign-in gate |
| 2 | Enrol A's voice | Panel reports personal voice is on |
| 3 | Join a translated call and speak | **A's own voice** is heard |
| 4 | Sign out A | Panel returns to the sign-in gate |
| 5 | Sign in as **B** — do **not** clear browser storage | Accepted |
| 6 | Do **not** enrol B. Join/rejoin and speak | **Standard voice. Never A's.** |
| 7 | Enrol B, speak again | **B's voice. Never A's.** |
| 8 | Sign out B, reconnect | **Standard voice** |

Step 6 is the one that matters. If B is ever heard in A's voice, stop and report
it — that is the original defect, and nothing else in this pass is worth
finishing.

## PASS 2 — same account, different client

| # | Step | Required |
|---|---|---|
| 1 | In **Firefox** (or a second Chrome profile), sign in as **A** | Accepted |
| 2 | Do **not** re-enrol | — |
| 3 | Join a translated call and speak | **A's existing voice**, no recording asked for |
| 4 | Sign out, join anonymously | Ordinary call works, standard voice |

A second browser profile is enough to prove browser storage is no longer the
authority. A phone or second machine is the stronger proof, but if reaching the
development services from another device turns into a LAN/Vite/CORS side quest,
defer the physical-device version to staging rather than destabilise this
milestone.

## PASS 3 — a broken sign-in must not break the call

Corrupt the stored session, then join.

```js
// In the browser console, on the call page:
const key = 'videofy-account:session';
const s = JSON.parse(localStorage.getItem(key));
localStorage.setItem(key, JSON.stringify({ ...s, token: s.token.slice(0, -4) + 'AAAA' }));
```

| Required |
|---|
| The call **joins normally** |
| A **standard** voice is used |
| No account id, reason or expiry is shown anywhere |

An expired or forged session costs the optional personal voice, never the
conversation.

## PASS 4 — real microphone silence

Separate from the identity passes, and the one no synthetic test can stand in
for. Whisper does not report "I heard nothing" — given near-silence it returns
its best guess at what silence would have been, and on a call that guess is
translated and then spoken in your own voice.

A guard now drops segments the model itself scores as no-speech, and eight
seconds of synthetic near-silence produces nothing. But synthetic dither is
quieter than a real room, so this needs **your microphone, in your room**.

| # | Step |
|---|---|
| 1 | Join a translated call |
| 2 | Say nothing for 20–30 seconds |
| 3 | Let normal room noise happen — fan, traffic, a chair |
| 4 | Breathe and move normally |
| 5 | Then speak several real sentences with pauses between them |

| Required |
|---|
| Silence produces **no transcript** |
| Silence produces **no translation** |
| Silence produces **no spoken audio** |
| Quiet but genuine speech is **still transcribed** |
| Normal speech works exactly as before |

If invented text still appears, the dial is in `.env` and needs no code change —
lower means stricter:

```
TRANSCRIPTION_CERTAIN_NO_SPEECH_PROB=0.75
TRANSCRIPTION_MAX_NO_SPEECH_PROB=0.5
```

Dropping real speech is the opposite failure and is not an improvement, so
report that too if step 5 starts losing sentences.

## Recording the result

If all four pass:

```
ACCOUNT IDENTITY FOUNDATION
STATUS: CLOSED — DEVELOPMENT

Browser-local authority removed        ✅
Client owner assertion removed         ✅
Enrollment/deletion authenticated      ✅
Call join authenticated                ✅
Resume re-verifies identity            ✅
Shared-browser A→B isolation           ✅ human proof
Cross-browser account continuity       ✅ human proof
Anonymous calls preserved              ✅
Invalid-token degradation              ✅ human proof
Silence hallucination                  ✅ human proof
Owner listening acceptance             ✅ human proof
```

## What this does NOT close

**Token revocation is local.** Every service verifies signature and expiry
itself, so a token stays usable at the gateway and media-ingest until it expires
even after the account service has revoked that generation. Deliberate: it means
a call never becomes unjoinable because sign-in is restarting.

This does **not** block P6.4 development. It **does** block any claim that
authentication is ready for public staging, and it should be revisited the
moment a staged deployment is on the table.

Other development-prototype limits, unchanged: no email verification, no
password reset, no second factor, no breach-list check, and account records are
a JSON file that is not encrypted at rest.
