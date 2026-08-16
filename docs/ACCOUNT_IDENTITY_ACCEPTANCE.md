# Account identity — human acceptance

**Owner:** masterzee001 · **Prepared:** 2026-08-17 · **Status:** awaiting human passes

Two manual passes remain before the account identity foundation can be marked
closed. Everything that can be proved without a browser has been, so these
passes cover only what a browser uniquely proves: that the app **stores, clears
and re-presents a session** correctly, and that the result **sounds right**.

## Before you start

```
npm run dev
```

The account service is now part of that command, and every service reads `.env`
itself rather than inheriting whatever terminal started it. `VIDEOFY_AUTH_SECRET`
is already generated in your `.env` and is git-ignored.

Two ways to tell it is wired correctly:

```
curl http://localhost:3006/health          # account service
node scripts/verify-account-identity.mjs   # expect 8/8
```

If personal voice silently does nothing, the first suspect is the secret. A
service without it **fails closed on purpose** — it refuses every enrolment
rather than trusting the client — and the symptom looks exactly like a broken
sign-in.

## Already proved without you

| Claim | Evidence |
|---|---|
| A is heard in A's own voice | `verify-account-identity.mjs` 8/8 |
| B never inherits A's voice, before or after enrolling | same |
| Nobody signed in gets the standard voice | same |
| A signing in from a **second client** finds A's voice with no re-recording | same |
| A second sign-in issues a different token naming the same account | same |
| Enrolment refuses a forged token, and an absent one | live, against the running service |
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

## Recording the result

If all three pass:

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
