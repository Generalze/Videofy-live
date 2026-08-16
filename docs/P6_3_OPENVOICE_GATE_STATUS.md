# P6.3 — OpenVoice V2 approval gate status

**Owner:** masterzee001 · **Updated:** 2026-08-16

Architecture §21.9.2.3 says selection is not approval. OpenVoice V2 entered the
registry as `development-unvalidated` and must pass a named list before **any
production claim**. This document tracks that list against actual evidence.

It exists because the approval state is a field in code
([`openvoice-personal-voice.ts`](../services/media-ingest/src/openvoice-personal-voice.ts))
that anybody could edit in a second, and a one-word edit is exactly how a
prototype acquires a commercial halo. Changing it should require pointing at
this page.

## Current state

**`development-unvalidated`. Unchanged, and correct.**

The owner accepted OpenVoice V2 at roughly 7/10 **for the `development-demo`
runtime profile** on 2026-08-16. That is a decision about which runtime profile
may use the engine. It is not the production approval this gate governs, and the
two are different axes that happen to share a vocabulary. An earlier draft of
this work proposed renaming the field to `development-demo` on the grounds that
the wording "understated" the owner's acceptance. That was wrong: it would have
converted a runtime-profile decision into a model-approval claim by editing a
string.

## The gate

| # | Gate | Status | Evidence |
|---|------|--------|----------|
| 1 | Licence provenance | **Met** | OpenVoice V2 is MIT; MeloTTS base speakers ship with it. Selected on licence grounds ahead of quality grounds (§21.9.2.3). |
| 2 | Checkpoint provenance | **Partial** | Checkpoints are the published OpenVoice V2 release. No hash manifest is recorded, so "the same checkpoints" is currently an assumption. |
| 3 | Dependency audit | **Met** | Isolated Python 3.9 `.venv-openvoice`, never sharing `.venv-ai`. Full resolved set recorded in [`requirements.lock.txt`](../services/openvoice-service/requirements.lock.txt). |
| 4 | Installation reproducibility | **Partial** | The environment is now captured and rebuildable from the lockfile, including the cu128 torch ordering constraint. It has not yet been rebuilt from scratch on a clean machine, which is the only thing that actually proves reproducibility. |
| 5 | EN→ES cloning | **Met** | `verify-personal-voice.mjs en es` — 14/14. |
| 6 | ES→EN cloning | **Met** | `verify-personal-voice.mjs es en` — 14/14. First run 2026-08-16; this direction had never been exercised before. |
| 7 | Identity similarity | **Owner-judged, development-demo only** | ~7/10, owner, 2026-08-16. Explicitly not a production claim. No automated similarity metric exists, and one should not be invented to make this row look greener. |
| 8 | Intelligibility | **Met** | Cloned audio fetched back through the delivery route and re-recognised: 100% content-word overlap in both directions. Held to the same 60% bar as the standard path. |
| 9 | Latency | **Met for a live call** | Engine synthesis 438–669 ms for 2.7–4.2 s of speech; ratio 0.12–0.17. Comfortably faster than real time on the development GPU. |
| 10 | GPU/CPU behaviour | **Met (single GPU)** | CUDA on sm_120 (RTX 5060 Blackwell), 1.2–1.5 GB VRAM. CPU-only fallback behaviour is not characterised. |
| 11 | Failure behaviour | **Met** | Personal synthesis failure re-speaks the same text in the session's own standard voice, not the service default. Covered by tests against the real wiring, and observed live: after deletion the next utterance used the standard voice on the same session. |
| 12 | Cleanup behaviour | **Met** | Revocation and deletion destroy the recording, the derived asset and already-generated audio. Verified live: a clip fetchable before withdrawal (200) is gone after (404). Records survive restart; material that outlives its record is swept at startup. |

## What is not met, and what it would take

**Checkpoint provenance (2).** Record the hashes of the checkpoint files the
service actually loads, and verify them at startup. Without this, "the same
model we validated" is trust rather than a fact, and a silently swapped
checkpoint is invisible.

**Installation reproducibility (4).** Rebuild `.venv-openvoice` from the
lockfile on a machine that has never had it, and run the two verification
directions against the result. Until that has been done once, the lockfile
records what is installed rather than proving it can be installed.

**Identity similarity (7).** There is no measurement here, only a judgement, and
the judgement was explicitly scoped to `development-demo`. A production claim
needs either an accepted similarity metric or a structured listening test with
more than one listener.

**CPU behaviour (10).** Nothing has been run without a GPU. A deployment without
CUDA is currently an unknown, not a slow path.

## Reproducing the evidence

Requires media-ingest running with `OPENVOICE_SERVICE_URL` set, and the
OpenVoice service up.

```
node scripts/verify-personal-voice.mjs en es
node scripts/verify-personal-voice.mjs es en
```

Each run enrols a fresh voice, speaks, checks intelligibility, restarts
media-ingest to prove the record persisted, withdraws consent, and deletes
itself. The script reports SKIPPED rather than PASS for the restart check when
the service does not actually restart — "never restarted" and "survived a
restart" must not print the same green line.

## Standing constraints

These are owner decisions and do not move because a gate went green.

- **XTTS-v2 is blocked from any commercial runtime.** Coqui Public Model
  License restricts the model and its outputs to non-commercial use. Development
  benchmark only.
- **Training consent stays inert.** P6.3 grants call use. It creates no training
  pipeline, whether or not training use was separately granted.
- **Customer calls are excluded from training by default.** Only explicitly
  permitted data crosses that boundary.
- **Videofy trains from a commercial provider's outputs only where that
  provider's terms explicitly permit training or distillation.**

## Known limitation above all of this

Voice ownership is a `devid_` value in browser `localStorage`. It is scoped to a
browser profile, not a person: two people sharing one browser share one voice,
and the same person on a second device cannot find theirs. Every guarantee in
the table above is sound and rests on this. `VoiceOwnerId` is the single seam
that makes the replacement cheap — an account id takes its place and nothing in
the voice-provider or call-routing contracts moves — but the replacement has not
happened, and this identity must not outlive P6.3.
