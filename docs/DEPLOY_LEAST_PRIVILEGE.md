# Bounded deployment privilege

**Status:** implemented and qualified. **Not applied to the production host.**
The broad grant is still in place; removing it is a separate, reviewed act.
**Branch:** `p8/sudo-least-privilege`, based on `e8b660a`.

## What is being removed

The deploy account on `c7-eu-01` holds

```
claude ALL=(ALL) NOPASSWD: ALL
```

which is root, spelled at length. Removing it requires that the privileges an
ordinary atomic deployment and rollback *actually* use exist first.

## The audit

Read from the deployment path at `e8b660a`, not from the earlier proposal.

| Call site | Privileged call | Verdict |
|---|---|---|
| `activation.sh:29` | `sudo -n systemctl restart <unit>` | **needed**, three named units |
| `release-engine.sh:401` | `sudo -n videofy-publish-current <sha>` | **needed**, already narrow |
| `transaction.sh:158` | `sudo -n videofy-publish-current --check` | **needed**, same program |
| `activation.sh:156,160,164` | `sudo -n -u videofy test …` ×3 | **replaced** |
| `activation.sh:170` | `sudo -n -u videofy node <script>` | **replaced** |

Nothing in the deployment path calls `systemctl enable`, `daemon-reload`,
`chown`, `chmod`, Caddy, coturn, or any database-administration command. The
legacy `deploy/deploy.sh` does; it is not the production path.

`systemctl enable` is provisioning. It belongs to `install.sh`, run by an
operator, not to a deployment.

## The problem with the old preflight authority

Making the old form work needs, in production's sudoers:

```
claude ALL=(videofy) NOPASSWD: /usr/bin/node, /usr/bin/test
```

`node` with a caller-chosen script is arbitrary code execution as the service
user — and the script it ran lived under `/tmp`, owned by the deploy account.
That is not a preflight permission; it is a second identity. `test` is a
readable-file oracle over everything `videofy` can reach.

## The replacement

`/usr/local/sbin/videofy-production-preflight`, root-owned 0755, invoked **as
`videofy`** and never as root:

```
sudo -n -u videofy /usr/local/sbin/videofy-production-preflight <candidate>
sudo -n -u videofy /usr/local/sbin/videofy-production-preflight --check
```

Compiled in, not chosen by the caller: the release store, the environment file
(`/etc/videofy-prod/media-ingest.env`), the `node` binary, and the
implementation (`/usr/local/lib/videofy/preflight-config.mjs`, root-owned,
verified non-writable before it is run). Letting the caller name the
environment file would turn this into *read any file you like, as the identity
that can read the secrets*.

It takes **exactly one argument**. A second is refused, so there is no way to
smuggle a path in beside the first.

### The candidate contract

Enforced inside the program, not in sudoers. A sudoers wildcard is a pattern
match on a string the caller supplies: it cannot canonicalise, it cannot follow
a symlink, and it cannot tell `/srv/videofy-prod/releases-scratch` from
`/srv/videofy-prod/releases`.

Accepted — the two forms the engine actually produces:

```
/srv/videofy-prod/releases/.candidate-<40 lowercase hex>.<transaction suffix>
/srv/videofy-prod/releases/<40 lowercase hex>
```

Refused: relative paths, the empty path, `/`, `..` traversal, the release store
itself, anything nested below it, prefix lookalikes, any symlink resolving
outside the store, any basename that is not one of the two forms, and more than
one argument. The path is canonicalised with `readlink -m` **before** it is
compared, so a link is judged by where it lands rather than how it is spelled;
containment uses a trailing slash, because `releases-anything` starts with the
same characters as `releases`.

### What it does execute as the service user, stated plainly

The candidate's own `config.js`, imported by the installed implementation. That
is deploy-authored code running as `videofy` — but it is the same file the
service will execute as `videofy` moments later if the candidate is published.
The preflight exercises that boundary early; it does not widen it. What
containment buys is that it can only ever be a real candidate inside the
release store, never a tree the caller nominates.

### No fallback

On production, a missing helper **refuses**. Falling back to the generic
commands would mean the policy could be narrowed while the code kept asking for
the grant that was just removed — failing later, with a sudo error instead of an
explanation. Non-production keeps the direct form; its sudo policy is separate
and is its own package.

## The final privilege model

```
Cmnd_Alias VIDEOFY_PUBLISH = /usr/local/sbin/videofy-publish-current
Cmnd_Alias VIDEOFY_ACTIVATE = /usr/bin/systemctl restart videofy-prod-account, /usr/bin/systemctl restart videofy-prod-gateway, /usr/bin/systemctl restart videofy-prod-media-ingest
Cmnd_Alias VIDEOFY_PREFLIGHT = /usr/local/sbin/videofy-production-preflight

claude ALL=(root) NOPASSWD: VIDEOFY_PUBLISH, VIDEOFY_ACTIVATE
claude ALL=(videofy) NOPASSWD: VIDEOFY_PREFLIGHT
```

Each unit is written out. `systemctl restart videofy-prod-*` would look tidier
and would authorise restarting anything that ever carries that prefix. The
alias is built on one line: a backslash-continuation emitted from a shell script
is the kind of generated escaping that renders as a literal `\n` when somebody
edits the `printf` later, and the file it would corrupt decides whether anybody
on the box can use sudo.

Deploy and rollback use the same three primitives — `release_rollback`
delegates to `release_publish`, and both activate through the same restart path.

## Installation

`deploy/production/install-sudo-hardening.sh` — root-only, idempotent, and it
installs only the preflight program, its root-owned implementation, and the
rules. It writes no unit, reloads nothing, restarts nothing, and touches no
pointer, Caddy, coturn, environment file or database.

**It does not remove the broad grant.** The narrow rules go in beside it, which
is the only safe order: the policy has to be provable on the host before
anything is taken away, with a root session open.

Every replacement is a rename, the pattern proven in PR #11 — staged beside its
destination on the same filesystem, final ownership and mode applied, validated,
then renamed over the top. `install` and `cp` write through the destination, and
sudo reads `/etc/sudoers.d` on every invocation.

## Qualification

Run on the Linux target; the suite refuses to run where `ln -s` is emulated.

- **387 passed, 0 failed.**
- Six new mutations, each of which must turn the suite red:

| Mutation | Defect |
|---|---|
| `generic-node-authority` | production runs a caller-chosen script as the service user again |
| `generic-test-authority` | the capability checks go back to generic `test` |
| `service-name-wildcard` | `restart videofy-prod-*` instead of three named units |
| `systemctl-enable-authority` | provisioning authority smuggled into deployment authority |
| `candidate-containment-bypassed` | the helper trusts the path it is handed |
| `broad-nopasswd-all` | the thing this package removes, quietly re-added |

`candidate-containment-bypassed` **survived its first run at 384/0**: it removed
two of the four containment guards, and the parent-directory check still caught
every path the tests offered. Both were wrong — the mutation was too weak *and*
the tests were describing shapes rather than the attack. The refusal cases are
now candidate-shaped trees that genuinely load: one outside the store, one in a
prefix lookalike, and one reached by a correctly-named symlink from inside the
store. Each would run the caller's code as the service identity if containment
were removed. The mutation now kills exactly those three.

## Not done, and deliberately

The host has not been touched. `claude ALL=(ALL) NOPASSWD: ALL` is still in
force, the narrow rules are not installed, and production is unchanged:
`current -> releases/e9b81e55…`, `www -> current/www`, same PIDs, Replay off.

A successful `sudo` while the broad grant is active proves **nothing** about the
narrow policy. The host sequence — install alongside, keep a root session open,
prove each primitive with non-mutating calls, prove the denials, then remove the
exact broad rule and `sudo -k` — is the next step, and needs its own
authorisation.
