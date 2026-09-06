# Atomic production convergence

**Status: the engine is built and tested. The convergence has NOT been run.**
Production is untouched and remains in the split state described below.

## The problem this closes

On 2026-09-05 at 06:19:07 the production gateway was stopped and restarted.
Nobody asked it to. `NRestarts=0`, so it was not a crash loop — it was an
external `systemctl` action inside the `unattended-upgrades` window that
installed `openssh-server`, `gnupg` and kernel packages. `apt-daily-upgrade.timer`
is enabled and fires daily.

It came back on the same tree, so nothing broke. That was luck, not design.

The old `deploy.sh` checks the target SHA out **into the live tree**, and only
then builds, reconciles units and runs its gates:

```
live APP_DIR -> checkout -> npm -> build -> stage web -> units -> gates -> restart
                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                every one of these is visible to an external restart
```

So an unattended restart during a deploy — **or during one that is about to
refuse at a gate** — starts a service on code that passed nothing. The window
is minutes long and recurs daily.

The fix is not to disable the timer. Correctness must not depend on the machine
being quiet.

## The invariant

> **At every instant, a service that restarts boots a release that passed every gate.**

It holds without cooperation, because the bytes a service resolves are never
the bytes a deployment is working on.

```
releases/<sha>/          prepared once, sealed, then never written to again
current -> releases/<sha>    THE ONLY POINTER A DEPLOYMENT MOVES
www     -> current/www       structural; installed once, never moves again
```

**One pointer moves, so a release is one transaction.** An earlier draft moved
`www` to `releases/<sha>/www` as a second release pointer. Each rename was
individually atomic and the pair was not: between them the API is release B
while the site still serves release A's bundles. Nothing crashes — a visitor
just loads a bundle built against a different API than the one answering it,
which surfaces as one broken feature and no error anywhere.

Because `www` resolves *through* `current`, the single rename moves the API and
the site in the same instant, by construction rather than by ordering.

| phase | writes to | an external restart boots |
|---|---|---|
| checkout, npm, build | `releases/.candidate-<sha>.<pid>` | **old release** |
| web build | the candidate's own `www` | **old release** |
| config preflight | nothing | **old release** |
| effective-unit gate | nothing | **old release** |
| seal | `RELEASE.json`, last | **old release** |
| **publish — the authorised boundary** | one rename of `current` | **new release** |
| restart, health, smoke | nothing | new release |

A failure above the boundary is invisible to the running system. A failure
below it is a rollback: another rename, to a release still sealed on disk.

## Why the pointer moves by rename

Not this:

```sh
rm current && ln -s releases/<sha> current   # WRONG
```

Between those two commands the pointer does not exist. A service restarting in
that window has no working directory at all — and on this host something
restarts services on its own schedule. The window is small, which is exactly
what makes it survive testing and fail in production.

Instead: write a new symlink beside the live one and rename it over the top.
`rename(2)` on one filesystem is atomic — every observer sees the old target or
the new one, never neither. Verified on `c7-eu-01` (ext4): `mv -T` replaces a
symlink in place.

## Systemd doctrine

An ordinary release **must not be able to change systemd semantics**. The old
model installed base units and ran `daemon-reload` *before* its drop-in guard
could refuse, so a refused deploy left new unit files staged for whatever
restarted next.

The new model **only reads**:

- it installs no unit, reloads no daemon, removes no drop-in
- it asks systemd what each unit's `WorkingDirectory` actually resolves to
- it refuses, before the boundary, if that is outside `current`
- it refuses if any drop-in overrides `WorkingDirectory`
- **it never removes an unknown drop-in** — that is somebody's incident
  response, and a deploy that deletes evidence to make itself proceed is worse
  than one that stops

Unit changes are a separate, separately reviewed act.

## The current split state

```
videofy-prod-media-ingest   /srv/videofy-prod/release-980619e   980619e
videofy-prod-gateway        /srv/videofy-prod/app               56db846
videofy-prod-account        /srv/videofy-prod/app               56db846
```

media-ingest is redirected by
`/etc/systemd/system/videofy-prod-media-ingest.service.d/10-release.conf`,
written during the 2026-09-05 incident recovery so media-ingest could move
without restarting the gateway. That was correct then and is the thing
convergence removes.

---

# The one-time convergence procedure

**NOT AUTHORISED TO RUN. Each step is a separate CTO gate.**

The procedure assumes throughout that an external restart may happen between
any two steps, and is ordered so that no such restart lands on unqualified code.

### Step 0 — read-only survey

```sh
systemctl show videofy-prod-{account,gateway,media-ingest} -p WorkingDirectory --value
systemctl cat videofy-prod-media-ingest | sed -n '1,20p'
ls -la /srv/videofy-prod/
df -T /srv/videofy-prod | tail -1          # must be one filesystem, for rename(2)
```

Nothing proceeds unless `releases/`, `current` and `www` can all live on that
one filesystem. A rename across filesystems is a copy, and a copy is not atomic.

### Step 1 — build the first release, changing nothing

```sh
bash deploy/atomic-deploy.sh production <sha>
```

This **refuses** while `/srv/videofy-prod/current` does not exist, and says so.
That refusal is the expected outcome of step 1: it proves the engine is present
and that the host is not yet converged, without touching anything.

Build the first release with the supported command:

```sh
bash deploy/atomic-deploy.sh production prepare <full-40-char-sha>
```

`prepare` builds and seals `releases/<sha>/` and does nothing else: it creates
no pointer, exchanges no `www`, installs no unit, restarts nothing and runs no
migration. It works on an unconverged host — the unit gate is skipped there,
because before convergence the units legitimately still name the app tree, and
requiring otherwise would make it impossible to build the release the
convergence needs. The configuration preflight still runs, because that is
about the release rather than the host.

An earlier draft of this document said to "run the preparation alone" and
offered no command for it. An operator following that would have sourced
internals and improvised, and an improvised first release is the one nothing
later can verify.

### Step 2 — publish the pointers while nothing uses them

```sh
ln -sfn /srv/videofy-prod/releases/<sha> /srv/videofy-prod/current.publishing
mv -Tf /srv/videofy-prod/current.publishing /srv/videofy-prod/current
```

Still inert: no unit names `current` yet. If an external restart happens here,
every service boots exactly what it booted before.

The web pointer needs care, because `www` is a real directory Caddy is serving
right now. It is converted **atomically**, with no interval in which the site
has no root:

```sh
# prepare the structural pointer beside the live directory (inert)
ln -sfn /srv/videofy-prod/current/www /srv/videofy-prod/www.structural

# swap them in one syscall: both paths exist before, both exist after
sudo python3 deploy/lib/exchange-web-pointer.py   /srv/videofy-prod/www /srv/videofy-prod/www.structural
```

`renameat2(RENAME_EXCHANGE)` was probed on this host in scratch before being
written into this runbook: **supported** on ext4, kernel 6.8. Afterwards `www`
IS the structural symlink and `www.structural` holds the previous real
directory, kept — so the reverse is one more exchange.

An earlier draft of this document accepted a short 404 window here
(`mv` then `ln`). That was the same defect as the two-pointer publish, one
layer down: "short" is not "absent". The tool refuses rather than falling back
to that sequence, because a silent fallback would put the window back exactly
where nobody would look for it again.

Verify the release's bundles are the ones being served before continuing.

### Step 3 — move the units onto the pointer, one service at a time

Least critical first. For each unit, in this order —
`videofy-prod-account`, then `videofy-prod-gateway`, then
`videofy-prod-media-ingest`:

```sh
# from deploy/production/systemd-CONVERGED/, NOT deploy/production/systemd/
sudo install -m 0644 deploy/production/systemd-converged/<unit>.service   /etc/systemd/system/<unit>.service
sudo systemctl daemon-reload
sudo systemctl restart <unit>
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/health
```

**Two unit directories exist on purpose, and the difference between them is the
whole migration:**

| directory | `WorkingDirectory` | who installs it |
|---|---|---|
| `deploy/production/systemd/` | `/srv/videofy-prod/app/services/<name>` | `deploy.sh`, automatically |
| `deploy/production/systemd-converged/` | `/srv/videofy-prod/current/services/<name>` | a human, once, here |

`deploy.sh` reconciles only from the first directory and therefore **cannot
reach** the converged units. That separation is what stops the legacy deploy
from installing `current`-based units on a host where `current` does not exist
yet — which would leave every service pointing at a path that is not there.

An earlier draft of this runbook named `deploy/production/systemd/` for this
step. Following it exactly would have moved the pointer and left every unit
still reading the app tree: the procedure was false, and a test now asserts
that the converged units resolve through `current` while the legacy twins
still name the app tree.

Each service is proven healthy on the pointer before the next is touched. A
failure here is one service, and reverting it is one file and one restart.

### Step 4 — remove the incident drop-in

**Only after media-ingest resolves through `current` and is healthy**, and only
as its own reviewed change:

```sh
sudo rm /etc/systemd/system/videofy-prod-media-ingest.service.d/10-release.conf
sudo systemctl daemon-reload
sudo systemctl restart videofy-prod-media-ingest
systemctl show videofy-prod-media-ingest -p WorkingDirectory --value
```

The drop-in is removed **by a human who decided to**, never by a deploy.

### Step 5 — retire the legacy trees

`/srv/videofy-prod/app` and `/srv/videofy-prod/release-980619e` are kept until
at least one full atomic deploy and one rollback have been exercised. They are
the fallback, and deleting the fallback is not part of adopting the thing that
replaced it.

`deploy/deploy.sh` refuses automatically once `current` exists, so the old path
cannot be used by accident after step 2.

## Rollback of the convergence itself

Reverse of step 3 (units back to `app/`, restart), then `www` back — atomically
again, by exchanging the same two paths in the other direction:

```sh
sudo python3 deploy/lib/exchange-web-pointer.py   /srv/videofy-prod/www /srv/videofy-prod/www.structural
```

Nothing under `app/` or `release-980619e/` is modified at any point, so the
pre-convergence state is always one rename and three unit files away.

## Atomic publication, rolling process activation

**Publication is atomic. The processes are not.** Saying otherwise would be a
comfortable lie: `current` moves in one instant, but the services are restarted
one at a time afterwards, and between the rename and the last restart old and
new processes coexist.

What that costs, pinned by test:

| | |
|---|---|
| new bundles reachable before publication | **no** — the candidate's `www` is inside a directory nothing points at |
| a service that restarts after publication | gets the new release, always |
| a service that has not yet restarted | keeps running the old release from its open file handles; that release directory is never deleted by a deployment |
| an *unplanned* restart of one service after publication | lands on the qualified new release — it cannot land on an unqualified one |
| a planned restart failing partway | the pointer is unaffected by process state; recovery is the same single rename regardless of how far the roll got |
| rollback from any mixed state | one rename back; the release rolled away from stays sealed |

The mixture that exists is therefore always **old qualified release ↔ new
qualified release**, never *unqualified anything*. Adjacent-release
compatibility is the only property the application contracts must satisfy, and
it is the same property they already had to satisfy for the previous model's
sequential restarts.

**This does not require blue/green.** It would only if some transition needed
every service to move in the same instant. Nothing here does: the services
speak over HTTP and Socket.IO with the gateway tolerating reconnects, and the
2026-09-05 incident already demonstrated the old gateway accepting a
newer media-ingest across a version boundary in production.

## Rollback is a complete version transition

`atomic-deploy.sh <env> rollback <full-sha>` performs the **whole** transition
and its exit code means it:

```
atomic pointer rollback -> restart every service -> wait for active
  -> loopback health -> prove the processes are running the rollback release
  -> public smoke -> report ROLLED BACK
```

An earlier version moved the pointer, printed `RESTART THE SERVICES` and exited
zero. That reported success while every process was still executing the release
being abandoned, told the operator to finish by hand at the moment a
half-finished state is most expensive, and let any automation reading the exit
code believe the system was restored. If any step fails now, the command fails
loudly and prints the pointer, what a restart would boot, and that the
processes are **not** proven to be running the target.

The same applies automatically: a failed restart, failed health, failed
running-release proof or **failed public smoke** after a deployment triggers
this identical transition rather than leaving the new release published with a
note advising a rollback.

## Loopback health is not a deployment

The deploy is not finished because `127.0.0.1` answered 200. A service can be
healthy on loopback while the edge serves a stale shell or refuses a route —
precisely the failure a loopback probe cannot see. The public smoke
(`deploy/production/smoke.sh`, the existing one, not a second definition) runs
from the machine issuing the deploy, through Cloudflare and Caddy.

## A release must still BE what was sealed

`RELEASE.json` proves a directory was once sealed and claims a SHA. It says
nothing about whether the dist a service is about to execute, or the bundle a
visitor is about to download, is still what passed the gates — and a release
sits on disk for weeks as the thing a rollback returns to.

So sealing also writes `RELEASE.manifest.sha256` over the whole runtime
payload, and `release_is_complete` verifies it. A release whose bytes have
changed — an edited dist file, an edited bundle, a deleted file, an **added**
file, a removed manifest — stops being a release for reuse, publication and
rollback alike. The manifest is never regenerated for an existing release:
doing so would bless the tampering it exists to detect.

## What is deliberately NOT in this work package

- **Database migrations.** Replay's `027–030` remain HOLD. Release atomicity
  must never depend on an irreversible schema change: a pointer can go back and
  a migration cannot, so the two are separate gates and migrations run in their
  own, after a release has proven itself.
- **Replay activation.** `REPLAY_ENABLED` stays unset, no retention defaults,
  no Replay root, no workers, no object-storage credentials. This work only
  makes deployment able to *carry* Replay code safely.
- **Unattended upgrades.** Not disabled, not reconfigured. Whether to constrain
  automatic service restarts is an availability policy and an independent
  decision; the correctness fix above must hold either way, and does.
- **Caddy.** Not edited. The web pointer works because Caddy already resolves
  `root` per request.
