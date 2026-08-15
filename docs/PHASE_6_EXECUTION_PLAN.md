# Phase 6 Execution Plan

- **Repository owner:** masterzee001
- **Authoritative architecture:** [VIDEOFY_MASTER_ARCHITECTURE.md](VIDEOFY_MASTER_ARCHITECTURE.md), Version 3.0
- **Lead supervisor and integration owner:** Codex Sol6 (P6.1A completed under acting-lead Claude supervision while Codex was unavailable)
- **Current milestone:** P6.1B — Native two-person call runtime (development profile)
- **Status:** P6.1 CLOSED (A, B, C) — owner voice review and milestone acceptance both given 2026-08-15, under `development-demo` only. Active work: P6.2; commercial readiness remains gated on C-AI1.
- **P6.0 baseline:** `main@2a06e1dfd833532125c06986843e645a2dcff34b`
- **P6.1A baseline:** `main@daad195` (P6-G0 and P6.0 merged and CI-verified)

## Scope decision

Architecture Version 3.0 explicitly says not to implement the entire roadmap in one pass. P6-G0
is present on the P6.0 baseline. This wave implements only P6.0's additive contracts and
compatibility seam; it does not move media, session, language, provider, or Socket.IO delivery
authority. P6-UX0, P6.1A, and later milestones remain separate approval and regression gates.

## P6-G0 pre-change record

| Required fact                         | Verified state                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch and HEAD                       | Local `main` matches `origin/main` at `b4ac24e6...`.                                                                                                             |
| Worktree                              | No tracked changes at wave start; pre-existing architecture/plan files were untracked and preserved through reconciliation.                                      |
| Proven implementation                 | Phase 5 programme ingest, WebRTC delivery, multilingual translation/TTS, listener mixing, revision checks, and cleanup exist.                                    |
| P6-G0 gap                             | No machine-readable AI asset registry, explicit runtime-profile contract, or recursive commercial fallback gate existed.                                         |
| Runtime behavior changed by this wave | The default development-demo path is preserved. Media-ingest now rejects non-default profiles at startup until their complete provider selections are certified. |
| Regression risk                       | Workspace registration and CI scripts could omit or disturb existing packages; full test/typecheck/build/lint gates are required.                                |
| External capability assumptions       | None. No Zoom, KingsConference, SIP, or other adapter claim is made.                                                                                             |

Current truths that must not be reimplemented or misstated:

- `sourceLanguageRevision` already exists in the timestamped translation contract.
- The WebRTC gateway uses an energy gate when `silero` is requested; true Silero integration there
  is future work.
- NLLB-200 and MMS-TTS stay available only to the truthful `development-demo` profile and are
  blocked from commercial profiles.
- The current development/demo provider stack remains intact.

## P6.0 pre-change report

| Required fact                   | Verified state                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Branch and HEAD                 | `main` matched `origin/main` at `2a06e1df...` when this wave began.                                                               |
| Worktree                        | Clean at wave start; only bounded P6.0 files are changed or added by this wave.                                                   |
| Current runtime authority       | Media-ingest `ProcessingSession` plus gateway programme/WebRTC state remain authoritative.                                        |
| Existing delivery behavior      | Legacy translations and generated audio use established language/operator Socket.IO rooms; listener mixing remains browser-local. |
| P6.0 gap                        | No common participant/call contracts, programme projection, or platform-neutral recipient-output policy existed.                  |
| Regression risk                 | Changing event payloads, rooms, delivery order, language authority, revisions, or media flow would regress Live.                  |
| Unsupported external capability | No native call runtime/UI, participant registry, Zoom, KingsConference, SIP, or commercial provider is claimed.                   |

## P6-G0 delivery record

| ID   | Owner                          | Deliverable                                                                                                                                                                            | Gate                                                                                                   |
| ---- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| G0.1 | Codex lead                     | Ratify the supplied Architecture V3 as the canonical repository document.                                                                                                              | Exact content reconciliation and owner metadata.                                                       |
| G0.2 | Governance agent, Codex review | Add one indexed ADR set for identity, authority/time, adapters, commercial policy, profiles, voice rights, training data, native-model lineage, CI/release, and experience boundaries. | ADR consistency review.                                                                                |
| G0.3 | Registry agent, Codex review   | Add machine-readable provider/model/voice contracts and current truthful classifications.                                                                                              | Schema and registry tests.                                                                             |
| G0.4 | Registry agent, Codex review   | Add four runtime profiles and recursive fail-closed readiness validation.                                                                                                              | Blocked primary/fallback, missing asset, mode mismatch, and production-approval tests.                 |
| G0.5 | Codex lead                     | Register the additive package, expose `AI_RUNTIME_PROFILE=development-demo`, and make CI validate governance.                                                                          | Install, focused test, typecheck, and build.                                                           |
| G0.6 | Codex lead                     | Publish P6-G0 evidence and reconcile all documentation to actual results.                                                                                                              | Full repository regression gate.                                                                       |
| G0.7 | Governance agent, Codex review | Apply the requested proprietary licence.                                                                                                                                               | `Videofy by TAC Proprietary Software License`, `All Rights Reserved`, repository owner `masterzee001`. |

Workers may inspect broadly but edit only their assigned scope. Codex reviews every actual diff;
worker summaries alone are not acceptance evidence. No worker commits, pushes, merges, changes
credentials, or weakens architecture to make tests pass.

## P6.0 work packages

| ID     | Owner                                    | Deliverable                                                                           | Gate                                                                              |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| P6.0-1 | Participant-contract agent, Codex review | Canonical identities, revisions, media, capabilities, and preferences.                | Raw-only STT ingress, generated-audio egress separation, and language-lock tests. |
| P6.0-2 | Call-contract agent, Codex review        | Call/session, collision-safe routed events, legacy mappers, and programme projection. | Schema, identity/revision, compatibility, and immutability tests.                 |
| P6.0-3 | Language-router agent, Codex review      | Pure recipient-output policy and legacy programme audience selection.                 | No platform dependency; truthful fallback and audience tests.                     |
| P6.0-4 | Codex lead                               | Register packages and wire abstract audiences back to unchanged gateway rooms/events. | Existing gateway and integration regressions pass.                                |
| P6.0-5 | Codex lead and independent reviewer      | Synchronize ADRs/evidence and audit the integrated wave.                              | Architecture §30.2 and §32.2 acceptance review.                                   |

## P6.1A pre-change report

| Required fact                   | Verified state                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Branch and HEAD                 | `main` matched `origin/main` at `daad195` when this wave began.                                                                  |
| Worktree                        | Clean apart from bounded P6.1A files; model assets were pre-staged into ignored local paths before validation.                   |
| Current runtime authority       | Unchanged; this wave only adds provider capability, registry truth, and configuration under `development-demo`.                  |
| P6.1A gap                       | No Spanish-capable STT path, no ES→EN route, no English TTS target, and no gendered EN/ES standard-voice selections existed.     |
| Regression risk                 | Config default changes, registry schema tightening, and Piper argument changes could regress existing language delivery.        |
| Unsupported external capability | No native call runtime, call UI, external adapter, cloud provider, or commercial certification is claimed.                       |

## P6.1A work packages

| ID      | Owner                                     | Deliverable                                                                                          | Gate                                                                       |
| ------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| P61A-1  | Registry agent, lead review               | Multilingual STT, es→en OPUS-MT, EN/ES Piper voice assets with real revisions, hashes, and licences. | Registry schema and truthfulness tests.                                    |
| P61A-2  | Registry agent, lead review               | Ordered `translationLanguagePairs` so a model direction can never imply its reverse.                 | Direction-mismatch and route-validation tests.                             |
| P61A-3  | Provider agent, lead review               | Piper multi-speaker `speakerId` support (including speaker 0) through config and CLI.                | Provider argument tests covering all four voice selections.                |
| P61A-4  | Provider agent, lead review               | English as translation/TTS target; es:en OPUS-MT route; viewer catalogue English entry.              | Config and catalogue tests; existing defaults preserved.                   |
| P61A-5  | QA agent, lead run                        | Opt-in real local provider acceptance proving both STT/translation directions and four voices.       | `RUN_P6_1A_REAL_PROVIDER_TESTS=true` run with recorded evidence.           |
| P61A-6  | Docs agent, lead review                   | Registry evidence section, plan update, and implementation report reconciled to actual results.      | Evidence values match the recorded acceptance run.                         |
| P61A-7  | Independent reviewer                      | Adversarial review of the integrated diff before landing.                                            | No blocker/high finding outstanding.                                       |

## P6-G0 acceptance checklist

- [x] Current remote `main` and Phase 5 merge baseline recorded.
- [x] Architecture V3 records honest gateway VAD, provider, licence, and prerequisite truth.
- [x] `sourceLanguageRevision` is treated as already fixed in the referenced contract.
- [x] Canonical ADR decisions added without runtime-authority movement.
- [x] Runtime-profile contract exists at architecture and code/config level.
- [x] Registry separates commercial-use state from production approval.
- [x] Commercial primary and every nested fallback fail closed when blocked or unapproved.
- [x] Branch/CI/release policy is documented and CI validates the new governance package.
- [x] Focused tests and the complete repository regression gate pass.
- [x] Codex diff/architecture/security/commercial review is complete.

## P6.0 acceptance checklist

- [x] Canonical participant, call-session, media, and language revision contracts are additive.
- [x] Participant and call schemas compose one authority instead of duplicating it.
- [x] Programme maps into `ParticipantMedia` without changing its active media path.
- [x] Raw source audio and generated recipient audio are structurally separated.
- [x] Adapter ingress, egress, and lifecycle capabilities are independently declared.
- [x] Legacy `TranslationEvent` remains intact; new output uses `RoutedTranslationEvent`.
- [x] Recipient routing is pure and has no Socket.IO, Express, or external-platform dependency.
- [x] Gateway compatibility wiring preserves event names, payloads, rooms, and ordering.
- [x] Final complete repository regression gate and independent integrated review pass.

## P6.1A acceptance checklist (§30.3)

- [x] Spanish speech is transcribed by the validated multilingual `Systran/faster-whisper-small` path.
- [x] English speech remains validated (existing `small.en` baseline preserved; multilingual run re-proved English).
- [x] EN→ES translation works (`Helsinki-NLP/opus-mt-en-es`).
- [x] ES→EN translation works (`Helsinki-NLP/opus-mt-es-en`).
- [x] English is a valid recipient target (translation targets, TTS languages, viewer catalogue).
- [x] English standard TTS works (both HFC voices generated real audio).
- [x] Spanish standard TTS works (both sharvard speakers generated real audio).
- [x] Voice metadata is machine-readable with per-voice gender evidence, asset binding, and revision hashes — not inferred from filenames.
- [ ] English Male/Female standard voices **approved**: registered and runtime-validated, but `qualityStatus=development` until the repository owner completes human voice-quality review. Readiness APIs truthfully report not-ready.
- [ ] Spanish Male/Female standard voices **approved**: same human quality-review gate.

No voice-partial waiver is claimed: English and Spanish are deliberately **not** labeled fully
voice-ready, and P6.1A remains open until the owner's human quality acceptance. The English HFC
pair is additionally CC-BY-NC-SA-4.0 (development/demo only); a commercially licensed English
voice pair is tracked under C-AI1.

## Required verification

```text
npm test
npm run lint
npm run typecheck
npm run build
npm run test:integration
services/speech-worker/.venv/Scripts/python.exe -m pytest -q
```

During P6-G0, the first local baseline run observed one timeout in
`generated-audio-session.test.ts`; its focused rerun passed all 12 tests. An independent audit run
reported the complete JavaScript and Python baseline green. The final integrated run then passed
all required commands. Detailed results and deferred items are recorded in the
[P6-G0 implementation closure report](P6_G0_CLOSURE_REPORT.md).

P6.0 focused checks, the complete repository regression gate, desktop/mobile browser QA, and an
independent lower-model acceptance review are green. Exact evidence is recorded in the
[P6.0 implementation report](P6_0_IMPLEMENTATION_REPORT.md).

P6.1A machine evidence (real EN/ES STT, both OPUS-MT directions, four Piper voice selections) is
recorded in
[docs/MODEL_AND_VOICE_REGISTRY.md — P6.1A Development Provider Validation](MODEL_AND_VOICE_REGISTRY.md#p61a-development-provider-validation)
and the [P6.1A implementation report](P6_1A_IMPLEMENTATION_REPORT.md).

## P6.1B delivery record

The native two-person call runtime is implemented per the locked
[P6.1B design note](P6_1B_CALL_RUNTIME_DESIGN.md) with a bounded agent team (session, frontend,
runtime, independent-review agents) under acting-lead supervision: `services/call-session` (pure
core, 48 tests), the gateway `call:*` runtime (23 new tests; programme paths untouched and
green), media-ingest per-session voice overrides, and `apps/call-web` (53 tests). The complete
repository gate (test/typecheck/lint/build/integration/pytest) passed on the integrated wave.
Evidence and open items: [P6.1B implementation report](P6_1B_IMPLEMENTATION_REPORT.md).

## Sequenced follow-on milestones

After P6.1B owner review:

1. P6.1C: real two-browser/device acceptance, honest latency evidence, camera video, and the
   §30.4 sign-off table — plus the still-open P6.1A human voice-quality review.
2. P6-UX0 may establish the shared premium, role-separated experience foundation as its own wave.
3. P6.2–P6.8 proceed in architecture order; external adapters begin only after native Call is stable.
4. C-AI1 sources a commercially licensed English Male/Female voice pair (the HFC pair is dev-only).

No partial voice-readiness waiver is permitted. Commercial launch remains a separate fail-closed
certification gate.

## Closure and handoff

P6-G0 and P6.0 are merged to `main` and CI-verified. The P6.1A wave was started by Codex and
completed, validated, and integrated under acting-lead Claude supervision with an independent
review agent, per the owner's explicit instruction while Codex was unavailable. Repository-owner
approval — including human voice-quality acceptance for the four registered voices — remains the
formal P6.1A closure gate and is not claimed by this plan. GitHub branch protection also remains
an external owner action.

## Owner direction, 2026-08-15

### P6.1A closed
The owner reviewed the six registered development voices (EN, ES, FR male and female) and
accepted them. That satisfies the §30.3 human-acceptance gate for `development-demo`, the only
profile these assets are licensed for. It is not commercial voice readiness: the English HFC pair
is CC-BY-NC-SA-4.0, so English still cannot ship commercially on it. See the
[P6.1C acceptance report](P6_1C_ACCEPTANCE_REPORT.md).

### Accounts change the call surface
Once users register, the call page must adapt to their stored profile rather than asking every
time. Speaking language, hearing language and voice gender become profile data with sensible
per-call overrides, not fields to re-enter on each join.

This moves work between milestones: the pre-join screen built in P6-UX0 assumes an anonymous
guest, and DEP-1 owns accounts and persistence. The participant contract already carries these
preferences, so the change is where the values come FROM, not what they are. Sequencing: DEP-1
lands identity and persistence first, then the participant surface reads from it.

### Personal voice becomes the default, not an option
Owner decision: when a user has a cloned voice, that voice is what the other side should hear.
On any other call they would be heard in their own voice, and translation should not cost them
their identity. Standard voice becomes the FALLBACK — used before enrollment, on failure, or by
explicit choice.

This inverts ADR-006 ("Personal voice optional; never blocks joining/translation"). The half that
must survive the inversion is the second clause: a missing, failed or still-training personal
voice must still never block a call. Default-on changes which voice is preferred, not whether the
call can proceed without one.

**Consent cannot ride on the terms of service, and this needs design work before P6.3.** A voice
model trained on a person's recordings is biometric data. Where GDPR applies, biometric data used
to identify a person needs explicit, specific, separable consent — acceptance of general terms is
not sufficient, and Illinois BIPA imposes similar requirements with statutory damages. The product
goal survives intact; the mechanism has to differ:

- enrollment is its own affirmative step with its own consent, not a checkbox inside the T&Cs;
- consent is revocable, and revocation deletes the model and its training audio;
- the other participant can see that a synthetic clone of a real voice is being used;
- refusing or revoking falls back to a standard voice and never blocks the call.

This is exactly the surface an institutional customer's legal review would examine first, which is
why it is recorded here rather than left to implementation.
