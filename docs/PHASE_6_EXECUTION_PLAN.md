# Phase 6 Execution Plan

**Repository owner:** masterzee001  
**Authoritative architecture:** [VIDEOFY_MASTER_ARCHITECTURE.md](VIDEOFY_MASTER_ARCHITECTURE.md), Version 3.0  
**Lead supervisor and integration owner:** Codex Sol6  
**Current milestone:** P6-G0 — Truth, Governance, and Provider Boundary  
**Status:** P6-G0 implementation complete; owner and independent Claude review pending  
**Baseline:** `main@b4ac24e6ef8220847efd2795e0dbf94cce7d5ad6`

## Scope decision

Architecture Version 3.0 explicitly says not to implement the entire roadmap in one pass. This
execution starts with P6-G0 and does not move media, session, language, or provider runtime
authority. P6-UX0, P6.0, and later milestones remain separate approval and regression gates.

## Pre-change report

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

## P6-G0 work packages

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

## Required verification

```text
npm test
npm run lint
npm run typecheck
npm run build
npm run test:integration
services/speech-worker/.venv/Scripts/python.exe -m pytest -q
```

The first local baseline run observed one timeout in
`generated-audio-session.test.ts`; its focused rerun passed all 12 tests. An independent audit run
reported the complete JavaScript and Python baseline green. The final integrated run then passed
all required commands. Detailed results and deferred items are recorded in the
[P6-G0 implementation closure report](P6_G0_CLOSURE_REPORT.md).

## Sequenced follow-on milestones

After P6-G0 owner review:

1. P6-UX0 establishes the shared premium, role-separated experience foundation.
2. P6.0 extracts participant/call/recipient-routing contracts without changing Live behavior.
3. P6.1A proves Spanish-capable STT, ES→EN, English TTS, and approved EN/ES Male/Female voice pairs.
4. P6.1B/P6.1C implements and validates the native two-person call.
5. P6.2–P6.8 proceed in architecture order; external adapters begin only after native Call is stable.

No partial voice-readiness waiver is permitted. Commercial launch remains a separate fail-closed
certification gate.

## Closure and handoff

The Codex implementation and evidence wave is complete. Independent Claude reconciliation and
repository-owner approval are subsequent gates required for formal P6-G0 closure; they are not
silently claimed by this plan. GitHub branch protection also remains an external owner action.
