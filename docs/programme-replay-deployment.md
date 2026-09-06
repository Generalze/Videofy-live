# Programme Replay — deployment and runbook

**Nothing in this document has been applied anywhere.** Replay is off on every
deployment until somebody turns it on, and this describes how — and how to turn
it off again without touching the live broadcast path.

---

## 1. What Replay is, relative to going on air

Replay is **optional relative to LIVE availability**. That is not a slogan; it
is enforced in code and it is the thing to remember during an incident:

- Bad object credentials → Replay **degraded**, live service **starts**.
- Replay volume unavailable → Replay **degraded**, live service **starts**.
- Account policy service unavailable → live **starts**, and **no policy is
  guessed**, so nothing is recorded.
- Catalogue unavailable → history **lags**; the archive is unaffected and
  reconciliation repairs the row later.

If Replay is misbehaving and a broadcast matters more, set `REPLAY_ENABLED=false`
and restart the media service. Nothing else changes.

---

## 2. Configuration

### Media service (`media-ingest`)

| Variable | Required | Notes |
|---|---|---|
| `REPLAY_ENABLED` | yes | Exactly `true`. Anything else means off. |
| `REPLAY_BACKEND` | yes | Exactly `filesystem` or `object`. **Never inferred.** |
| `REPLAY_ACCOUNT_INTERNAL_URL` | yes | Where the policy/catalogue/deletion seam lives. |
| `INTERNAL_WEBRTC_TOKEN` | yes | The existing internal-service token. Already set on deployments that run the gateway seam. |
| `REPLAY_CLEANUP_GRACE_MS` | yes | **No default.** `0` is valid and is the simplest answer. See §5. |
| `REPLAY_WORKER_INTERVAL_MS` | yes | How often a maintenance pass runs. `900000` (15 min) is a reasonable starting point. |
| `REPLAY_WORKER_BATCH` | no | Runs examined per pass. Defaults to 50 — a page size, not a retention decision. |

**Filesystem backend**

| Variable | Required |
|---|---|
| `REPLAY_ROOT` | yes — an absolute path on a volume with room for the retention you are promising |

**Object backend**

| Variable | Required |
|---|---|
| `REPLAY_S3_ENDPOINT` | yes |
| `REPLAY_S3_REGION` | yes |
| `REPLAY_S3_BUCKET` | yes |
| `REPLAY_S3_ACCESS_KEY_ID` | yes — **secret** |
| `REPLAY_S3_SECRET_ACCESS_KEY` | yes — **secret** |
| `REPLAY_S3_FORCE_PATH_STYLE` | no — path style unless set to `false` |

**Secrets are supplied by the environment or a secret store, never committed.**
No credential appears in a log line, a state document, an object key, a health
response or an error message.

### Account service

No new variables. Replay routes register when a database is present; the
internal seam registers when `INTERNAL_WEBRTC_TOKEN` is set. Without the token,
the seam does not exist, no policy can be resolved, and nothing is recorded —
which is the correct failure and is logged as such.

### Viewer

`VITE_INGEST_URL` — optional. Empty leaves playback URLs relative
(`/replays/<run>/playlist.m3u8`), which is correct wherever the media service is
behind the same front door. Set it only when media is on another origin.

---

## 3. Migration order

Migrations 027–030 are appended and additive; nothing rewrites existing rows.

```
027_programme_airings
028_channel_replay_settings
029_programme_replay_overrides
030_programme_replay_deletions
```

They apply at account-service boot, in array order. Verify against a disposable
database first:

```
DATABASE_URL=<disposable> npm run test:migrations
```

That proves FRESH, UPGRADE and PARITY. **Do not point it at production** — it
drops and recreates schemas, and refuses URLs containing `prod`, `production`,
`staging` or `live`.

---

## 4. Startup order

1. **Database** — reachable, migrations applied.
2. **Account service** — Replay routes and the internal seam register. Look for
   `Programme replay settings and history routes ready`.
3. **Media service** — reads `REPLAY_*`, builds the backend, probes it (object
   only), then registers playback and starts the worker.

The media service can start before the account service; a programme that opens
in that window resolves no policy, records nothing, and says so per run.

---

## 5. The two cutoffs

They are different and the difference matters:

- **`expiresAtMs`** — the *logical* cutoff. Enforced on **every playback
  request** by the clock. A viewer is refused at the exact instant whether or
  not the worker has run.
- **`expiresAtMs + REPLAY_CLEANUP_GRACE_MS`** — the *physical* cutoff. When the
  bytes may actually go.

A positive grace buys an operator a window to recover a recording released by a
policy typo. **It never extends access**, because the logical cutoff has already
refused everybody. `0` is a perfectly good answer.

---

## 6. The object-provider gate

An object backend does **not activate** until the configured provider proves it
honours conditional creation (`If-None-Match: *`). The probe writes one
disposable key, attempts a conflicting conditional create, requires it to be
refused, confirms the first value survived, and removes the key.

A provider that fails is declined and **live broadcasting continues**. Do not
weaken the compare-and-swap to accommodate a provider — it is what stops two
processes both believing they wrote the same state generation.

MinIO passes. Verify any candidate provider before selecting it:

```
S3_ENDPOINT=… S3_REGION=… S3_BUCKET=… \
S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
npm run test:object-store
```

Use a **disposable** bucket; the script creates and deletes objects.

---

## 7. Health verification

`GET /health` on the media service carries:

```json
{ "replay": { "state": "ready" | "off" | "degraded", "detail": "…" } }
```

`degraded` **never** changes the endpoint's HTTP status — a misconfigured bucket
must not take a working broadcast off every health check on the deployment. The
`detail` names no bucket, endpoint, path or credential.

After enabling Replay, confirm in order:

1. `replay.state` is `ready`.
2. Media service log: `Programme replay ready` and `Programme replay playback ready`.
3. Account service log: `Programme replay settings and history routes ready`.
4. A channel has **explicit** Replay settings (see §9).
5. Air a short programme; the operator console's history shows it.

---

## 8. Rollback

**Disable Replay without touching LIVE:**

```
REPLAY_ENABLED=false     # restart media-ingest only
```

Playback routes stop registering, the worker stops, capture stops. The account
service keeps serving settings and history. **Nothing is deleted** — existing
recordings stay exactly where they are and come back when Replay is re-enabled.

**Roll back the whole feature:** deploy the previous build. Migrations 027–030
are additive and can be left in place; no earlier build reads those tables.

**Do not** roll back by dropping the tables — that discards operators'
configuration and their broadcast history, and history is meant to outlive the
media.

---

## 9. No silent channel defaults

An existing channel with no Replay settings stays **unconfigured**. Its
broadcasts resolve to `channel-unconfigured`, record nothing, and log a
diagnostic per run. That is deliberate and must not be "fixed" by backfilling:
choosing 30 days, or forever, or public on an operator's behalf is deciding what
happens to their video without asking.

**Each channel must be given explicit Replay settings before Replay starts
recording for it** — through the operator console's Access page, by the person
who owns the channel.

---

## 10. Current deployment recommendation

For the single-VPS/demo deployment: **`REPLAY_BACKEND=filesystem`** with an
explicit `REPLAY_ROOT` on a volume sized for the retention being promised.

The object backend is complete and proven, and may be activated once an actual
S3-compatible provider has passed the §6 gate.

---

## 11. What is still held

Production activation is **not** part of this change. No credentials exist, no
migrations have been applied to production, no worker runs there, and the
current intentional production split is untouched.
