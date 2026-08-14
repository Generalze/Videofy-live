# Branch and Release Protection

Repository owner: masterzee001

This file records the repository-side settings required by P6-G0. GitHub settings remain external
state and must be enabled by `masterzee001`; committing this file cannot enforce them by itself.

## Protect `main`

- Require a pull request before merging.
- Require an approving review from the repository owner or an explicitly delegated reviewer.
- Dismiss stale approvals after new commits and require review-conversation resolution.
- Require the `Repository CI / validate` status check to pass on the latest commit.
- Require branches to be current before merge.
- Block force pushes and branch deletion.
- Do not permit bypass for commercial release changes.

## Commercial release gate

A tag, build, or deployment may start only from protected `main` after the milestone acceptance
evidence is approved by `masterzee001`. CI success is necessary but does not replace provider
licence/readiness evidence, human language/voice review, security review, or architecture closure.
