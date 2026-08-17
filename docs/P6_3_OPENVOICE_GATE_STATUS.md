# P6.3 — OpenVoice V2 approval gate status

**Owner:** masterzee001 · **Updated:** 2026-08-17

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
| 2 | Checkpoint provenance | **Partial** | Every behaviour-critical artifact is now SHA-256 recorded in [`engine-provenance.json`](../services/openvoice-service/engine-provenance.json) and verified at startup. Still partial because the derived French embedding is **not byte-reproducible** — see below. |
| 3 | Dependency audit | **Met** | The runtime is now identified: engine installed non-editably from wheels built at pinned commits, lockfile recaptured from that interpreter, no `-e` installs and no machine paths. Upstream's unused Whisper/PyAV stack is excluded on evidence — [`openvoice-runtime-graph.py`](../scripts/openvoice-runtime-graph.py) exercises the real path and reports none of it imported. |
| 4 | Installation reproducibility | **Partial** | Reproduced once in a fresh local venv: `PYTHONPATH` unset, imports resolving from site-packages, and the engine path still producing audio with the source checkouts **renamed away**. That is a local clean-environment reproduction, not a clean-machine one — cached wheels, build tools and model caches on this laptop can still rescue a supposedly clean setup. Fully met only after a rebuild on a genuinely fresh host. |
| 5 | EN→ES cloning | **Met** | `verify-personal-voice.mjs en es` — 14/14. |
| 6 | ES→EN cloning | **Met** | `verify-personal-voice.mjs es en` — 14/14. First run 2026-08-16; this direction had never been exercised before. |
| 6b | EN→FR cloning | **Met** | `verify-personal-voice.mjs en fr` — 14/14, 2026-08-17. French previously failed and fell back silently; see below. |
| 7 | Identity similarity | **Owner-judged, development-demo only** | ~7/10, owner, 2026-08-16. Explicitly not a production claim. No automated similarity metric exists, and one should not be invented to make this row look greener. |
| 8 | Intelligibility | **Met** | Cloned audio fetched back through the delivery route and re-recognised: 100% content-word overlap in both directions. Held to the same 60% bar as the standard path. |
| 9 | Latency | **Met for a live call** | Engine synthesis 438–669 ms for 2.7–4.2 s of speech; ratio 0.12–0.17. Comfortably faster than real time on the development GPU. |
| 10 | GPU/CPU behaviour | **Partial** | GPU characterised: CUDA on sm_120 (RTX 5060 Blackwell), 1.2–1.5 GB VRAM. CPU-only behaviour has never been run and is unknown, not slow. "Met (single GPU)" previously stood next to evidence saying the CPU half was uncharacterised — a status doing administrative work on the missing half of its own gate. |
| 11 | Failure behaviour | **Met** | Personal synthesis failure re-speaks the same text in the session's own standard voice, not the service default. Covered by tests against the real wiring, and observed live: after deletion the next utterance used the standard voice on the same session. |
| 12 | Cleanup behaviour | **Met** | Revocation and deletion destroy the recording, the derived asset and already-generated audio. Verified live: a clip fetchable before withdrawal (200) is gone after (404). Records survive restart; material that outlives its record is swept at startup. |

## French: fixed, and what that revealed

French was advertised and could not be spoken. `base_speakers/ses/` held only
`en-newest.pth` and `es.pth`, so every French synthesis reached `torch.load`,
raised `FileNotFoundError`, returned 500, and fell back to a standard voice —
which, until the same day, was also the wrong gender. Every layer behaved
correctly and the outcome was a man hearing himself as a woman.

The missing file is now **derived rather than downloaded**, by
[`openvoice-derive-source-speaker.py`](../scripts/openvoice-derive-source-speaker.py):
a source embedding is `extract_se` over audio from that base speaker, which is
how the published ones were made, and the French base speaker was already
installed. No network, no drift against a release archive, and the embedding
provably matches the voice this machine actually synthesises with.

### The derivation is NOT byte-deterministic

Tested rather than assumed. The validated `fr.pth` was set aside, a fresh
derivation run from the same pinned environment, and the hashes compared:

```
validated  : f79376d3ace46158f2904436f7439ab89666a27839661e77549838bd85026b6c
re-derived : ed50743ef8c25eccfa1c92689bb2420d03b75f0a2bfd8fe67e23951f4f5ac669
NOT DETERMINISTIC
```

MeloTTS synthesis samples, so every derivation produces different audio and
therefore a different embedding. The validated artifact was restored; the
re-derived one was discarded.

The consequence is a rule, not a caveat: **`fr.pth` is a versioned external
model artifact identified by its hash, and must be distributed rather than
regenerated per machine.** A second machine running the derivation script gets a
French voice that is *similar* and not *the same*, and no acceptance evidence
gathered here would transfer to it. The script remains useful for bootstrapping
a language nobody has yet; it is not a substitute for shipping the bytes.

This is why gate 2 stays partial and cannot close by adding hashes alone.

Finding this exposed a bigger problem. The service was running on the **system
Python 3.9**, not the isolated `.venv-openvoice` this document claimed, with
`melo` and `openvoice` imported from source checkouts under `.openvoice-src`.
The lockfile captured on 2026-08-16 described an environment that was not the
one serving requests, and gates 3 and 4 were marked met on that basis. Both are
now marked **not met**, which is what they always were.

## What is not met, and what it would take

**Checkpoint provenance (2).** Hashing and startup verification are DONE: a
mismatched artifact removes its language rather than being synthesised with
(proved by tampering the French hash and watching `["en","es","fr"]` become
`["en","es"]`). What remains is distribution — the derived `fr.pth` must be
published by hash, because it cannot be reproduced.

**Dependency audit (3) and installation reproducibility (4).** Decide what the
engine environment actually IS, then record it: pin the `MeloTTS` and
`OpenVoice` checkouts to commits, install them into `.venv-openvoice` rather
than reaching them through `PYTHONPATH`, start the service with that
interpreter, and re-capture the lockfile from the interpreter that serves
requests. Then rebuild it once on a machine that has never had it. Until that
has been done, the lockfile records something adjacent to the truth.

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
node scripts/verify-personal-voice.mjs en fr
```

The engine currently needs the source checkouts on its path, which is itself
gate 4 being unmet:

```
$env:PYTHONPATH = "$PWD\.openvoice-src\MeloTTS;$PWD\.openvoice-src\OpenVoice"
.\.venv-openvoice\Scripts\python.exe services\openvoice-service\server.py
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

## Where identity stands, above all of this

Voice ownership was a `devid_` value in browser `localStorage` until 2026-08-16.
That is no longer true and this section previously still said it was.

`VoiceOwnerId` is now an account id, derived by the gateway from a verified
session token and never accepted from a client. Enrolment, deletion and call
join all authenticate; resume re-proves identity on every reconnect rather than
keeping whoever was last attached to a seat.

| | |
|---|---|
| Browser-local authority removed | done |
| Client owner assertion removed | done, the field no longer exists |
| Enrolment / deletion authenticated | done |
| Call join authenticated | done |
| Resume re-verifies identity | done |
| Server-side identity proof | `verify-account-identity.mjs` 8/8 |
| Human browser acceptance | **pending** — see [ACCOUNT_IDENTITY_ACCEPTANCE.md](ACCOUNT_IDENTITY_ACCEPTANCE.md) |

One limitation is deliberate and unclosed: services verify session tokens
locally, so a token stays usable at the gateway and media-ingest until it
expires even after the account service has revoked that generation. That keeps a
call joinable while sign-in restarts, and it must be revisited before any public
staging.
