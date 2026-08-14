# P6.1A Duplex Language Prerequisites — Implementation Report

- **Repository owner:** masterzee001
- **Date:** 2026-08-14
- **Milestone:** P6.1A — Duplex Language Prerequisites (development profile)
- **Implementation status:** Complete and machine-validated; human voice-quality acceptance and
  repository-owner approval remain the formal closure gates
- **Baseline:** `main@daad195` (P6-G0 governance and P6.0 contracts merged and CI-verified)
- **Execution note:** The wave was started by Codex Sol6 and completed, validated, and integrated
  under acting-lead Claude supervision with an independent review agent, per the owner's explicit
  instruction while Codex was unavailable.

## Outcome

The `development-demo` profile now has every machine-verifiable prerequisite for a native
English↔Spanish call: a validated multilingual STT path, explicit ordered translation routes in
both directions, English as a recipient/TTS target, and four machine-registered gendered standard
voice selections (English Male/Female, Spanish Male/Female) proven against the real local
runtime. No session, media, language, routing, or delivery authority moved, and no commercial
readiness is claimed.

## Delivered controls

- `Systran/faster-whisper-small` (multilingual, MIT, revision `536b0662…`) registered and
  validated for English and Spanish speech input; the proven English `small.en` baseline remains
  untouched as the default.
- `Helsinki-NLP/opus-mt-es-en` (Apache-2.0, revision `c96e2c53…`) added as an explicit ES→EN
  route; English added to supported translation targets, TTS languages, and the viewer catalogue.
- Ordered `translationLanguagePairs` on registry assets and capability routes: a model's
  direction can never satisfy its reverse, enforced by schema refinements and readiness issues
  (`missing-translation-language-pair`, `translation-language-pair-mismatch`).
- Standard-voice records now bind an exact TTS `assetId` and model revision
  (`voice-asset-mismatch`, `voice-asset-revision-mismatch`), carry `genderEvidence`, and support
  multi-speaker models via `speakerId`/`speakerKey`.
- Piper provider and config support multi-speaker selection (`--speaker N`, including speaker 0)
  through `PIPER_VOICE_SETTINGS`.
- Four voice selections registered with real sha256 model hashes: `en_US-hfc_male-medium`,
  `en_US-hfc_female-medium` (CC-BY-NC-SA-4.0 → `blocked-noncommercial`, development/demo only)
  and `es_ES-sharvard-medium` speakers 0/`M` and 1/`F` (CC-BY-3.0 → `review-required`).
- An opt-in real-provider acceptance test
  (`RUN_P6_1A_REAL_PROVIDER_TESTS=true`) proving the full duplex chain against locally staged
  models, with evidence written only to ignored local paths.

## Acceptance evidence

| Check | Result |
| --- | --- |
| ai-registry policy suite | Passed — 21 tests, including direction-mismatch, voice-asset binding, and truthful not-ready voice readiness |
| media-ingest suite | Passed — 257 tests (+1 gated real-provider test) after review corrections |
| Real local provider acceptance | Passed — EN→ES "Hello, good morning." → "Hola, buenos días."; ES→EN back to "Hello, good morning."; EN and ES synthetic phrases transcribed exactly with correct detected language; four real WAVs generated with `--speaker 0/1` proven |
| Provider latencies (CPU, cold-start inclusive; measurements not guarantees) | Piper 509–568 ms; OPUS-MT 4 867–5 735 ms; faster-whisper 5 459–6 720 ms |
| Full `npm test`, `npm run lint`, `npm run typecheck`, `npm run test:integration`, speech-worker `pytest` | Passed on the integrated wave before landing |
| Independent adversarial review of the integrated diff | APPROVE-WITH-CORRECTIONS; all correction items applied and re-verified before landing (see below) |

## Independent review findings and corrections applied

The independent review found no blocker or high-severity defect and explicitly verified the
fail-closed policy, registry truthfulness, direction safety, `speakerId: 0` plumbing, git
hygiene, default compatibility, and unchanged runtime authority. Corrections applied before
landing:

1. **MEDIUM — English self-targeting.** Session creation previously accepted a target language
   equal to the session source (e.g. `en→en` with the default English source), failing late per
   segment instead of up front. `resolveSessionTargetLanguages` now receives the initial source
   language and rejects any matching target with a clear `unsupported-language` error;
   regression-tested in `translation-session.test.ts`.
2. **LOW — weak negated assertion.** The registry test now checks the two voice-asset mismatch
   codes independently instead of via a combined `arrayContaining` negation.
3. **LOW — unpinned defaults.** The P6.1A defaults are now exported constants
   (`DEFAULT_TRANSLATION_SUPPORTED_TARGET_LANGUAGES`, `DEFAULT_OPUS_MT_LANGUAGE_MODELS`) and
   pinned by tests so a revert cannot silently drop English or the es→en route.
4. **LOW — catalogue licence truthfulness.** The English viewer-catalogue entry now names the
   CC-BY-NC-SA-4.0 restriction on the current English Piper voices instead of a generic
   "model-dependent" string.
5. **LOW — test-isolation fragility.** Documented why deleted CSV env keys can be refilled from a
   developer's root `.env` and why affected tests must set values explicitly.
6. **INFO — speaker-argument adjacency.** The real-provider acceptance now asserts `--speaker`
   and its value are adjacent; the m2m100 registry entry documents its deliberate under-declared
   pair list.

Accepted as-is (fail-closed either way): a translation route without declared pairs throws a
schema error from `CapabilityRouteSchema` before the `missing-translation-language-pair`
readiness issue can be reported; the report-vs-throw contract for that one condition is
inconsistent but safe, and is left for a later polish wave.

Evidence values are recorded in
[MODEL_AND_VOICE_REGISTRY.md — P6.1A Development Provider Validation](MODEL_AND_VOICE_REGISTRY.md#p61a-development-provider-validation).

## Explicitly open for P6.1A closure

- **Human voice-quality review.** All four voices remain `qualityStatus=development`;
  `evaluateStandardVoiceReadiness` truthfully reports English and Spanish not fully voice-ready.
  Owner listening review of the generated samples is required before the §30.3 "approved
  Male/Female" items can be checked.
- **English commercial voice gap.** The HFC pair is CC-BY-NC-SA-4.0 and can never enter a
  commercial profile; sourcing a commercially licensed English Male/Female pair is a C-AI1 item.
- **Human test corpus.** Nigerian-accented English, names/numbers/dates, noisy audio, and
  code-switching review (§31.1) remain pending.
- **P6.1B/P6.1C.** The native two-person call runtime and its browser/device acceptance are
  separate milestones and are not claimed here.

No commit, push, merge, release, deployment, credential change, or external repository-setting
change was made by the implementation agents; landing was performed by the acting lead under the
owner's standing instruction.
