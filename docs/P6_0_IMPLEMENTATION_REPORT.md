# P6.0 Contract Extraction Implementation Report

- **Repository owner:** masterzee001
- **Date:** 2026-08-14
- **Milestone:** P6.0 — Contract Extraction
- **Implementation status:** Complete and independently audited; repository-owner and independent Claude review remain formal closure gates
- **Baseline:** `main@2a06e1dfd833532125c06986843e645a2dcff34b`

## Outcome

P6.0 adds the common participant, call/session, routed-event, programme-projection, and recipient-
output contracts required by Architecture V3. It also extracts the existing programme audience
selection into a pure platform-neutral router and wires that decision back through the gateway's
unchanged Socket.IO boundary.

The Phase 5 Live/uploaded-media runtime remains authoritative, and all supported viewer states
retain their behavior. Inconsistent metadata that claims audio without a usable voice now falls
back safely to original media. This milestone does not introduce a native call runtime,
participant registry, call UI, external-platform adapter, provider change, or commercial
capability claim.

## Delivered controls

- Branded canonical `ParticipantId`, `CallSessionId`, `MediaRevision`, and `LanguageRevision`
  contracts, without treating transport or external-platform identifiers as canonical identity.
- Participant media with one millisecond clock, a structurally raw-only STT ingress track, and a
  separate generated-audio recipient-egress contract.
- Independent adapter ingress, egress, and lifecycle capabilities.
- Composable language, caption, audio, and voice preferences that preserve manual language
  authority and existing manual-unlocked/confirmed-auto-locked states.
- Collision-safe `RoutedTranslationEvent`, caption, and generated-voice contracts while retaining
  the legacy `TranslationEvent` at the compatibility boundary.
- Explicit legacy mappers that require canonical programme context instead of inferring internal
  identities or revisions from legacy event IDs.
- A pure programme-as-participant projection over `ParticipantMedia`, with identity and revision
  consistency checks and external identifiers confined to integration metadata.
- A pure recipient-output policy with truthful text/audio/original fallbacks, optional personal
  voice plus standard-voice fallback, and generated audio restricted to egress.
- An identity-free legacy listener adapter over that same decision engine. The active Phase 5
  viewer now consumes the shared policy without inventing call, participant, media-revision, or
  language-revision values.
- A pure legacy programme audience selector wired into the existing gateway. Event names,
  payloads, Socket.IO rooms, delivery order, stores, media handling, and runtime authority remain
  unchanged.

## Acceptance evidence

| Check                                          | Result                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Participant-contract focused tests             | Passed — 6 tests                                                                                       |
| Call-contract focused tests                    | Passed — 11 tests                                                                                      |
| Language-router focused tests                  | Passed — 19 tests                                                                                      |
| Listener focused regression suite              | Passed — 145 tests                                                                                     |
| Gateway typecheck and focused regression suite | Passed                                                                                                 |
| Fresh `npm ci` followed by `npm test`           | Passed; lockfile and workspace build order reproduced from a clean dependency install                 |
| Full `npm test`                                | Passed across every workspace                                                                          |
| `npm run lint`                                 | Passed with zero warnings allowed                                                                      |
| Full `npm run typecheck`                       | Passed across every TypeScript workspace                                                               |
| Full `npm run build`                           | Passed across libraries, services, and both web applications                                           |
| `npm run test:integration`                     | Passed — 18 gateway/cross-process tests                                                                |
| Speech-worker `pytest -q`                      | Passed — 23 tests                                                                                      |
| `npm audit --omit=dev`                         | Passed — zero production dependency vulnerabilities                                                    |
| `git diff --check`                             | Passed                                                                                                 |
| Desktop/mobile browser QA                      | Passed at 1440×900 and 390×844; no horizontal overflow; language selector and controls remained usable |
| Independent lower-model acceptance review      | Passed after correction and re-audit; no remaining blocker/high finding                                |

Browser QA used the built listener preview with the backend intentionally offline. The expected
connection-error state appeared, no browser console warning/error was recorded, desktop and mobile
layouts remained intact, and switching between Spanish and Original produced the expected viewer
status. Gateway behavior was validated separately by the 18 integration tests.

## Explicitly deferred

- P6-UX0 and P6.1A onward, including any call UI, native two-person call, new AI route, English
  TTS/voice certification, personal voice, conferencing, SDK, or external adapter.
- Runtime adoption of the new call-session contract as an authority; this extraction milestone is
  intentionally additive.
- Zoom, KingsConference, SIP/RTP, media-bridge, or other platform capability claims.
- Commercial launch certification and external GitHub branch-protection settings.
- Independent Claude reconciliation and final approval by `masterzee001`.

No commit, push, merge, release, deployment, credential change, or external repository-setting
change was performed as part of this working-tree implementation wave.
