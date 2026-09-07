# Publication authority

**Status:** implemented, qualified, not yet applied to the production host.
**Branch:** `p8/publication-authority`, based on `e9b81e5` (the live release).

## The gap

`/srv/videofy-prod` is owned by `root` and is not group-writable. That is
correct: the deploy identity has no business creating files beside the live
release store, the uploads directory or the environment files.

But publishing a release replaces `/srv/videofy-prod/current`, and replacing a
symlink requires write permission on the **directory that contains it**, not on
the symlink. So the deploy identity cannot publish.

During the 2026-09-06 convergence this surfaced *after* a release had already
been built, and was closed by hand with `sudo`. That is an undocumented
requirement: it works once, for the person who discovered it, and then strands
whoever deploys next — including a rollback at the moment when a rollback is
what is needed.

## What was built

### 0. A narrow installer, because the remediation must be safer than the fault

`deploy/production/install-publication-authority.sh` — **root-only, idempotent**,
and the single authoritative implementation of publication installation.

A host missing publication authority is, in every case that matters, otherwise
**converged and serving**. Sending its operator to `deploy/production/install.sh`
would be advice that writes systemd units for the legacy `/app` layout and can
restart coturn and Caddy — both shared with staging, where a restart drops live
relays or live requests. That is remediation costing more than the fault.

The narrow installer does exactly five things:

1. installs `/usr/local/lib/videofy/{release-paths,release-engine}.sh` (root:root, 0644)
2. installs `/usr/local/sbin/videofy-publish-current` (root:root, 0755)
3. installs `/etc/sudoers.d/videofy-publish` (0440), `visudo -c`-validated
   before it is placed and the whole sudo configuration validated after
4. **verifies** the resulting ownership and modes rather than trusting `install`
5. runs `videofy-publish-current --check` under `sudo -n` **as the deploy
   account**, since root could invoke it whatever sudoers says

**Every replacement is a rename.** This runs on a live host against files other
processes read at unpredictable moments: `sudo` reads `/etc/sudoers.d` on *every
single invocation*, and a publication in flight is reading the helper and the
libraries it sources. `install` and `cp` open the destination and write through
it, so for as long as that takes a reader sees a file that is neither the old
one nor the new one — for sudoers, a window in which nobody on the box can use
sudo at all.

So each file is staged **beside its destination**, on the same filesystem
(`rename(2)` cannot cross one), given its final ownership and mode, verified,
and only then renamed over the top. Staged names begin with a dot, which matters
in `/etc/sudoers.d`: sudo's `includedir` skips any filename containing a `.` or
ending in `~`, so a staged entry is never read as configuration while it waits.
The final name deliberately has no dot.

The sudoers entry goes last, and the previous one is kept under a dotted name
and restored **by rename** if the global `visudo -c` then fails.

**The failure report is true.** The sudoers text is composed and validated
*before* anything is placed, so a refusal that says "nothing was installed" is
literally accurate — there is no helper and no library on disk at that point.
That ordering exists for the sentence, not the other way round.

It writes no unit, does not `daemon-reload`, restarts nothing, and does not
touch Caddy, coturn, the environment files, the database, `app`, `www`, the
pointer, or Replay. It grants one command and **removes no existing grant**.

`install.sh` calls it for fresh-host provisioning — delegation, not a second
copy, because the copy that drifts is the one somebody runs at three in the
morning. The reverse never holds: a converged host must never rerun the full
installer to gain this one capability, and every operator message now says so.

`VIDEOFY_INSTALL_PREFIX` relocates every destination under a directory. That is
how the boundary is proven: "it touches nothing else" is a claim about what the
script *does*, so the tests execute it. Root is required whenever the prefix is
empty — the only case that can reach a real host.

### 1. One privileged program

`deploy/production/publish-current.sh`, installed as
`/usr/local/sbin/videofy-publish-current` (root:root, 0755).

```
videofy-publish-current <40-char-sha>   publish that release
videofy-publish-current --check         prove invocability, change nothing
```

- **The root and pointer are compiled in.** They are not arguments, because an
  argument is something a caller can choose. The only input is a SHA.
- **It re-proves everything itself.** Sealed marker, integrity manifest,
  recorded SHA equal to the directory name, no symlink escaping the release,
  and containment inside `releases/`. It runs as root and is reachable by the
  deploy account, so it cannot assume the caller checked anything: a helper
  that publishes whatever it is handed is a privileged way to publish an
  unqualified release.
- **It sources only root-owned code**, from `/usr/local/lib/videofy`. Sourcing
  the deployment's own shipped libraries — which live under `/tmp` and belong
  to the deploy identity — would turn a narrow helper into a way to run
  arbitrary code as root.
- **Its only mutation is the rename.** `ln -sfn` to a temporary name, then
  `mv -Tf` over the pointer. No `rm`, so there is no interval with no pointer.

There is one override, for the paths, admitted **only when the process is not
uid 0**. Reached the way it is meant to be reached — `sudo -n
videofy-publish-current <sha>` — the process is root and the override is
unreachable. (`sudo` also resets the environment, so the variables never
arrive; the uid test is the guarantee that does not depend on how sudoers is
written.) Anyone who can run it as root without sudo is already root.

### 2. Routing, not a second code path

`release_publish` in `deploy/lib/release-engine.sh` chooses by permission:

- pointer directory writable → the ordinary `pointer_publish` (staging, tests);
- not writable → `publication_authority_publish`, which requires the helper to
  exist, invokes it under `sudo -n`, and then **reads the pointer back** and
  compares it. A helper reporting success it did not perform is caught.

`release_rollback` delegates to `release_publish`, so a rollback takes the
identical route with no wider authority.

### 3. Proven before anything is built

`atomic_bootstrap_state` now demands, when the root is not writable, that the
helper exists, is executable, is not group- or world-writable, is owned by
root, and answers `--check` under `sudo -n`. Each has its own refusal state, and
`atomic_bootstrap_refusal` prints `ATOMIC PUBLICATION BOOTSTRAP INCOMPLETE`
while still saying **this is not a busy lock** — the distinction that a previous
incident turned on.

A defect found by these tests and fixed: the writability check was
`case "$mode" in *[2367])`, which only ever inspects the **last** character of
the mode string. `0775` — group-writable by exactly the account being guarded
against — passed it. It is now a bit test, `$(( 0$mode & 0022 ))`.

## Qualification

Run on `c7-eu-01` (Linux 6.8, ext4); the suite refuses to run where `ln -s` is
emulated.

- **323 passed, 0 failed** (was 233).
- New mutations, each of which must turn the suite red:
  - `no-publication-authority-preflight` — bootstrap pronounces a host ready
    without proving anything can move the pointer.
  - `trust-the-publisher` — publication does not check that a publisher is
    installed and believes the exit code instead of reading the pointer back.
  - `wide-publication-paths` — the helper's verification lines removed, so it
    publishes whatever it is handed. Applied to a copy of the real script,
    since it is a program rather than a sourced function.
  - `remediate-via-full-installer` — a converged host missing one symlink helper
    is routed back to the full production installer.
  - `non-atomic-privileged-install` — the installer writes through each
    destination instead of renaming over it. It kills exactly the four
    atomicity assertions and nothing else.

The publication cases run against **what the narrow installer actually
installed** into a scratch prefix, not against a hand-picked subset of
`deploy/lib` — so a helper that grows a dependency the installer never ships
fails in the suite rather than on the host, mid-publication.

### The installation boundary

Proven by executing the installer with the converged units present and hashed
on both sides:

| Asserted | How |
|---|---|
| helper installed and executable | `-x` on the installed path |
| root-owned libraries beside it | both files present, mode 644 |
| sudoers validates, grants one command | `visudo -c`, and the entry names the absolute path |
| `--check` passes | the installer refuses unless it does |
| **service units unchanged** | `sha256sum` of all three `videofy-prod-*.service` |
| **no unit added or removed** | file count in the unit directory |
| **nothing reloaded or restarted** | a recording `systemctl` stub on `PATH`; its log must stay empty |
| **`current` unchanged** | `readlink` before and after, and what a restart would boot |
| **`www` unchanged** | the structural pointer still names `current/www` |
| idempotent | a second run succeeds, changes no unit, restarts nothing |

### Atomic replacement

The difference between a rename and a write-through is observable, and both
halves are asserted — either alone could be satisfied by an unlink-and-recreate
that still leaves a gap:

| Asserted | How |
|---|---|
| a reader mid-swap sees the **complete old** sudoers entry | a file descriptor opened before the installer runs, read after it |
| the same for the **helper** a publisher may be reading | a second descriptor, same technique |
| the destination is a **new inode** | `stat -c %i` before and after; a write-through keeps it |
| the new content actually landed | the helper is byte-identical to the repository copy |
| nothing staged survives | no `.videofy-publish.*` or `.*.staging.*` in any destination |
| an entry that does not parse changes nothing | existing file byte-identical **and same inode** |
| the refusal's claim is true | no helper and no library exist after that refusal |

The ten cases named in the work package are covered behaviourally, by running
the real script and the real functions:

| # | Case | Where |
|---|------|-------|
| 1 | root not writable + helper authorised → publication passes | "publication succeeded anyway" |
| 2 | helper missing → refuse, naming the narrow installer | "publication refuses when nothing can move the pointer" |
| 3 | helper wrong owner / not executable / writable → refuse | four bootstrap cases |
| 4 | target outside `releases/` → refuse | the eight-argument refusal loop |
| 5 | incomplete release → refuse | "an unsealed directory is refused" |
| 6 | corrupt manifest → refuse | "a release whose bytes changed after sealing" |
| 7 | escaping symlink → refuse | re-sealed around the link, so only containment can catch it |
| 8 | arbitrary pointer path → refuse | the refusal loop, incl. `../releases/<sha>` |
| 9 | valid publish → atomic replacement | "what it publishes is a symlink, not a copied tree" |
| 10 | valid rollback → same authority | "rollback takes the same route" |

## The minimum sudo allowlist

The deploy identity on `c7-eu-01` is **`claude`** (it owns
`/srv/videofy-prod/releases`); the service identity is **`videofy`**.

An atomic deployment needs exactly four privileged things:

| # | Command | Why |
|---|---------|-----|
| 1 | `/usr/local/sbin/videofy-publish-current` | move `current`; also `--check` at bootstrap |
| 2 | `/usr/bin/systemctl restart videofy-prod-account videofy-prod-gateway videofy-prod-media-ingest` (and singly) | rolling activation |
| 3 | `/usr/bin/systemctl enable` on those same units | idempotent, only on a fresh unit |
| 4 | `sudo -n -u videofy test …` / `sudo -n -u videofy node …` | preflight runs **as the service user**, never as root, to prove the service can traverse, read and load the candidate |

Deliberately **not** on the list:

- `systemctl daemon-reload` and writing unit files — that is unit work, which is
  a separately authorised change, not something a code deployment does.
- `chown` / `chmod` on the deployment root — the atomic model never needs them;
  the legacy `deploy/deploy.sh` did, and is not the production path.
- Anything either installer does — both are run as root by an operator
  (`sudo bash deploy/production/install.sh` on a fresh host,
  `sudo bash deploy/production/install-publication-authority.sh` on a converged
  one), deliberately, and not by a deployment.

Proposed `/etc/sudoers.d/videofy-deploy`:

```
Cmnd_Alias VIDEOFY_PUBLISH  = /usr/local/sbin/videofy-publish-current
Cmnd_Alias VIDEOFY_ACTIVATE = /usr/bin/systemctl restart videofy-prod-account, \
                              /usr/bin/systemctl restart videofy-prod-gateway, \
                              /usr/bin/systemctl restart videofy-prod-media-ingest, \
                              /usr/bin/systemctl enable videofy-prod-account, \
                              /usr/bin/systemctl enable videofy-prod-gateway, \
                              /usr/bin/systemctl enable videofy-prod-media-ingest

claude ALL=(root)    NOPASSWD: VIDEOFY_PUBLISH, VIDEOFY_ACTIVATE
claude ALL=(videofy) NOPASSWD: /usr/bin/test, /usr/bin/node
```

`install-publication-authority.sh` writes only the first of these
(`/etc/sudoers.d/videofy-publish`), `visudo -c`-validated before it is installed.
**It does not remove any existing broader grant.**

### This is not yet applied

Per the ruling, `NOPASSWD: ALL` is **not** replaced until a dry-run on the host
proves the narrowed policy still supports deployment *and* rollback. No lockout
experiments on production. The dry-run is: install the narrowed file alongside
the existing grant, run a `--prepare-only` deployment and a rollback with the
broad grant temporarily ordered *after* the narrow one, confirm every step is
authorised by the narrow rules, and only then remove the broad grant — with a
root session held open throughout.

The `sudo -n -u videofy node …` line is the one to watch: `node` is a general
interpreter, so granting it as the service user is equivalent to being able to
run code as `videofy`. That is the identity the services already run as, so it
grants nothing new — but it should be a fixed absolute path to the preflight
script rather than `node` with a free argument. That narrowing needs the script
to live at a stable installed path and is a follow-up, not part of this change.

## What has not changed

Production was not touched. `current` still points at
`releases/e9b81e55a1eb068412e4766f07499f63b25b2e9f`, `www` is still structural,
Replay is still off at runtime, and nothing was redeployed or restarted.
