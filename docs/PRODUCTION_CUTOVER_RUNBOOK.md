# Production cutover runbook -- consummate7.com on c7-eu-01

Step by step, for the day staging becomes a production platform. Written
30 Aug 2026 against the box as it actually is (read over ssh, nothing
changed). Nothing in this document contains a credential value; every secret
is a NAME.

## The shape of it

Production is a **second environment on the same box**, isolated from staging
by path, port, unit name and database, sharing only what is identical:

| | staging | production | shared? |
| --- | --- | --- | --- |
| public host | staging.consummate7.com | consummate7.com (+ www redirect) | one Caddy, one Caddyfile |
| tree | /srv/videofy/app | /srv/videofy-prod/app | no |
| web root | /srv/videofy/www | /srv/videofy-prod/www | no |
| env dir | /etc/videofy (0750 root:videofy) | /etc/videofy-prod (0750, files 0640 root:videofy) | no |
| units | videofy-{account,gateway,media-ingest,backup} | videofy-prod-{account,gateway,media-ingest,backup} | no |
| gateway / media-ingest / account | 127.0.0.1:3001 / 3002 / 3006 | 127.0.0.1:3101 / 3102 / 3106 | no |
| database | videofy_account, role videofy | videofy_account_prod, role videofy_prod | same Postgres 16 cluster |
| state / uploads | /srv/videofy/{state,uploads} | /srv/videofy-prod/{state,uploads} | no |
| avatars / message media | /var/lib/videofy/{avatars,message-media} | /var/lib/videofy-prod/{avatars,message-media,channel-media} | no |
| backups | /srv/videofy/backups, 03:12 UTC | /srv/videofy-prod/backups, 03:42 UTC | same script |
| translation models | /var/lib/videofy/models (2.7 GB Opus-MT + Silero) | the same path, read-only | **yes, identical bytes** |
| Python AI runtime | /opt/videofy-ai | the same path, read-only | **yes** |
| service user | videofy | videofy | yes (isolation is by path; the units list only their own ReadWritePaths) |
| TURN | coturn on 169.58.215.77:3478, secret A | the same coturn, **second** static-auth-secret B | one daemon, two secrets |
| TLS | Let's Encrypt via HTTP-01 | the same | one Caddy |

The table is code: `deploy/lib/env.sh` is the single source of every path
and port, read by `deploy/deploy.sh`, `deploy/production/install.sh` and
`deploy/production/smoke.sh`.

Port block 31xx was verified free with `ss -ltnp` on 30 Aug 2026 (the box
listens on 22, 80, 443, 3001, 3002, 3006, 3478, 5432 and nothing else).

### One machine: environment isolation, NOT fault-domain isolation

FOUNDER RULING, LOCKED 30 Aug 2026: *"Production runs on the SAME MACHINE as
staging for the initial launch: environment isolation but NOT fault-domain
isolation -- that limitation must be documented plainly."*

So, plainly. Production and staging are separated by path, port, unit name,
database and web root. They are NOT separated by hardware, kernel, network
interface, power or provider. Everything above the application is one thing.
A single failure of any of the following takes production down, and takes
staging down with it, and no amount of care inside the application prevents it:

* **the VPS itself** -- host failure, a Contabo incident, an accidental
  reboot, a full disk, an out-of-memory kill that the kernel resolves by
  choosing a victim it was never told to protect;
* **the Postgres cluster** -- one server process, one data directory, one
  `shared_buffers`. A staging migration that locks a table, a staging query
  that exhausts connections, or a cluster that will not start after an upgrade
  is a production outage;
* **Caddy** -- one process, one Caddyfile, both site blocks. A syntax error or
  a bad restart takes both hostnames off the internet at once;
* **coturn** -- one daemon, one relay port range (49160-49300/udp). Staging
  calls and production calls compete for the same ports; a coturn restart drops
  live relays in both;
* **the disk** -- one filesystem under `/srv`, `/var/lib` and the 2.7 GB model
  cache. Staging filling it stops production writing uploads, avatars, backups
  and journald;
* **the deploy path** -- one ssh account, one sudo grant. A command typed into
  the wrong shell reaches production;
* **the model cache and the Python AI runtime** -- shared read-only, so a
  corrupted or half-upgraded copy breaks translation in both environments.

What the separation DOES buy, and it is not nothing: production data is in a
different database owned by a different role with a different password;
production secrets are in a different directory the staging units cannot read;
production writes only to its own `ReadWritePaths`; a staging deploy cannot
restart a production unit; and a staging session token is not valid on
production because the signing secrets differ.

This is an accepted launch-day limitation, not an oversight, and it is only
sound while traffic is small enough that an outage is an inconvenience rather
than a loss. **Production moves to its own host when traffic or revenue
justifies it** -- the trigger to write down now is: the first paying customer
whose programme cannot be rescheduled, or the first week where staging work
has to be paused because it might disturb production. `deploy/lib/env.sh`
already carries every path and port as data, so the move is a new box, a new
`VIDEOFY_SSH_HOST`, and a restore from `/srv/videofy-prod/backups` -- not a
rewrite.

## Boot guards production must satisfy

Every `refuse`/`production` branch in the three services, and what production
has to set. Read from the source on the deploy branch, 30 Aug 2026.

### account (`services/account/src/index.ts`, `packages/account-trust`)

| guard | behaviour in production | what production sets |
| --- | --- | --- |
| `readEnvironment(C7_ENVIRONMENT)` | anything but `development`/`staging` IS production | `C7_ENVIRONMENT=production` |
| `createEmailProvider` + `assertProviderAllowed` | `synthetic` **refuses to start**; `resend` requires its keys or **refuses to start** | `C7_EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `C7_EMAIL_FROM`, `C7_PUBLIC_ORIGIN=https://consummate7.com` |
| `createPhoneProvider` + `assertProviderAllowed` | `synthetic` (the default when unset) **refuses to start**; `termii` requires its keys or **refuses to start**; `off` boots and both phone routes answer `503` while phone stays `unverified` | `C7_PHONE_PROVIDER=termii` + `TERMII_API_KEY`, `TERMII_SENDER_ID`, `TERMII_BASE_URL` -- **or** `C7_PHONE_PROVIDER=off` |
| `createIdentityProvider` + `assertIdentityProviderAllowed` | `synthetic` (the default when unset) **refuses to start**; `off` boots and every identity route answers `503` while identity stays `unverified` | `C7_IDENTITY_PROVIDER=off` until a KYC vendor is chosen |
| `C7_ACCOUNT_STORE` | `file` refused; `postgres` requires `DATABASE_URL` | `C7_ACCOUNT_STORE=postgres`, `DATABASE_URL` (generated by install.sh) |
| `C7_MFA_KEYRING` / `C7_MFA_RECOVERY_PEPPER` | half-configured refuses to start | both generated by install.sh |
| `C7_REQUIRED_POLICIES` | malformed refuses to start; empty requires nothing | empty until policy content is approved |
| `C7_IDENTITY_CALLBACK_SECRET` | absent: callback route refuses everything (degraded, not fatal) | generated by install.sh |
| `C7_SECURITY_TARGET_SALT` | absent: addresses omitted from security events (degraded) | generated by install.sh |
| `FCM_PROJECT_ID` / `FCM_SERVICE_ACCOUNT_FILE` | absent: push disabled, ringing falls back to sockets (degraded) | founder installs the JSON at /etc/videofy-prod/fcm-service-account.json |

### realtime-gateway (`services/realtime-gateway/src/index.ts`, `packages/service-env`)

| guard | behaviour | what production sets |
| --- | --- | --- |
| `internalIngressAuth.mustRefuseToStart` | `INTERNAL_WEBRTC_TOKEN` absent (and no insecure opt-out) **refuses to start**; shorter than the minimum throws | generated by install.sh, identical in gateway, media-ingest, account |
| `adapterServiceAuth` | only when adapter routes are configured; production configures none | nothing |
| `VIDEOFY_AUTH_SECRET` | absent: every session unverifiable | generated by install.sh, identical to account and media-ingest |
| `OPERATOR_CONSOLE_ACCOUNT_IDS` | empty: **nobody** can operate (warning, not refusal) | founder fills after the first production sign-up, then `systemctl restart videofy-prod-gateway` |
| `CHANNEL_ID_SALT` | empty: built-in salt with a warning; changing it later invalidates every shared link | generated ONCE by install.sh |
| `AI_RUNTIME_PROFILE` | commercial profiles refuse an absent realtime ingress | same value as media-ingest |
| `TURN_HOST` + `TURN_STATIC_AUTH_SECRET` | half-configured = no relay (degraded, calls across NAT fail); a PROXIED host = a relay that answers nothing while every signal stays green | `TURN_HOST=169.58.215.77` **or** `turn.consummate7.com` (grey-clouded); never a proxied name -- see "TURN: the two permitted arrangements". Secret generated by install.sh and registered with coturn; the host is checked by `deploy/lib/turn-guard.sh` at install and at smoke |

The gateway has no `C7_ENVIRONMENT` guard.

### media-ingest (`services/media-ingest/src/index.ts`)

| guard | behaviour | what production sets |
| --- | --- | --- |
| `internalIngressAuth.mustRefuseToStart` | as the gateway | `INTERNAL_WEBRTC_TOKEN` |
| `PROGRAMME_ROUTES_ARE_UNAUTHENTICATED` | the constant is `false`: programme routes require a session plus the operator allowlist, and `true` would **refuse to start** in production | deploy a SHA whose `services/media-ingest/src/index.ts` reads `= false`; set `OPERATOR_CONSOLE_ACCOUNT_IDS` in media-ingest.env too (empty = programme control refuses everybody) |
| `VIDEOFY_AUTH_SECRET` absent | personal-voice endpoints refuse every request (degraded) | generated by install.sh |
| `AI_RUNTIME_PROFILE=commercial-*` | refuses to start unless a provider is certified as primary | same decision as staging (staging runs `development-demo`) |

### Blockers that were CODE, not configuration: BOTH CLOSED

Two boot guards once made `C7_ENVIRONMENT=production` unbootable. Both are
closed in the tree this runbook ships with. Verify each on the SHA you deploy
rather than trusting this paragraph -- one command apiece:

1. **account** (CLOSED): identity verification is no longer hard-wired to the
   synthetic provider. `services/account/src/index.ts` calls
   `createIdentityProvider(process.env, environment)`, which reads
   `C7_IDENTITY_PROVIDER`: `off` boots and refuses the capability honestly
   (503, identity stays `unverified`), `synthetic` -- including the synthetic
   you get by deleting the line -- still refuses to start in production.

   ```bash
   grep -n 'createIdentityProvider' services/account/src/index.ts   # must appear
   ```

2. **media-ingest** (CLOSED): `PROGRAMME_ROUTES_ARE_UNAUTHENTICATED` is
   `false`, and the programme routes authenticate with a session plus the
   operator allowlist.

   ```bash
   grep -n PROGRAMME_ROUTES_ARE_UNAUTHENTICATED services/media-ingest/src/index.ts   # must say = false
   ```

**Never set `C7_ENVIRONMENT=staging` in `/etc/videofy-prod/*.env`.** An earlier
revision of this runbook offered that as the only way to run the production
environment while the account guard was open. The guard is closed, the
workaround is obsolete, and it was always the wrong trade: it would silently
permit synthetic verification on the production hostname -- accounts marked
verified with nothing sent, which is the single failure the provider switches
exist to prevent. The three switches in the next section are the supported way
to launch without a phone or KYC vendor.

## Founder-only prerequisites

Three of the account service's provider switches are chosen BY NAME, and the
rule that governs all three comes from the 30 Aug 2026 production ruling: *"a
missing provider must refuse the capability honestly or fail startup where the
capability is mandatory -- NEVER a silent fall back to a synthetic/mock provider
in production."* Two consequences worth reading twice:

* **Leaving a switch UNSET is not "off".** An unset switch means `synthetic`,
  and synthetic refuses to start in production. Absence is always a refusal to
  boot, never a quiet downgrade.
* **`off` is not a kind of verified.** An off capability answers `503` and
  leaves its trust component at `unverified` forever. Nothing about trust
  derivation changes: an account with phone switched off is in exactly the state
  it would be in if nobody had ever asked it to verify a phone.

| switch | absent (unset) | `off` | what the founder must supply |
| --- | --- | --- | --- |
| `C7_EMAIL_PROVIDER` | synthetic -> **refuses to start** | not a value; email has no `off` | `resend` + the three Resend variables |
| `C7_PHONE_PROVIDER` | synthetic -> **refuses to start** | `/verification/phone` and `/verification/phone/confirm` answer `503 {"error":"Phone verification is not available yet."}`; phone stays `unverified` | `termii` + its three variables, or the word `off` |
| `C7_IDENTITY_PROVIDER` | synthetic -> **refuses to start** | `/verification/identity` answers `503 {"error":"Identity verification is not available yet."}`, the provider callback is refused, identity stays `unverified` | the word `off` until a KYC vendor is chosen |

### Expect `verification_required` on a healthy production account

**Read this before somebody reports it as a launch-day defect.** With the
template's `C7_PHONE_PROVIDER=off` and `C7_IDENTITY_PROVIDER=off`, an account
that has registered and clicked the Resend link will show the derived trust
state **`verification_required`** -- and that account can nonetheless host
calls, host conferences, run programmes, create an organization and hold a
privileged role inside one. Both halves of that sentence are correct, and the
combination looks alarming enough that it needs saying in advance rather than
being diagnosed at 2am by whoever notices it first.

**Why the state says that.** `resolveTrustState` in
`packages/account-trust/src/trust-model.ts` derives one word from three
components. Email is `verified`; phone and identity are still `unverified`,
because a provider switched `off` answers `503` and never moves its component.
So the account is neither all-verified nor all-untouched, and it falls to the
last line of the function:

```ts
// packages/account-trust/src/trust-model.ts
93:  if (components.every((state) => state === 'unverified')) return 'registered';
94:  return 'verification_required';
```

Line 94 is the whole explanation. `verification_required` is the honest label
for *some channels are proved and some are not* -- it is not a fault, not a
lockout, and not a signal that anything is misconfigured.

**Why the account can still do everything that matters.** Capabilities are NOT
read from that word. `trustCapabilities`, in the same file, spends the
components separately, and the four lines that decide the product are:

```ts
// packages/account-trust/src/trust-model.ts
185:  const emailVerified = trust.email === 'verified';
188:  const fullyVerified = state === 'verified';
192:    canHostSessions: emailVerified,
193:    canCreateOrganization: emailVerified,
194:    canHoldPrivilegedRole: emailVerified,
195:    canActivateProducts: fullyVerified,
```

**Line 192 is the line that proves the claim**: `canHostSessions` is granted
from `emailVerified` alone, never from the derived state. Lines 193 and 194 do
the same for organizations and roles. Only line 195 -- `canActivateProducts`,
the one capability tied to money rather than to use -- waits for
`state === 'verified'`, which requires all three channels and which **nothing
reaches today**, by design: it is deliberately unreachable while identity
verification is `off`, and it costs nothing now because no commercial product
is activated through it yet.

This shape is deliberate and was arrived at by fixing the opposite bug. Reading
every capability off the derived `verified` state read as strict and was in
practice a total lockout -- identity verification is refused in production and
phone delivery waits on sender-id registration, so `verified` was unreachable
and therefore nobody could host a call. As the file puts it: *a gate nobody can
pass does not protect the product, it replaces it.*

**What to check if you doubt it on the day**, on the exact SHA you deployed:

```bash
sed -n '92,94p;185,196p' packages/account-trust/src/trust-model.ts
```

**When the state will change.** Set `C7_PHONE_PROVIDER=termii` with its three
variables and verify a phone, and the account moves to
`verification_pending` then to `verification_required` again until identity
follows; only a chosen KYC vendor plus a passed check reaches `verified`. None
of that alters what the account may already do -- it only unlocks
`canActivateProducts`.

1. **DNS (Cloudflare)** -- `A consummate7.com -> 169.58.215.77`, and
   `A www.consummate7.com -> 169.58.215.77`. Start **grey-clouded (DNS only)**
   for the certificate step, then switch to **proxied**. SSL/TLS mode
   **Full (strict)**. TURN is never proxied: clients dial the origin IP.
2. **Resend** (MANDATORY): API key, and a verified sending domain for
   `C7_EMAIL_FROM`. Absent: account refuses to start. Email is the one channel
   with no `off`, because it is how an account is both verified and recovered.
3. **Termii** (OPTIONAL AT LAUNCH): API key, approved sender id, base URL. The
   template ships `C7_PHONE_PROVIDER=off`, so the box boots without a Termii
   account and the phone routes refuse honestly with a 503. On the day the
   account exists, change it to `termii` and fill all three variables --
   `termii` with any of them empty refuses to start. Do NOT delete the line:
   unset means synthetic, and synthetic refuses to start.
4. **A KYC vendor** (OPTIONAL AT LAUNCH, none chosen): the template ships
   `C7_IDENTITY_PROVIDER=off`. The identity routes refuse with a 503 and no
   account's identity component ever moves. Deleting the line means synthetic,
   and the service refuses to start.
5. **Firebase**: project id and service-account JSON for push. Absent: push
   disabled, ringing degrades to sockets.
6. **Deepgram / ElevenLabs / Azure / Google** as staging uses them. Absent:
   that provider is simply not selectable; `development-demo` starts without
   any.
7. **Off-box backup destination** (`BACKUP_OFF_BOX_TARGET`, an rclone remote).
   Absent: nightly backups warn loudly that they would not survive the box.
8. **No code blocker remains.** Both are closed and re-verified above under
   "Blockers that were CODE": the account service selects its identity provider
   by name, and media-ingest authenticates programme control. Confirm both with
   the two `grep` commands there on the exact SHA you deploy -- that check costs
   seconds and is the difference between a ruling and an assumption.

## TURN: the two permitted arrangements, and the one that is refused

FOUNDER RULING, LOCKED 30 Aug 2026: *"TURN is NEVER behind the ordinary
Cloudflare proxy: either the proven direct-origin arrangement (169.58.215.77)
or an optional DNS-only turn.consummate7.com A record."*

`TURN_HOST` in `/etc/videofy-prod/gateway.env` takes exactly one of two values:

| arrangement | `TURN_HOST` | DNS needed | when to prefer it |
| --- | --- | --- | --- |
| direct origin (proven) | `169.58.215.77` | none | the default; nothing to misconfigure |
| DNS-only hostname (optional) | `turn.consummate7.com` | `A turn.consummate7.com -> 169.58.215.77`, **grey cloud (DNS only)** | when the relay may move to another address later, so clients keep one name |

Both are supported today: `turn.consummate7.com` already exists as a
grey-clouded A record to `169.58.215.77` and is what staging hands to browsers.

**Never** `consummate7.com`, `www.consummate7.com` or `staging.consummate7.com`.
Those are proxied. The ordinary Cloudflare proxy carries HTTP; TURN is UDP (and
TCP) 3478. A proxied hostname there does not error -- it resolves, the gateway
mints a credential, the browser is handed a relay URL that answers nothing, and
every call across NAT pays the full ICE timeout before failing. Health stays
green. The only symptom is "calls do not connect on mobile data".

Because a comment cannot stop that, it is CHECKED:

* `deploy/lib/turn-guard.sh` resolves a host and refuses it if any address
  falls in a published Cloudflare range, or if the host is one of the three
  proxied names by name (so the refusal holds before the record even exists),
  or if it does not resolve at all;
* `deploy/production/install.sh` runs the guard against `TURN_HOST` as written
  in `gateway.env` -- the only value the gateway actually dials with -- and
  **exits non-zero rather than finishing the install**;
* `deploy/production/smoke.sh` reads the relay host back out of the live
  `/webrtc/ice` response (the exact string browsers dial, credential ignored
  and never printed) and fails the smoke on the same rule.

Refresh the embedded Cloudflare range list from <https://www.cloudflare.com/ips-v4>
about once a year, or point `VIDEOFY_CLOUDFLARE_IPS_FILE` at a fresh copy.

## The production operator allowlist: minimal and fail-closed

FOUNDER RULING, LOCKED 30 Aug 2026: *"Programme control requires an
authenticated C7 session AND a production operator entitlement derived
SERVER-SIDE from the session (never a client-supplied accountId). Production
operator allowlist starts MINIMAL and FAIL-CLOSED (empty template; the founder
fills it on the box; no test/QA/staging accounts; 'verified C7 identity' is NOT
'production operator')."*

* The templates ship `OPERATOR_CONSOLE_ACCOUNT_IDS=` **empty**, and empty means
  **nobody operates**. That is the correct shipped state.
* The value is the founder-designated production operator, plus **at most one
  approved backup**. Nothing else.
* **No staging, QA or test account id.** Those ids belong to a different
  database and mean nothing here; an id pasted out of a staging `psql` session
  is exactly the mistake this rule exists to prevent.
* A verified C7 identity is not an entitlement. Verification says who somebody
  is; the allowlist says who may put audio on the platform.
* It must be set in **BOTH** `/etc/videofy-prod/gateway.env` **and**
  `/etc/videofy-prod/media-ingest.env`, identically. The gateway admits the
  console; media-ingest independently admits programme control
  (`operatorOnly` on `POST /microphone/sessions` and `/microphone/sessions/:id/*`).
  One without the other is either a console that cannot start a programme, or a
  programme control that admits somebody the console does not.
* The entitlement is derived server-side from the session. `401` means no
  session, `403` means a session that is not on the list. There is no request
  field that names an account.
* After editing either file:
  `sudo systemctl restart videofy-prod-gateway videofy-prod-media-ingest`.

`OFFICIAL_ACCOUNT_IDS` and `PLATFORM_OPERATOR_ACCOUNT_IDS` in `account.env` are
separate lists with the same fail-closed rule, and are not a substitute for it.

## Production-scoped provider credentials

FOUNDER RULING, LOCKED 30 Aug 2026: *"Provider credentials are
production-scoped per vendor; a missing provider must refuse the capability
honestly or fail startup where the capability is mandatory -- NEVER a silent
fall back to a synthetic/mock provider in production."*

**Every vendor credential used by production is issued for production.** Where
a vendor supports separate keys, environments, projects or sending identities,
production gets its own. Staging keys are NOT reused, and not because of a
policy preference: a shared key means staging's rate limit is production's rate
limit, staging's spend is production's bill, staging's abuse is production's
suspension, and rotating one key silently breaks the other environment. If a
vendor cannot issue a second key, that fact is recorded here rather than
discovered during an incident.

| vendor | variables (NAMES ONLY) | mandatory? | what absence MEANS |
| --- | --- | --- | --- |
| Resend (email) | `RESEND_API_KEY`, `C7_EMAIL_FROM`, `C7_EMAIL_PROVIDER=resend` | **yes** | **fails startup.** Email verifies AND recovers an account; there is no `off`. A production-verified sending domain is part of the credential. |
| Termii (SMS) | `TERMII_API_KEY`, `TERMII_SENDER_ID`, `TERMII_BASE_URL`, `C7_PHONE_PROVIDER` | no, at launch | With `off`: the two phone routes answer `503` and phone stays `unverified` -- an honest refusal. With `termii` and any variable empty: **fails startup**. Unset means `synthetic`, which **fails startup**. |
| KYC identity | `C7_IDENTITY_PROVIDER=off` | no, none chosen | `/verification/identity` answers `503`, the callback is refused, identity stays `unverified`. `off` is not a kind of verified. Unset means `synthetic`: **fails startup**. |
| Deepgram (speech to text) | `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL` | only if selected | Absent: the provider is not selectable, and a profile that requires it refuses at boot rather than falling back to `mock`. |
| ElevenLabs (speech) | `ELEVENLABS_API_KEY`, `ELEVENLABS_DEFAULT_VOICE_ID`, `ELEVENLABS_MODEL` | only if selected | As Deepgram. |
| Azure Speech (TTS) | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_DEFAULT_VOICE_ID` | only if selected | As Deepgram, plus: the voice must exist IN THAT REGION or Azure answers `400` with an empty body. Verify the voice against the production region, not the staging one. |
| Firebase (push) | `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_FILE` | no | Push is disabled; ringing degrades to sockets. A production service-account JSON, installed `0640 root:videofy`. |
| Off-box backups | `BACKUP_OFF_BOX_TARGET` | no, but see below | Backups stay on the same disk as the database they protect, which on a single machine protects against almost nothing. |

`AI_RUNTIME_PROFILE=commercial-*` refuses to start unless a provider is
certified as primary. That gate is about EVIDENCE, not keys: adding a
credential does not open it, and weakening it is a product decision, not a
deployment step.

## The day

Every command below is run from the repository root on the workstation unless
it says "on the box". `c7-claude` is the ssh alias with NOPASSWD sudo. The
order is the founder's, locked 30 Aug 2026; each step has the exact command or
the exact founder action, and a line saying how you know it worked.

Before step 1, from the repository root:

```bash
git status --short                      # clean
node scripts/check-source-hygiene.mjs
node scripts/check-token-logging.mjs
bash -n deploy/deploy.sh deploy/lib/*.sh deploy/production/*.sh
SHA="$(git rev-parse --verify HEAD)"; echo "$SHA"   # the approved SHA; write it down
bash deploy/deploy.sh staging "$SHA"    # staging proves the build first
```

### 1. DNS: apex + www

**Founder action, at Cloudflare.** Create `A consummate7.com -> 169.58.215.77`
and `A www.consummate7.com -> 169.58.215.77`, both **grey-clouded (DNS only)**
for now so the first certificate can be issued over HTTP-01. SSL/TLS mode
**Full (strict)**. Leave `turn.consummate7.com` alone if it exists; if you want
the optional TURN hostname arrangement, it must stay grey-clouded forever.

*How you know it worked:*

```bash
nslookup consummate7.com          # 169.58.215.77
nslookup www.consummate7.com      # 169.58.215.77
```

Both answer the origin address, and no Cloudflare address.

### 2. Production Caddy, VALIDATED

The repo Caddyfile carries both site blocks plus the www redirect. Validate it
on the box **before** it is installed:

```bash
scp deploy/production/Caddyfile c7-claude:/tmp/Caddyfile.check
ssh c7-claude 'sudo caddy validate --config /tmp/Caddyfile.check --adapter caddyfile'
```

**This box runs Caddy with `admin off`.** `systemctl reload caddy` talks to the
admin socket, so a reload does nothing and SILENTLY KEEPS THE OLD CONFIG -- you
change the file, reload, see no error, and serve the previous routing. The only
correct sequence is **validate, then RESTART**. A restart is a few milliseconds
and open WebSockets reconnect on their own. Step 3 installs and restarts it.

*How you know it worked:* the last line is `Valid configuration`.

### 3. Create the production database, storage and secrets

```bash
ssh c7-claude
cd /srv/videofy/app                 # the tree staging just deployed
sudo bash deploy/production/install.sh
```

Idempotent. Creates `/srv/videofy-prod/*`, `/etc/videofy-prod` (templates
copied), `/var/lib/videofy-prod/*`; generates every internal secret in place;
creates role `videofy_prod` and database `videofy_account_prod` with a
generated password written straight into `DATABASE_URL`; adds production's own
TURN secret as a SECOND `static-auth-secret` line in `/etc/turnserver.conf`;
runs the TURN host guard; installs the two-site Caddyfile and **restarts**
Caddy. It prints names, never values.

*How you know it worked:* it ends with `install complete: production on ports
3101/3102/3106`; `turn-guard: ok` appears; no `INSTALL FAILED` line. Then:

```bash
sudo ls -l /etc/videofy-prod/            # three .env files, 0640 root:videofy
sudo -u postgres psql -Atc "select 1" videofy_account_prod    # answers 1
sudo journalctl -u caddy --since -5m --no-pager | grep -i "certificate obtained"
```

### 4. Install the production systemd units

Done by step 3, and worth confirming separately because a missing unit is
invisible until something fails to start:

```bash
ssh c7-claude 'systemctl list-unit-files "videofy-prod-*" --no-pager'
```

*How you know it worked:* four entries --
`videofy-prod-account.service`, `videofy-prod-gateway.service`,
`videofy-prod-media-ingest.service` (all `disabled` or `enabled`, not
`not-found`) and `videofy-prod-backup.timer` (`enabled`).

### 5. Enter the production provider credentials

**Founder action, on the box, in an editor -- never on a command line, where it
would land in shell history.**

```bash
sudo nano /etc/videofy-prod/account.env
#   RESEND_API_KEY, C7_EMAIL_FROM, C7_PHONE_PROVIDER (+ TERMII_* if termii),
#   C7_IDENTITY_PROVIDER, FCM_PROJECT_ID, BACKUP_OFF_BOX_TARGET
sudo nano /etc/videofy-prod/media-ingest.env
#   DEEPGRAM_*, ELEVENLABS_*, AZURE_*, the provider switches, AI_RUNTIME_PROFILE
sudo nano /etc/videofy-prod/gateway.env
#   AI_RUNTIME_PROFILE (identical to media-ingest)
sudo install -o root -g videofy -m 0640 <fcm.json> /etc/videofy-prod/fcm-service-account.json
```

Every key is production-scoped per the table above. Do not copy a staging key.
Do not copy staging's `VIDEOFY_AUTH_SECRET`, `INTERNAL_WEBRTC_TOKEN` or
`CHANNEL_ID_SALT`: production has its own, and sharing them would let a staging
session be replayed on production.

*How you know it worked:* nothing yet -- a wrong key is only visible at boot.
Step 10 is where it is proved, and a missing mandatory key shows there as
`Refusing to start` rather than as a silent downgrade.

### 6. Enter the minimal production operator allowlist

At this point there is **no production account yet**, so the honest action here
is to confirm the allowlist is EMPTY and to decide, in writing, whose id will
go in it. Empty is fail-closed and correct: nobody can operate.

```bash
ssh c7-claude 'sudo grep -c "^OPERATOR_CONSOLE_ACCOUNT_IDS=$" /etc/videofy-prod/gateway.env /etc/videofy-prod/media-ingest.env'
```

*How you know it worked:* both files answer `1` -- the line exists and is empty.
The actual id is entered immediately after step 13 (the first sign-in creates
it), in BOTH files, followed by
`sudo systemctl restart videofy-prod-gateway videofy-prod-media-ingest`. The
value is the founder-designated operator plus at most one approved backup, and
no staging, QA or test account.

### 7. Deploy the exact approved SHA

```bash
bash deploy/deploy.sh production <full-40-character-approved-SHA>
```

Production refuses anything that is not a full 40-character SHA: a branch name
moves between approval and deploy, and nothing in the output would show that it
had. The script performs the ruled provenance sequence -- requested full SHA,
checkout, HEAD == requested (else FAIL), build (server bundles and all four web
apps), activate, health, running release == requested (else FAIL), smoke.

*How you know it worked:* the last line is `[production] DEPLOYED <sha>`. Any
failure prints `DEPLOY FAILED` with the reason and the last journal lines of
each unit; nothing prints `DEPLOYED` while the previous release is serving.

### 8. Verify the deployed SHA

Read it back from the box rather than trusting the deploy's own summary:

```bash
ssh c7-claude 'git -C /srv/videofy-prod/app rev-parse HEAD; tail -1 /srv/videofy-prod/releases.log'
```

*How you know it worked:* both print the approved SHA, character for character.
The deploy also proved it a third way: every unit's main process started AFTER
the checkout, so no service is still executing the previous release from a tree
that reads correct.

### 9. Run migrations

Migrations are applied by the account service itself, at boot, inside an
advisory lock and one transaction per migration
(`services/account/src/db/migrate.ts`). There is no separate command, and
inventing one would be a second code path to keep in sync. Starting the account
service IS running the migrations:

```bash
ssh c7-claude 'sudo systemctl restart videofy-prod-account && sleep 5 &&   sudo journalctl -u videofy-prod-account -n 40 --no-pager | grep -i "Schema migrations"'
```

*How you know it worked:* a line like
`{"service":"account","message":"Schema migrations","applied":N,"alreadyApplied":M}`.
On a fresh database `applied` is the full list including `020_channel_profiles`;
on a re-run `applied` is 0 and `alreadyApplied` is the total. An error here
leaves the schema unchanged -- migrations roll back with their own bookkeeping.

### 10. Start the services

```bash
ssh c7-claude 'sudo systemctl enable --now videofy-prod-account videofy-prod-media-ingest videofy-prod-gateway &&   systemctl is-active videofy-prod-account videofy-prod-media-ingest videofy-prod-gateway'
```

*How you know it worked:* three lines of `active`. Then health on this
environment's own loopback ports, never a neighbour's:

```bash
ssh c7-claude 'for p in 3106 3101 3102; do curl -s -o /dev/null -w "$p %{http_code}\n" http://127.0.0.1:$p/health; done'
```

Three `200`s. A mandatory provider that is missing appears here as
`Refusing to start` in the journal -- read it, do not work around it.

### 11. Public-route smoke

**Founder action first:** at Cloudflare, turn the proxy **ON** for
`consummate7.com` and `www.consummate7.com` (SSL/TLS Full (strict)). Leave
`turn.consummate7.com` grey-clouded. Then:

```bash
bash deploy/production/smoke.sh
```

*How you know it worked:* `SMOKE PASSED: https://consummate7.com`, with an `ok`
line for every locked route probed by name -- `/`, `/videofy/`,
`/videofy/live/`, `/call/`, `/listen/`, `/operator/`, `/streams/<handle>`,
`/health`, `/auth/health`, `/media/health`, `/calls/*`, `/webrtc/ice`,
`/socket.io/*`, `/media/languages/catalogue` -- plus `www -> 301/308` to the
apex, `no-cache` on every shell, a resolvable bundle for each app, and
`turn-guard: ok` on the relay host read back out of `/webrtc/ice`.

### 12. Security boundary smoke

The routes that must REFUSE. Run from the workstation:

```bash
O=https://consummate7.com
for p in /internal/x /media/internal/x /auth/internal/x; do
  curl -s -o /dev/null -w "$p %{http_code}\n" "$O$p"        # want 404
done
curl -s -o /dev/null -w "programme control %{http_code}\n" \
  -X POST -H 'content-type: application/json' -d '{}' "$O/media/microphone/sessions"   # want 401
curl -s -o /dev/null -w "unknown handle %{http_code}\n" "$O/auth/streams/no-such-handle-000"  # want 404
```

*How you know it worked:* three `404`s for `/internal/*` under every mount; a
`401` (never `200` or `201`) for anonymous programme control -- server-side
entitlement, no client-supplied accountId anywhere in the request; `404` for an
unknown channel handle. Then confirm the console's own boot statement:

```bash
ssh c7-claude 'sudo journalctl -u videofy-prod-media-ingest -n 60 --no-pager | grep -i "programme control"'
```

It must say `programme control authenticated: session + operator allowlist`,
with `operatorAccountsAllowed` matching the number of ids you entered.

### 13. Sign in

**Founder action, in a browser.** Open <https://consummate7.com/call/> and
register with a real email address.

*How you know it worked:* the Resend verification message arrives and the link
returns you to `https://consummate7.com/...` -- that is the production email
path, the production origin and the production database, all proved at once.

Then enter the allowlist that step 6 deferred:

```bash
ssh c7-claude
sudo -u postgres psql -Atc "select id, username from accounts order by created_at desc limit 3" videofy_account_prod
sudo nano /etc/videofy-prod/gateway.env         # OPERATOR_CONSOLE_ACCOUNT_IDS=<id>
sudo nano /etc/videofy-prod/media-ingest.env    # the SAME line, identical
sudo systemctl restart videofy-prod-gateway videofy-prod-media-ingest
```

### 14. Verify the personal production channel

Open <https://consummate7.com/operator/> and sign in with that account.

*How you know it worked:* the console admits you (an account not on the
allowlist gets `403`), and it shows ONE channel that belongs to you, with a
default handle derived from your username. Read it back from the public route:

```bash
curl -s https://consummate7.com/auth/streams/<default-handle> | head -c 400
```

A JSON body with `channelId`, `handle`, `displayName`, `visibility`.

### 15. Edit the channel identity

In the operator console, change the channel's **display name**, its **@handle**
and its **category**, and save.

*How you know it worked:* the console shows the new values, and the public
route agrees under the NEW handle while the old handle now answers `404`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://consummate7.com/auth/streams/<new-handle>   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://consummate7.com/auth/streams/<old-handle>   # 404
```

### 16. Open /streams/<handle>

Open <https://consummate7.com/streams/&lt;new-handle&gt;> in a browser.

*How you know it worked:* the canonical channel page renders with the display
name, handle and category from step 15 -- not a blank page (a blank page means
the listener bundle was built without `--base=/listen/`) and not a JSON 404.

### 17. Start one controlled programme

In the operator console, start a programme from the microphone. Keep it short
and say something you will recognise in a translation.

*How you know it worked:* the console shows the programme live, and:

```bash
ssh c7-claude 'sudo journalctl -u videofy-prod-media-ingest -n 30 --no-pager | tail -20'
```

shows a session opening against the production media-ingest on 3102 -- with no
`401`/`403`, which is the allowlist doing its job for the right account.

### 18. Open the listener on a second browser or device

On a phone (mobile data, not the same wifi) or a second browser, open
<https://consummate7.com/streams/&lt;new-handle&gt;> and join.

*How you know it worked:* the listener sees the programme as live and is
offered the language list. A second device on a DIFFERENT network is the point:
it is also the TURN relay test, because that is when a relay is actually needed.

### 19. Verify audio, video and the chosen language path

On the listener, choose a translation language.

*How you know it worked:* captions appear in the chosen language, then audio in
that language, and the video (if the programme carries video) plays in step with
it. Speak the recognisable phrase and hear it come back translated. If captions
appear but audio never does, the synthesis provider is the thing to look at, not
the network. If nothing appears at all, check `/media/health`:
`translationEngine.real` must be `true` -- `false` means a mock provider is
selected and this deployment cannot translate speech.

### 20. End the programme

Stop the programme from the operator console.

*How you know it worked:* the console returns to idle, the listener page shows
the channel as offline rather than hanging on a dead stream, and the journal
shows the session closing rather than erroring.

### 21. Verify durable channel state after a restart

**This is the step that proves persistence rather than assuming it.** A channel
held in a process's memory and a channel written to Postgres by migration
`020_channel_profiles` look identical in a browser -- right up to the first
deploy, when one of them silently loses every channel on the platform. So the
account service is restarted AFTER the step-15 edit, and the identity is
compared across the restart:

```bash
bash deploy/production/check-restart-persistence.sh <new-handle>
```

The script reads `GET /auth/streams/<handle>`, records `channelId`, `handle`,
`displayName`, `description`, `category` and `visibility`, records the unit's
MainPID, runs `systemctl restart videofy-prod-account`, waits for
`/auth/health`, asserts the **MainPID changed** (a restart that quietly did
nothing would otherwise pass while proving nothing), re-reads the route and
compares every field.

*How you know it worked:* `PERSISTENCE PROVED: <handle> is durable across a
videofy-prod-account restart`. Any difference, or a `404` after the restart,
prints `PERSISTENCE FAILED` and names the field -- and a `404` specifically
means the channel was in memory, not in the database.

### 22. Backup and restore sanity check

```bash
ssh c7-claude 'sudo systemctl start videofy-prod-backup.service &&   sleep 20 && sudo ls -la /srv/videofy-prod/backups | tail -3'
```

Then prove the dump can actually be read back -- a backup nobody has restored
is a file, not a backup. `restore-database.sh` restores into a SCRATCH database
and compares row counts against the live one; it only touches production if you
pass `--into-live`, which you do not:

```bash
ssh c7-claude
cd /srv/videofy-prod/app
sudo ENV_FILE=/etc/videofy-prod/account.env bash deploy/staging/restore-database.sh \
  /srv/videofy-prod/backups/account-<STAMP>.dump
```

*How you know it worked:* a fresh `account-<UTC stamp>.dump` in
`/srv/videofy-prod/backups` (custom format, not plain SQL); the restore prints
a `"scratch"` line with `liveCounts` and `restoredCounts` that agree; and the
counts include the channel you created in step 14. If `BACKUP_OFF_BOX_TARGET`
is unset the backup script warns loudly -- on a single machine a backup on the
same disk as the database it protects guards against almost nothing, which is
the fault-domain limitation above showing up in the one place it hurts most.
Setting an off-box rclone target is the single cheapest mitigation available
before production gets its own host.

## Rollback

```bash
tail -3 /srv/videofy-prod/releases.log      # on the box: "<time> <sha> previous=<sha>"
bash deploy/deploy.sh production <previous-sha>
```

Same script, same verification. Database migrations are forward-only, so a
rollback across a migration needs the matching dump from
`/srv/videofy-prod/backups` and `deploy/staging/restore-database.sh` with
`ENV_FILE=/etc/videofy-prod/account.env`; take a manual dump before any deploy
that carries a migration:

```bash
sudo systemctl start videofy-prod-backup.service && sudo ls -la /srv/videofy-prod/backups | tail -2
```

## Operating notes

- **Logs**: `journalctl -u videofy-prod-gateway -f` (and -account,
  -media-ingest); Caddy access log `/var/log/caddy/videofy-prod.log`.
- **Caddy changes -- VALIDATE then RESTART, never reload**: this box runs Caddy
  with `admin off`, and the packaged `systemctl reload caddy` talks to the admin
  socket. A reload therefore SILENTLY KEEPS THE OLD CONFIG: no error, no
  warning, and the previous routing still serving. Edit
  `deploy/production/Caddyfile` in the repo, deploy, then on the box
  `sudo bash deploy/production/install.sh`, which runs
  `caddy validate --config ... --adapter caddyfile` and then
  `systemctl restart caddy`. The restart is milliseconds and open WebSockets
  reconnect on their own. To check a Caddyfile without installing it:
  `scp deploy/production/Caddyfile c7-claude:/tmp/Caddyfile.check && ssh
  c7-claude 'sudo caddy validate --config /tmp/Caddyfile.check --adapter
  caddyfile'`.
- **Renewals**: Caddy renews over HTTP-01 through the proxy; Let's Encrypt
  follows Cloudflare's redirect to HTTPS and the origin already holds a valid
  certificate, so the renewal answers on 443. Keep port 80 open at the edge.
- **Client IPs**: the account service reads `cf-connecting-ip` when present
  (`client-ip.ts`), so rate limits see real addresses behind the proxy. Caddy
  itself is not told Cloudflare's ranges (`trusted_proxies` is unset, as on
  staging); its access log shows edge addresses.
- **Two environments, one coturn**: relay ports 49160-49300/udp are shared
  capacity. If production calls ever starve, widen the range in
  `deploy/turn/install-coturn.sh` and ufw together.
- **Never** run a deploy with sudo (root-owned files block the next one), and
  never copy an env file from staging to production.
