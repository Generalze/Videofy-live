# Videofy Multilingual Communications Platform

## Master Architecture & Execution Blueprint

**Engineering Markdown Edition - Architecture Version 3.0 - Authoritative Phase 6, Experience, Commercialization and Native-AI Baseline**

- **Platform:** Videofy
- **Repository owner:** masterzee001
- **Authoritative repository branch:** `main`
- **Current verified remote implementation reference:** `b4ac24e6ef8220847efd2795e0dbf94cce7d5ad6`
- **Phase 5 merge reference:** `a9bacc8ac11ad04a24eb2ab9018246d85fd47045` (PR #3)
- **Prepared:** 14 August 2026
- **Last architecture/source audit:** 14 August 2026
- **Architecture version:** 3.0
- **Supersedes:** Architecture Version 2.0
- **Primary audience:** product architecture, Codex/Claude engineering agents, frontend experience, engineering, AI/runtime, media, integrations, QA, security and operations

> **Core product thesis.** Videofy becomes the multilingual communications intelligence layer that lets people speak naturally in their own language while every other participant hears and reads them in the language they understand. Videofy Live remains a flagship application; the reusable language/media engine becomes independently integratable into external calling and conferencing systems.

> **Audit posture.** Verified repository truth, locked development/demonstration capabilities, commercial-readiness requirements and proposed Phase 6 architecture are deliberately separated. A feature being implemented or demonstrated does not make it commercially deployable. Native external-platform integration is only considered available when a supported media API or direct technical partnership has been confirmed.

> **Experience posture.** Videofy must look and feel like a premium global communications product, not a developer dashboard wearing a nicer font. Public, participant and listener surfaces are media-first, spacious, rich and visually confident. Internal provider names, model identifiers, worker health, transport details, licence flags, raw diagnostics and infrastructure state remain in protected operator/admin/developer surfaces unless a user genuinely needs the information to act.

> **Execution posture.** Codex Sol6 is the lead implementation supervisor. It decomposes each approved milestone into bounded agent work orders, assigns file/scope ownership, reviews every worker result, corrects or rejects non-compliant work, integrates the repository, and produces evidence before handoff. Claude is the independent second-line auditor/reconciler: it verifies architecture, regression safety, commercial-readiness and experience quality, then reconciles and polishes the integrated milestone without inventing a competing architecture.

## How Code Agents Must Use This Specification

This Markdown file is intended to be directly readable by Claude Code, Codex and other repository-aware engineering agents. It is an architecture and execution specification, not a request to implement the entire roadmap in one pass.

### Authority order

1. The user's latest explicit instruction.
2. This specification and its accepted architecture decisions.
3. Current verified repository behavior and tests.
4. Milestone-specific implementation documents and runbooks.
5. Historical documents.

If implementation reality conflicts with this specification, the agent must report the conflict and determine whether the repository is stale, the document is stale, or a migration step is missing. It must not silently invent a third architecture.

### Mandatory execution behavior

- Read the relevant section of this specification before planning a change.
- Implement only the milestone or defect explicitly requested. Do not opportunistically build later phases.
- Preserve the proven Videofy Live programme path unless the active milestone explicitly migrates it behind a shared contract.
- Never create a second transcription/translation/TTS pipeline merely because media arrived from a different application.
- Never bypass session, source-revision, language-revision, timestamp or stale-result controls for lower latency.
- Never feed synthesized/translated audio back into the raw speech-recognition input bus.
- Keep external-platform behavior inside adapters/gateways. Do not contaminate core AI providers with Zoom-, SIP-, KingsConference- or bridge-specific logic.
- Treat ingress and egress capabilities independently. Media-read access does not imply personalized media-write access.
- Do not claim an external integration is native, bidirectional or production-ready until the exact supported platform capability has been demonstrated.
- Do not expose a language as fully voice-ready until both approved standard Male and Female voices for that language are validated.
- Treat the current local AI stack as the locked **development/demonstration runtime**. Do not remove or weaken it merely to satisfy future commercial licensing.
- Commercial deployment must use a machine-enforced commercial runtime profile. No non-commercial or unknown-license asset may be reachable through a commercial primary or fallback chain.
- Provider/model/voice licensing status and production-readiness status are separate gates. A permissive licence does not automatically mean quality, security or production approval.
- Customer calls, meeting media and personal voice-enrollment recordings are **not training data by default**. Training use requires separate explicit rights/consent and provenance.
- Videofy-native models must enter through the same provider contracts, model registry, quality gates and commercial-readiness rules as third-party models.
- Personal voice cloning is optional. Failure must fall back to the participant's selected standard Male/Female voice without stopping captions or translation.
- Use focused tests while developing, then run the milestone's required regression gate before closure.
- Do not commit, push, merge or change external credentials unless explicitly instructed.
- Never place secrets, reusable voice embeddings, voice-reference recordings or private call media in logs, fixtures or commits.
- User-facing product surfaces must not expose internal model/provider/worker/transport terminology unless the user is in an authorized diagnostic or administrative context.
- Treat UI/UX quality as an acceptance gate, not final decoration. Native Call, Conference, Live and listener experiences must be visually coherent, premium, responsive and role-appropriate.
- Use progressive disclosure. The primary user task must dominate the screen; secondary settings belong in drawers, sheets, menus or contextual panels rather than permanent clutter.
- Codex Sol6 must supervise agent work rather than merely dispatching it. A worker result is not accepted until the lead reviews the diff, architecture impact and evidence, and either approves, corrects or reassigns it.
- Parallel agents must have non-overlapping ownership wherever practical. Do not let multiple workers edit the same contract or high-risk file concurrently.
- Claude audit happens after Codex has integrated and self-reviewed a coherent wave; Claude is not a substitute for Codex supervision.

### Required pre-change report for an implementation task

Before modifying code, the engineering agent should establish:

1. Current branch and clean/dirty Git status.
2. Existing implementation relevant to the requested milestone.
3. Which contracts/services will change.
4. Which existing Videofy Live behaviors could regress.
5. Focused tests that will prove the change.
6. Any unsupported external capability that must be validated before coding.

---

## Codex Sol6 Lead Orchestration and Agent-Team Protocol

Codex Sol6 is the **lead architect, implementation supervisor and integration owner** for Phase 6 execution. It may use an agent team aggressively, but agent parallelism is a means of controlled specialization, not an excuse to create nine interpretations of the same architecture.

### A. Supervisor responsibilities

Codex Sol6 must:

1. verify repository truth before creating work;
2. decompose the approved milestone into bounded work packages;
3. choose the minimum useful number of agents for the wave;
4. give every worker a written work order;
5. assign explicit file/package/service ownership;
6. prevent conflicting concurrent edits;
7. review every returned diff and test result;
8. compare work against the master architecture and relevant ADRs;
9. correct small defects directly or issue a correction work order;
10. reject work that weakens architecture, commercial policy, safety, privacy or experience quality;
11. integrate the wave itself;
12. run the required regression and acceptance gate;
13. reconcile documentation with actual implementation;
14. hand Claude one coherent integrated state rather than a pile of unreviewed agent branches.

Codex remains accountable for agent work. "The worker said it passed" is not evidence.

### B. Recommended agent sections

The exact fleet may change by milestone, but Codex should draw from the following specialist roles:

| Agent section | Primary ownership | Typical work |
| --- | --- | --- |
| Repository Truth & Governance | Git state, CI, ADR alignment, baseline evidence | Branch/HEAD audit, existing capability map, regression baseline, release/CI controls |
| Contracts & Architecture | Shared types, participant/session contracts, adapter boundaries | P6.0 extraction, revisions, compatibility layers, collision-safe event contracts |
| Realtime Media & Session | WebRTC, signaling, clocks, media routing, cleanup | Raw media isolation, participant tracks, reconnect, sequencing, TURN/SFU-facing work |
| AI Provider & Commercial Readiness | STT/translation/TTS provider interfaces and registries | Runtime profiles, provider switching, fail-closed licence gates, commercial adapters |
| Voice, Model & Language Lab | Standard voices, personal voice, datasets, model lineage | Male/Female catalogue, Voice Studio, training pipeline, Videofy-native model work |
| Frontend Experience & Design System | Public, participant, listener, operator and admin UI | Premium visual system, role-based information architecture, responsive interaction |
| QA & E2E Verification | Independent tests/evidence | Contract tests, browser E2E, reconnect, latency evidence, UI acceptance checks |
| Security, Privacy & Abuse | Consent, access, training rights, voice protection | Threat review, role boundaries, privacy controls, personal-voice governance |
| Documentation & Release Evidence | ADRs, runbooks, closure records | Keep documentation synchronized with actual code and verified status |

Codex does **not** need to instantiate every role on every wave. Small work should remain small.

### C. Mandatory work-order format

Every delegated work order must state:

- objective;
- why the change exists;
- allowed files/packages/services;
- files or behaviors that must not be touched;
- exact architecture/ADR constraints;
- interfaces or contracts to preserve;
- tests/evidence required;
- expected output;
- stop/escalate conditions;
- no-commit/no-push instruction unless the supervisor explicitly changes it.

### D. Parallelism rules

- Prefer parallel work only when file and architectural ownership are genuinely separable.
- High-risk shared contracts, session authority, revision semantics and media-clock changes have one primary owner at a time.
- Workers may inspect broadly but must edit narrowly.
- A later worker must not overwrite an earlier worker's accepted changes without explicit reconciliation.
- If two agents produce conflicting solutions, Codex decides from architecture and evidence. It must not merge both and hope TypeScript develops diplomacy.

### E. Supervisor correction loop

For each returned work package:

```text
worker result
    ↓
Codex diff review
    ↓
architecture / security / UX / commercial check
    ↓
focused tests
    ↓
ACCEPT
or
CORRECT DIRECTLY
or
RETURN WITH CORRECTION ORDER
or
REJECT
```

Codex must inspect the actual changed files. Summaries are secondary evidence.

### F. Wave integration gate

Before declaring a Codex wave ready for Claude:

- all accepted worker changes are integrated;
- working tree state is understood;
- no accidental unrelated files are staged;
- architecture invariants are checked;
- focused tests pass;
- required full regression gate passes;
- UI surfaces affected by the wave are visually reviewed;
- public/user surfaces contain no accidental engineering leakage;
- provider/runtime status is truthful;
- docs/ADRs are synchronized;
- remaining defects and deferred items are explicitly listed.

### G. Claude handoff and reconciliation

Claude serves as **independent auditor, reconciler, polish engineer and milestone closure reviewer** after Codex completes its supervised integration.

Claude must:

- audit the integrated repository, not workers' claims;
- verify the master architecture and ADRs literally;
- test regression and failure paths;
- inspect commercial-provider and fallback governance;
- inspect role/access and internal-information boundaries;
- visually review affected product surfaces;
- classify findings by severity;
- make or supervise minimal corrective changes where appropriate;
- reconcile stale documentation;
- polish consistency and maintainability;
- rerun acceptance evidence;
- return PASS, CONDITIONAL or FAIL.

Claude may correct implementation defects, but may not silently redefine locked architecture to make the milestone easier to close.

### H. Final authority

Milestone closure follows:

```text
Master Architecture
      ↓
Codex supervised agent implementation
      ↓
Codex integration + self-review
      ↓
Claude independent audit/reconciliation/polish
      ↓
final evidence
      ↓
project-owner milestone approval
```


## 0. Document Control and Decision Status

| Item | Decision / status |
| --- | --- |
| Platform identity | One Videofy platform with multiple products and separately deployable services; not one giant application and not unrelated codebases. |
| Repository strategy | Single monorepo initially so contracts, media semantics, session identity and tests evolve atomically. |
| Authoritative repository | `masterzee001/videofy-live`; default branch `main`. |
| Verified remote baseline | `main` at `b4ac24e6ef8220847efd2795e0dbf94cce7d5ad6` on 14 August 2026. Phase 5 was merged through PR #3 at `a9bacc8ac11ad04a24eb2ab9018246d85fd47045`. |
| Existing product | Videofy Live remains the programme-interpretation product and first consumer of the shared engine. |
| Current runtime classification | The present local AI/media infrastructure is **locked for development and demonstration**. It is not the commercial production baseline unless individual assets are separately certified. |
| New native products | Videofy Call for 1-to-1 multilingual calls; Videofy Conference for many-to-many multilingual meetings. |
| Integration product | Videofy Connect exposes SDKs, APIs, adapters and gateways for third-party systems. |
| Voice product | Videofy Voice provides approved Male and Female standard TTS for every fully voice-ready language, plus optional consent-based personal translated voice. |
| Native-AI strategy | Videofy will progressively develop its own voice, speech and translation assets, datasets and model library while retaining provider interchangeability. |
| Language authority | Manual locked language is highest authority; auto-detect assists and never silently overrides a lock. Current code defaults the detection confidence threshold to `0.82`. |
| Media authority | Each participant/programme has one authoritative session, source/media revision and media clock. |
| Feedback prevention | Generated/translated audio is playback-only and never enters STT. |
| Adapter principle | Adapters normalize external systems into Videofy contracts; AI/core logic remains platform-agnostic. |
| Commercial AI rule | Commercial runtime profiles fail closed when any selected primary, fallback, model or voice is non-commercial, unknown, unapproved or not production-certified. |
| Training-data rule | Customer communication data and personal voice enrollment are not general model-training data without separate explicit consent/rights. |
| Engineering execution | Codex Sol6 is lead supervisor/integrator; delegated agents work in bounded sections with explicit ownership and independent evidence. |
| Independent audit | Claude audits Codex-integrated waves, reconciles defects, polishes and verifies closure without redefining locked architecture. |
| Experience standard | Public/user UI is premium, grand, rich, media-first and uncluttered; internal engineering state is protected and progressively disclosed. |
| Internal-information rule | Provider/model IDs, worker health, raw logs, transport/ICE data, licence flags and infrastructure diagnostics do not appear prominently on public/participant/listener surfaces. |

### 0.1 Purpose

This document is the master execution blueprint for evolving Videofy from a one-to-many interpretation system into reusable multilingual communications infrastructure and, over time, a provider of its own language intelligence. Product, engineering, AI/ML, operations, security and integration teams should be able to execute from it without inventing new architecture during implementation.

### 0.2 Explicit non-goals

- Do not rewrite Videofy Live merely to make the architecture look cleaner.
- Do not replace the working development/demonstration AI stack simply because a future commercial stack will differ.
- Do not promise native support for a third-party calling platform before verifying a supported real-time media interface.
- Do not make personal voice cloning mandatory for joining a call.
- Do not relax stale-result, session, language or provenance controls to reduce latency.
- Do not create one AI pipeline per external platform.
- Do not treat a model as commercially deployable solely because its code or repository is open source.
- Do not train on customer calls, private meetings or personal voice samples by default.
- Do not attempt to train a giant Videofy foundation model from scratch before smaller specialized models, datasets and evaluation systems mature.
- Do not ship a functional-but-basic developer UI and call it finished product experience.
- Do not crowd primary user surfaces with diagnostics, provider health, raw confidence telemetry or configuration that belongs in admin/operator tools.
- Do not allow parallel agents to make conflicting edits to shared high-risk files without one owner and supervisor reconciliation.
- Do not treat agent delegation as supervisor approval; Codex must inspect and correct the integrated result.

### 0.3 Verified current repository truth - 14 August 2026

The following is the current remote `main` state verified directly from the repository and therefore supersedes older Phase 5 assumptions in previous architecture drafts:

| Area | Verified current state |
| --- | --- |
| Branch / commit | `main` -> `b4ac24e6ef8220847efd2795e0dbf94cce7d5ad6`. |
| Phase 5 | Merged to `main` through PR #3; repository README describes Phases 1-5 as complete. |
| Viewer catalogue | Nine viewer targets are exposed in the current product catalogue: Spanish, French, Portuguese, Arabic, Russian, Greek, Yoruba, Chinese and Latin. Catalogue exposure is not equivalent to commercial or full voice readiness. |
| Programme sources | Camera/screen/OBS, uploaded media, RTMP ingest and HLS playback are represented in the current repository. |
| STT | Real local `faster-whisper`; the validated runtime guide still uses `Systran/faster-whisper-small.en`, so the proven ASR baseline is English-centric. Spanish-input call readiness therefore requires an explicit multilingual-ASR/provider step. |
| Translation | OPUS-MT primary models plus M2M100/NLLB-200 fallback capability and persistent Python workers. Current repository documentation records English-to-multiple-target delivery; NLLB is used where OPUS-MT coverage/quality is insufficient. |
| TTS | Multi-voice Piper plus MMS-TTS fallback. Current voice registry is not yet gender-aware and does not meet the locked Male/Female pair requirement for fully voice-ready languages. |
| VAD | The WebRTC gateway currently uses an energy-based fallback gate. If `silero` is requested, the code warns and honestly falls back because Silero is not yet implemented in that gateway path. |
| Language control | Manual mode/lock authority, auto-detect, confirm/reject/override/lock/unlock/detect-again semantics and the `0.82` default confidence threshold are implemented. |
| Revision safety | `TimestampedTranslationEventSchema` on current `main` contains optional `sourceLanguageRevision`; the previously reported schema-stripping defect is already fixed and must not be re-fixed. |
| Production infrastructure | README still states no production deployment, authentication/authorization, database, billing or cloud AI integration. TURN/separate-network proof is not yet a production baseline. |
| Branch governance | Current remote `main` is not branch-protected and showed no combined status checks at the verified commit; Phase 6 governance must add CI/branch policy before commercial release. |

### 0.4 Locked development/demonstration runtime

The existing local runtime remains available as a stable R&D and demonstration environment. Its job is to prove media, translation, synchronization, UX and integration behavior cheaply and locally. Non-commercial assets may remain in this profile when clearly classified and never reached by a commercial runtime.

```text
AI_RUNTIME_PROFILE=development-demo

Possible assets:
  faster-whisper
  OPUS-MT
  M2M100
  NLLB-200          # non-commercial; development/demo only
  Piper voices      # per-voice rights still tracked
  MMS-TTS           # non-commercial; development/demo only
```

The development profile is not deprecated by commercialization. It remains useful for testing, offline demonstrations, model comparison, regression and Videofy-native model research.

### 0.5 Known Phase 6 call prerequisites exposed by the repository audit

The architecture is valid, but the current repository does not yet satisfy the native English<->Spanish call exit condition. Before P6.1 can close:

1. Spanish speech input must be supported by a validated multilingual STT path or provider; the proven `small.en` ASR baseline is insufficient for Spanish speech.
2. Spanish-to-English translation must be an explicit supported route and English must exist as a recipient target.
3. English standard TTS must exist.
4. English must have an approved Male and Female standard voice for full voice-ready status.
5. Spanish must have an approved Male and Female standard voice for full voice-ready status.
6. The proposed Phase 6 translation event contract must use a collision-safe name because the repository already contains a legacy `TranslationEvent` concept with incompatible semantics.

Development may proceed incrementally, but the P6.1 milestone is not closed until these prerequisites and the duplex call behavior are both proven.

### 0.6 Commercialization policy

Commercialization is an architectural capability, not a future rewrite. Videofy must be able to switch from the development profile to approved local, cloud or Videofy-native providers through configuration and registry policy while preserving the same session/media contracts.

```text
Development/Demo Runtime  ---> same provider contracts ---> Commercial Local
                              same provider contracts ---> Commercial Cloud
                              same provider contracts ---> Videofy Native
```

No commercial profile may silently fall back into a development-only asset.
## 1. Contents

- 2. Executive Summary

- 3. What Videofy Is Becoming

- 4. Why This Architecture

- 5. Product Structure

- 5.1 Experience and Interface Architecture

- 6. Architectural Principles

- 7. Core Realtime Language Engine

- 8. Participant and Session Model

- 9. Native Videofy Call

- 10. Videofy Conference

- 11. Language Selection and Auto-Detect

- 12. Captions and Transcript Experience

- 13. Audio Modes and Personalized Mixing

- 14. Videofy Voice

- 15. Videofy Connect

- 16. Integration Modes and Adapters

- 17. Zoom Strategy

- 18. KingsConference Strategy

- 19. SIP/RTP Enterprise Telephony

- 20. Closed Consumer Platforms and Media Bridge

- 21. AI Provider, Commercialization and Videofy-Native Intelligence Architecture

- 22. Latency and Streaming Strategy

- 23. Security, Consent and Privacy

- 24. Data Contracts and API Surface

- 25. Deployment Topology

- 26. Observability and Operations

- 27. Failure Handling

- 28. Migration from Current Videofy Live and Repository Baseline

- 29. Phase 6 and Commercialization Roadmap

- 30. Acceptance Criteria

- 31. Test Strategy

- 32. Execution Playbook

- 32.8 Codex Agent-Team Execution and Claude Reconciliation

- 33. Risk Register

- 34. Architecture Decision Record

- 35. Audit Checklist

- 36. References

- 37. Glossary

## 2. Executive Summary

### 2.1 What

Videofy will become a multilingual communications platform that can operate both as a complete application and as an embeddable communications intelligence layer. In native Videofy calls, a participant selects the language they speak and the language they prefer to hear. Videofy transcribes that participant's raw speech, translates it for intended recipients, generates synchronized recipient-language audio, and presents translated captions. In integrated environments, the same functions are exposed through adapters connected to third-party conferencing, WebRTC, SIP/RTP or local-network systems.

### 2.2 Why

Videofy Live already proves the underlying primitives: live and uploaded programme sources, WebRTC media delivery, transcription, translation, TTS, listener mixing, language controls, source revisions and unified timeline ownership. Reusing those primitives for person-to-person and many-to-many calls creates a larger product while avoiding duplicated engineering.

The major architectural danger is duplication. If Zoom, KingsConference, SIP, native Videofy Call and every future integration each receive a separate translation path, the platform will acquire multiple clocks, inconsistent session identity, conflicting language rules and independent failure modes. The architecture therefore normalizes every participant into one internal media/session model.

### 2.3 How

Execution begins by extracting reusable participant, call-session, language-routing and adapter contracts from the existing platform without changing Videofy Live behavior. A native two-person Videofy Call becomes the first new consumer. Videofy Connect then exposes the same engine to external systems. Videofy Voice is added as an optional identity layer behind the same voice-provider contract. In parallel, the provider layer gains machine-enforced development and commercial runtime profiles so future commercialization is a provider-certification/configuration change rather than a media-architecture rewrite. Videofy also begins a long-term native-AI programme for owned voice, speech and translation assets.

> **Execution rule.** Build the universal core once. Make Videofy Live and Videofy Call consume it. Make external platforms integrate through adapters. Never build a second AI translation pipeline simply because the media came from a different application.

## 3. What Videofy Is Becoming

The platform promise is: each person speaks naturally in their own language; every recipient hears and reads that speaker in the recipient's chosen language. The source person's language and identity are preserved as metadata, while the output is personalized per recipient.

### 3.1 Two-person call

```text
Participant A: speaks English; prefers English
Participant B: speaks Spanish; prefers Spanish

A speaks English
  -> VAD / STT
  -> canonical English transcript
  -> EN->ES translation
  -> Spanish caption
  -> Spanish TTS using A's selected voice mode
  -> B hears Spanish

B speaks Spanish
  -> VAD / STT
  -> canonical Spanish transcript
  -> ES->EN translation
  -> English caption
  -> English TTS using B's selected voice mode
  -> A hears English
```

### 3.2 Conference

In a conference, each utterance is transcribed once. The translation router derives the set of distinct target languages required by active recipients, translates only into those languages, and routes the outputs to each recipient according to language, caption, voice and audio-mix preferences. This avoids retranslating the same sentence independently for every listener.

### 3.3 Strategic product promise

> **Product proposition.** Speak your language. Hear everyone in yours. Read synchronized captions. Optionally preserve each speaker's own vocal identity across languages.

## 4. Why This Architecture

### 4.1 One clock prevents interpretation drift

The recent uploaded-video work demonstrated the cost of separate programme and processing paths: media can start on one timeline while transcription and generated audio begin on another. Videofy fixed that by unifying programme, processing and listener delivery under one session. Phase 6 must extend the same lesson to participants: one participant, one authoritative media timeline, one revision chain.

### 4.2 Platform-specific AI is a trap

A media adapter may be specific to Zoom or SIP, but speech recognition, translation, captions, TTS and personal voice rules must not be. The core should only know that Participant X is speaking language A and Participant Y wants language B. This enables one testable language engine and makes new integrations much cheaper.

### 4.3 Preserve the proven product

Videofy Live remains operational throughout Phase 6. The extraction is incremental and compatibility-driven. Shared contracts are introduced before runtime authority moves. Existing programme paths are wrapped as consumers of the new contracts, not rewritten as a prerequisite for new call features.

## 5. Platform Product Structure

```text
VIDEOFY PLATFORM
|
+-- Videofy Live
|   +-- Live programme interpretation
|   +-- Uploaded/pre-recorded programme interpretation
|   +-- One broadcaster -> many listeners
|
+-- Videofy Call
|   +-- 1-to-1 multilingual calls
|   +-- Captions + translated audio
|
+-- Videofy Conference
|   +-- Many-to-many multilingual meetings
|   +-- Personalized recipient routing
|
+-- Videofy Voice
|   +-- Standard voices: approved Male + Female option for every voice-ready language
|   +-- Optional personal translated voice
|
+-- Videofy Connect
    +-- Web/mobile SDKs
    +-- WebRTC adapter
    +-- Zoom adapter
    +-- KingsConference adapter
    +-- SIP/RTP gateway
    +-- Desktop Media Bridge
```

| Product | Primary use | Core dependency |
| --- | --- | --- |
| Videofy Live | One programme translated for multilingual audiences. | Realtime Language Engine |
| Videofy Call | Two callers speak/hear different languages. | Call Session + Language Engine |
| Videofy Conference | Many participants receive personalized translated media. | Recipient Router + Call Session |
| Videofy Voice | Male/Female standard translated voices per voice-ready language, or consent-based personal translated voice. | Voice Service |
| Videofy Connect | SDK/API/adapter integration into external systems. | Connect Gateway + Adapters |


### 5.1 Experience and Interface Architecture

Videofy must present itself as a **premium communications platform**, not a collection of engineering controls. Visual quality is part of product correctness because users must understand language, media and voice state immediately without learning the underlying infrastructure.

#### 5.1.1 Visual ambition

The experience should feel:

- grand and globally credible;
- rich rather than flat or skeletal;
- cinematic and media-led where video is present;
- spacious, deliberate and confident;
- modern without looking like a generic template;
- polished enough for partner/client demonstrations and eventual commercial launch;
- human-centered rather than infrastructure-centered.

"Grand" does not mean filling every corner. It means strong hierarchy, proportion, depth, typography, motion, imagery/media and intentional whitespace.

The product must avoid:

- default-looking component-library pages;
- empty white cards scattered across a dashboard;
- dense walls of controls;
- excessive gradients, glowing gimmicks or dashboard chrome;
- permanent engineering badges on normal user surfaces;
- raw JSON-like labels;
- model/provider names used as user-facing feature names;
- exposing test/debug controls in production-facing navigation.

#### 5.1.2 Role-separated surface architecture

Videofy has distinct experience surfaces:

```text
PUBLIC / VISITOR
brand, value, product discovery, join/start entry

PARTICIPANT
call/conference media, language, captions, voice, essential call controls

LISTENER / VIEWER
programme media, language selection, captions, interpretation mix

OPERATOR
programme source, session control, language readiness, operational state

ADMIN
accounts, policy, commercial runtime, voice/model catalogue, permissions

DEVELOPER / DIAGNOSTICS
provider health, model IDs, timings, WebRTC/ICE, logs, raw capability state
```

A capability existing internally does not grant it a place on every screen.

#### 5.1.3 Progressive disclosure

Primary tasks must dominate. Secondary complexity appears only when needed.

Examples:

- Call participants see video, people, captions, language and essential media controls first.
- Voice selection belongs in pre-join/profile/settings, not as a permanent large dashboard module.
- Auto-detect confidence can appear contextually when confirmation is needed, rather than occupying the screen continuously.
- Provider latency, exact model, fallback chain, GPU state and licence classification belong in protected diagnostics/admin panels.
- Operator warnings surface as actionable plain-language states; raw engineering data is one level deeper.
- Advanced audio-mix controls may expand from a compact control rather than occupying permanent screen real estate.

#### 5.1.4 Information classification for UI

Every datum exposed by backend services must be classified before presentation:

| Classification | Examples | Normal presentation |
| --- | --- | --- |
| User-critical | Call state, microphone/camera, selected language, captions, mute, connection loss | Prominent and immediately understandable |
| User-useful | Translation mode, standard voice choice, caption preference, original/translated mix | Contextual settings or compact controls |
| Operator-critical | Source readiness, programme start/stop, language availability, recoverable session fault | Operator console with clear action |
| Administrative | Runtime profile, provider approval, voice catalogue, account policy | Authenticated admin area |
| Engineering diagnostic | Model ID, provider latency, worker PID, PCM metrics, ICE candidates, revision counters | Developer/diagnostic view only |
| Sensitive/internal | Secrets, raw logs containing private content, embeddings, reference recordings | Never normal UI; protected internal handling only |

#### 5.1.5 Public and visitor experience

The public surface should communicate Videofy's promise before its machinery.

Priority order:

1. strong product identity;
2. clear multilingual communication proposition;
3. high-quality live/video visual treatment;
4. product paths: Live, Call, Conference and Integrate;
5. proof/use cases;
6. simple join/start/sign-in action.

The public experience should not show:

- current model registry;
- internal development runtime;
- provider names;
- translation-worker state;
- API debug data;
- infrastructure topology;
- experimental-language warnings unless directly relevant to a user action.

#### 5.1.6 Native Call experience

The call surface is stage-first.

Recommended hierarchy:

```text
call stage / people
        ↓
live translated captions
        ↓
compact call controls
        ↓
language / interpretation state
        ↓
contextual settings drawers
```

Design requirements:

- local and remote video remain visually dominant;
- translated caption is primary, original caption optionally expandable;
- current speaker identity is obvious;
- selected language is visible but not visually loud;
- translation delay/recovery appears only when actionable;
- audio mode uses clear human language;
- Male/Female standard voice choice is set before call or in contextual settings;
- personal voice state is visible enough for consent/trust but not intrusive;
- mobile layouts preserve media/caption priority;
- connection problems produce calm, actionable recovery UI rather than raw transport errors.

#### 5.1.7 Conference experience

Conference UI must scale without becoming a wall of language widgets.

- participant tiles remain primary;
- speaker-focused layouts can enlarge the active speaker;
- captions remain speaker-attributed;
- each participant's own language preference is managed locally;
- the participant does not configure a translation matrix;
- roster language indicators are compact;
- interpretation controls are per-recipient;
- host/operator controls are role-gated;
- advanced routing information is never shown to ordinary participants.

#### 5.1.8 Videofy Live operator experience

The operator surface may be information-rich, but it must still be intentionally designed.

Use structured zones such as:

- programme preview/stage;
- source controls;
- interpretation/language status;
- listener/delivery health;
- session actions;
- expandable diagnostics.

Operator UI should convert engineering truth into operational language. For example:

```text
"Spanish voice unavailable - captions will continue"
```

is preferable on the main operator surface to:

```text
MMS/Piper Composite Provider UnsupportedTtsLanguage
```

The raw provider error may exist in diagnostics.

#### 5.1.9 Listener/viewer experience

The viewer should feel like watching a premium programme, not operating a translation workstation.

Primary elements:

- programme video;
- translated/original captions;
- language selector;
- interpretation/original audio mode;
- volume/mute;
- essential playback/recovery state.

Everything else is secondary.

#### 5.1.10 Admin and developer surfaces

Admin and diagnostics are separate from public/participant/listener navigation and require appropriate authorization.

Admin may contain:

- commercial runtime profile;
- provider/model/voice registry;
- production approval;
- language readiness;
- standard voice Male/Female coverage;
- Voice Studio publication state;
- policy controls;
- account/organization configuration.

Developer diagnostics may contain:

- raw provider health;
- latency traces;
- model IDs/revisions;
- session/media/language revisions;
- WebRTC/ICE diagnostics;
- worker state;
- structured error payloads.

These surfaces should be powerful, but their existence must not contaminate consumer UX.

#### 5.1.11 Design system

Create a reusable Videofy design system rather than styling each application independently.

It should define:

- typography scale;
- spacing and layout grid;
- elevation/depth;
- surface hierarchy;
- border/radius system;
- iconography;
- motion durations and easing;
- media framing;
- caption styles;
- status semantics;
- light/dark/brand theme tokens where required;
- responsive breakpoints;
- focus/keyboard treatment;
- accessible contrast rules;
- skeleton/loading/recovery patterns.

The visual direction should favor sophisticated depth, strong typography, elegant motion and restrained premium accents. Do not lock the product into novelty effects that reduce readability or video quality.

#### 5.1.12 Motion and interaction

Motion is functional:

- stage transitions;
- participant entry/exit;
- drawers/sheets;
- language confirmation;
- caption arrival;
- call-state transitions;
- source switching.

Avoid decorative motion that competes with speech, captions or video.

Respect reduced-motion preferences.

#### 5.1.13 Accessibility

Premium appearance does not excuse inaccessible interaction.

At minimum:

- keyboard navigation;
- visible focus;
- accessible control names;
- screen-reader state for mute/camera/language/call changes;
- contrast-compliant text and controls;
- caption readability;
- scalable typography;
- non-color-only status communication;
- reduced-motion support.

#### 5.1.14 Experience acceptance gate

A user-facing milestone cannot close merely because the backend works.

For affected surfaces, acceptance must verify:

- product hierarchy is obvious within seconds;
- no developer/debug controls leak into normal user paths;
- the primary task dominates the viewport;
- controls are not overcrowded;
- desktop and mobile layouts are deliberate;
- captions remain readable over varied video;
- empty/loading/error states are designed;
- wording is user-facing rather than provider-facing;
- role-gated internal surfaces remain inaccessible from ordinary user flows;
- visual review is performed using real browser screenshots, not component assumptions.


## 6. Non-Negotiable Architectural Principles

| Principle | Required behavior |
| --- | --- |
| One authoritative session | Every programme or participant source belongs to exactly one authoritative session and revision. |
| One media clock | Video, original audio, transcript, translation, captions and generated audio share one timebase. |
| Raw speech only enters STT | Translated/generated audio never feeds back into transcription. |
| Manual language wins | Manual locked language cannot be silently overridden by auto-detect. |
| Adapters normalize; core interprets | Platform-specific media logic stops at the adapter boundary. |
| Recipient personalization | What a participant hears/sees is determined by that recipient's preferences. |
| Graceful degradation | Personal voice -> standard TTS -> translated text -> original media fallback chain. |
| Truthful readiness | Unavailable models, voices, APIs or media egress are shown as unavailable. |
| Revision safety | Source/language changes reject stale derived events. |
| Consent by design | Personal voice enrollment is explicit, revocable and separately protected. |
| Experience is architecture | Premium, role-appropriate UI and progressive disclosure are acceptance requirements, not post-build decoration. |
| Internal state stays internal | Diagnostics, provider/model metadata and infrastructure details are protected and do not dominate user-facing surfaces. |
| Supervised agent execution | Codex owns delegated agent output, reviews and corrects it before integration; Claude independently audits the integrated wave. |

## 7. Core Realtime Language Engine

```text
Native/external media
        |
        v
Participant Media Adapter
        |
        v
Session / Participant Registry
        |
        v
Raw Audio Bus --------------------> Original Audio Router
        |
        v
VAD / Segmentation
        |
        v
Speech-to-Text
        |
        v
Canonical Transcript
        |
        +--------------------------> Original caption
        |
        v
Translation Router
        |
        +-- ES -> Translation -> Caption -> Voice Router -> TTS/Clone
        +-- FR -> Translation -> Caption -> Voice Router -> TTS/Clone
        +-- PT -> Translation -> Caption -> Voice Router -> TTS/Clone
                                               |
                                               v
                                      Recipient Audio Router
```

### 7.1 Core services

| Service | Owns | Must not own |
| --- | --- | --- |
| Session Core | Session identity, participants, revisions, lifecycle, capabilities. | Platform-specific capture. |
| Media Router | Raw track ownership, normalized media, timestamps, recipient fan-out. | Translation model logic. |
| Speech Service | VAD, segmentation, STT, language evidence. | Recipient mixing. |
| Translation Router | Target-language deduplication, ordering, retry, stale rejection. | Platform signaling. |
| Voice Service | Standard Male/Female voice catalogue, Piper, personal voice provider, normalization and fallback. | Call signaling. |
| Caption Service | Original/translated caption events, speaker attribution. | Raw media capture. |
| Recipient Router | Per-recipient language/audio/caption output policy. | Model installation. |
| Connect Gateway | SDK/API/adapters, capability negotiation, ingress/egress. | Translation semantics. |

### 7.2 Provenance

Every derived event carries sessionId, participantId, source/media revision, language revision, sequence number, media timestamps, provider identity and generated-at time. Consumers reject old revisions and duplicate/out-of-order events. This is the protection against sending the right translation to the wrong moment or participant.

## 8. Participant and Session Model

### 8.1 Participant

```text
Participant {
  participantId
  sessionId
  displayName
  role
  sourceLanguage
  sourceLanguageMode
  preferredLanguage
  captionLanguage
  audioMode
  voiceMode
  voiceProfileId?
  connectionCapabilities
  mediaRevision
  languageRevision
}
```

External identifiers remain adapter metadata. A Zoom participant ID, SIP URI or KingsConference participant identifier is mapped to a Videofy participantId and never becomes the universal identity used by the language engine.

### 8.2 Call session

```text
CallSession {
  sessionId
  mode: call | conference | programme
  lifecycleState
  participants[]
  mediaPolicy
  captionPolicy
  voicePolicy
  integrationContext
  revision
}
```

### 8.3 Revisions

Replacing a microphone/camera, reconnecting, selecting a new programme, changing confirmed source language or swapping adapters increments the appropriate media/language revision. Old AI results are rejected rather than merged into the new state.

## 9. Native Videofy Call

### 9.1 Purpose

Videofy Call is the native reference product and the proving ground for the common engine. It should be built before deep external integrations so failures can be attributed to Videofy rather than a third-party API.

### 9.2 Entry flow

1. Open/create call.

2. Select the language you speak; default can be remembered from profile.

3. Choose preferred hearing language; usually defaults to spoken language.

4. Choose audio mode: translated, interpretation or original.

5. Enable/disable captions and choose caption language.

6. Optionally select or enroll a Videofy Voice profile.

7. Run permission/health preview.

8. Join; preferences are attached before raw media enters processing.

### 9.3 Bidirectional processing

Each raw microphone track is independently segmented and transcribed. Translation is generated only when the recipient requires another language. A participant's synthesized translation is routed only to other recipients; it never replaces the participant's raw source inside the speech pipeline.

### 9.4 UX rules

Native Call must follow the experience architecture in §5.1. It is a communication stage first and a configuration surface second.


- Make speaker identity visible on captions.

- Allow View Original for verification.

- Expose translation status and delay without turning the call into a developer console.

- Keep mute and volume recipient-specific.

- Never force voice enrollment before joining.

- Provide obvious fallback when personal voice is unavailable.

## 10. Videofy Conference

### 10.1 Many-to-many routing

The conference engine groups active recipients by required target language. A canonical utterance is translated once per unique target language, not once per listener. Standard-language TTS may be reused across recipients only when target language and selected standard voice option (Male/Female/voice ID) match; personal voice remains speaker-specific.

### 10.2 Example

| Speaker | Source | Audience preferences | Derived outputs |
| --- | --- | --- | --- |
| Zoe | English | Carlos=Spanish; Amélie=French; João=Portuguese | EN transcript; ES/FR/PT translations; Zoe/standard TTS per target. |
| Carlos | Spanish | Zoe=English; Amélie=French; João=Portuguese | ES transcript; EN/FR/PT translations; Carlos/standard TTS per target. |

### 10.3 Overlap policy

The first conference implementation should not synthesize several translated voices on top of each other. Preserve independent raw streams and captions, identify the dominant/current speaker, and serialize or duck translated audio according to a deterministic policy. More advanced spatial or simultaneous interpretation can be a later milestone.

## 11. Language Selection and Auto-Detection

### 11.1 Authority order

```text
1. Manual locked language
2. User/operator confirmed auto-detection
3. Auto-detect suggestion
4. Unknown / awaiting evidence
```

A participant usually selects the language they speak. Auto-detect assists, particularly for casual onboarding, but must not silently change a locked language because of a greeting, name or brief code-switch.

### 11.2 Required auto-detect behavior

- Display detected language and confidence.

- Require confirmation below configurable confidence.

- Debounce/hysteresis prevents rapid switching.

- Never override manual lock.

- Confirmed language change creates a new language revision.

- Reject events from previous language revision.

- Provide unlock-and-detect-again.

### 11.3 Preferred language

For simplicity, preferred hearing language should initially default to the spoken language. Advanced users can independently select caption language or choose original-only audio.

## 12. Captions and Transcript Experience

Captions are a first-class product output and a safety fallback when translated audio is delayed or unavailable. They also let users verify names, numbers and specialist terms.

```text
CaptionEvent {
  sessionId
  speakerParticipantId
  sourceRevision
  languageRevision
  sequence
  sourceLanguage
  targetLanguage
  originalText
  translatedText
  startTimestamp
  endTimestamp
  confidence
  isFinal
}
```

- Primary caption uses recipient preferred language.

- Speaker identity is always attached.

- View Original exposes source transcript.

- Partials are replaced by finals using sequence/revision semantics.

- Captions remain available even if TTS fails.

- Late captions that belong to stale media/language revisions are rejected.

## 13. Audio Modes and Personalized Mixing

| Mode | Original audio | Translated audio | Use |
| --- | --- | --- | --- |
| Translated / Replacement | Suppressed while translation plays. | Primary. | Maximum language accessibility. |
| Interpretation | Low/ducked. | Dominant. | Preserve original speaker presence. |
| Original | Primary. | Off or optional. | Bilingual users / verification. |

Mix settings are per recipient. Changing one listener's translated volume must not change the broadcaster track or another participant's mix. Existing Videofy Live interpretation/replacement semantics should be generalized into recipient output policy.

> **Critical feedback rule.** Generated translated audio, including cloned voice, is an egress-only signal. It must never be connected to the raw STT input bus. Echo cancellation is helpful but does not replace strict bus separation.

## 14. Videofy Voice: Optional Personal Translated Voice

### 14.1 What

Videofy Voice lets a participant optionally preserve their vocal identity in translated speech. A Spanish recipient could hear an English speaker translated into Spanish using a voice profile representing that same speaker, rather than a generic TTS voice.

### 14.2 Enrollment experience

1. Select My Voice during pre-call setup or profile settings.

2. Read a short prompted phrase set in a quiet environment.

3. Explicitly consent to creation and use of a synthesized voice profile.

4. Create/store a reference profile or speaker representation, not a whole bespoke model per user.

5. Preview the result.

6. Accept, re-record, disable or delete.

7. Join call even if enrollment is skipped or fails.

### 14.3 Standard voice catalogue

Every language that Videofy labels as voice-ready must provide at least two approved standard synthesized voice options: one Male voice and one Female voice. The participant may choose either voice independently of their own gender. The selection is a playback preference, not an inference about the participant.

The call-entry and profile UI should present a simple Standard Voice selector for the participant's preferred language: Male or Female. Where several approved voices exist in either category, Videofy may later expose additional voice styles, but the minimum product requirement remains one approved Male and one approved Female standard voice per voice-ready language.

A language must not be marked fully voice-ready if only one standard voice option is available. It must be marked partial/experimental or text-only until both required standard voice options are installed, licensed, quality-reviewed and validated on the target runtime.

Personal Videofy Voice remains optional. If a personal voice profile is unavailable, disabled or fails during synthesis, the participant falls back to the standard Male or Female voice they selected for that language.

### 14.3.1 Standard voice readiness contract

A standard voice is not merely a model file. It is a registered product capability.

```typescript
type StandardVoiceProfile = {
  voiceId: string
  providerId: string
  language: string
  locale?: string
  gender: "male" | "female"
  modelRevision: string
  licenseId: string
  licenseEvidence: string
  commercialUseState: "approved" | "blocked-noncommercial" | "review-required" | "internal-only"
  # Equivalent boolean readiness check: commercialUseApproved = (commercialUseState == "approved")
  rightsVerified: boolean
  qualityStatus: "unverified" | "experimental" | "approved"
  runtimeStatus: "unavailable" | "installed" | "validated"
  productionApproved: boolean
  fallbackPriority: number
}
```

A language is **fully voice-ready for a given runtime profile** only when:

1. At least one approved Male standard voice exists.
2. At least one approved Female standard voice exists.
3. Both voices are permitted for the active runtime profile and their rights evidence is recorded.
4. A commercial runtime additionally requires `commercialUseState=approved` and `productionApproved=true` for both voices.
5. Both voices pass runtime generation and audio-normalization tests.
6. Both voices pass human intelligibility/quality review appropriate to the milestone.
7. Both voices have deterministic fallback identifiers in the registry.

A language may be transcript/translation-ready while still being voice-partial. The UI and capability API must report those states separately. The development/demo profile may use development voices that are not commercial, but it must never present them as commercially approved.
### 14.4 Provider architecture

The **standard voice fallback contract** remains permanent; Piper is the current development/demonstration implementation, not a permanent vendor lock. The standard-voice registry must maintain at least one approved Male and one approved Female voice for every language that Videofy exposes as fully voice-ready. Personal voice is implemented behind `VoiceProvider`/`VoiceProfileProvider`. OpenVoice V2 is a strong prototype candidate because its official project describes zero-shot cross-lingual voice cloning, native English/Spanish/French/Chinese/Japanese/Korean support and MIT commercial/research licensing [R4, R5]. Videofy-native voice models will later enter through the same interfaces. Production approval still requires dependency, model-weight, data-rights, quality, latency and security review.

### 14.5 Consent and abuse controls

- Opt-in only.

- Live enrollment challenge or equivalent policy; arbitrary third-party recordings are not the default path.

- Separate encrypted storage for voice profiles/reference material.

- Disable and delete controls.

- Audit enrollment, disable and deletion.

- No ordinary API access to reusable voice embeddings.

- Visible indicator when personal synthesized voice is active.

- Automatic fallback to the participant's selected standard Male or Female voice for the active language.

## 15. Videofy Connect: External Integration Architecture

### 15.1 What

Videofy Connect is the SDK/API/adapter product that lets external communication systems consume Videofy's multilingual engine while Videofy remains the core platform.

### 15.2 Why

External systems differ at signaling/media boundaries, not in the linguistic problem. Videofy Connect contains those differences and publishes normalized participant media/capability contracts to the core.

### 15.3 Flow

```text
External platform
      |
      v
Platform Adapter
  - identity mapping
  - capability discovery
  - signaling translation
  - media normalization
  - timestamp normalization
      |
      v
Videofy ParticipantMedia / CallSession
      |
      v
Realtime Language Engine
      |
      v
Recipient outputs
      |
      v
Media Egress Adapter
      |
      v
External platform / client
```

### 15.4 Ingress and egress are independent

A platform may let Videofy read live participant audio but not inject a unique synthesized audio stream back to each participant. Every adapter therefore reports ingress and egress capabilities separately. This prevents a false claim of full integration when only transcription/media capture is supported.

## 16. Integration Modes and Adapter Strategy

| Mode | Best for | Strength | Constraint |
| --- | --- | --- | --- |
| Native SDK | Partner/customer-controlled apps | Deepest identity/media integration. | Requires engineering cooperation. |
| Official platform adapter | Platforms with supported real-time media APIs | Stable supported path. | Read/write capabilities vary. |
| WebRTC adapter | Browser/native WebRTC products | Natural participant track mapping. | Requires media ownership/hooks. |
| SIP/RTP gateway | PBX/call center/enterprise telephony | Works beyond browsers. | Codec/interoperability/compliance complexity. |
| Media Bridge | Closed desktop/consumer apps | Fallback using virtual devices/capture. | Less identity/context; local software. |

### 16.1 Capability declaration

At session start an adapter declares whether it provides participant-separated audio, merged audio, video, screen share, participant IDs, timestamps, transcript events, inbound synthesized audio injection, per-recipient egress, mute control, codec information and reconnect hooks. The engine only enables workflows supported by that capability set.

## 17. Zoom Integration Strategy

### 17.1 Verified current platform capability

Zoom's official Realtime Media Streams (RTMS) documentation states that RTMS can provide live audio, video, screen-share and transcript data for Zoom Meetings, Contact Center and Zoom Video SDK applications [R1]. For meetings, participant-separated or merged audio is available; the documented default audio is uncompressed L16 PCM at 16 kHz mono with participant identity and timestamps [R2]. RTMS requires the appropriate app scopes and Zoom developer credits/setup [R3].

### 17.2 Videofy adapter plan

- Use RTMS as a high-quality ingress path where account/app capabilities permit.

- Map Zoom participant identity/timestamps to Videofy ParticipantMedia.

- Normalize RTMS PCM directly into the same 16 kHz media contract used by the core.

- Treat Zoom transcript as optional supplemental evidence, not a replacement for Videofy provider consistency unless explicitly chosen.

- Validate egress separately; do not assume RTMS ingestion automatically provides personalized synthesized-audio return.

- Keep OBS/VB-CABLE as a demo/fallback Media Bridge, not the long-term enterprise integration.

### 17.3 P6.7 audit outcome (2026-08-19)

The official-surface audit is complete; findings, the egress evidence table and
the open questions live in `docs/adapters/zoom-integration.md`.

**Ingress is confirmed and built.** RTMS delivers per-participant audio for
ordinary Meetings (`data_opt: AUDIO_MULTI_STREAMS`) as raw L16 16 kHz mono in
20 ms packets with `user_id`, `user_name` and per-user timestamps — the engine's
existing format, so no transcode. `services/zoom-adapter` implements that
ingress and nothing else. Two constraints carried into the design: the DEFAULT
mixed stream is anonymous (`user_id: 0`) and is refused, and multi-stream is
documented as supporting up to 3 speakers per 20 ms.

**Egress is unresolved and no path was invented.** RTMS is delivery-to-
application; nothing in it returns audio to a meeting. The ranked candidate is
Zoom's native interpretation channel driven by a Meeting SDK participant, whose
two halves are separately documented while the join between them is not — that
single unknown decides the architecture and must be settled with Zoom before
commitment. Captions have an official third-party path that carries no language
parameter, making a Zoom App panel the only per-user multilingual route.

P6.7 therefore stands as: ingress complete, egress blocked on Zoom answers and
Developer Pack credentials. The exit condition in §29 is unchanged and unmet.

## 18. KingsConference Strategy

> **Corrected 2026-08-19, superseding the same day's first-party ratification.**
> KingsConference (kingsconference.app) is a REAL, INDEPENDENT third-party
> conferencing product. It already owns rooms, video, scheduling, screen
> sharing, chat, moderation, authentication, meeting links and its own UI, at
> advertised scale [R15][R16]. Videofy does not build, rebuild or replace any
> of that.
>
> P6.6 is therefore an ADAPTER: KingsConference keeps the meeting; Videofy adds
> the LANGUAGE LAYER. Speaker audio plus participant identity leave their
> conference, cross a KingsConference-to-Videofy adapter into Videofy Connect,
> run the existing translation engine, and translated audio plus captions
> return to the listeners who asked for them.
>
> The briefly-ratified reading — that KingsConference was a first-party Videofy
> product to be built on Connect — was wrong and is withdrawn. The artifact
> produced under it is real and is retained as the **Connect Reference App**
> (`apps/connect-reference-web`, `services/connect-reference-server`): P6.5
> evidence that an outside product can integrate through the public SDKs alone.
> It is not KingsConference and never talked to kingsconference.app.


### 18.1 Verified public product surface

KingsConference publicly describes browser-based audio/video conferencing, participant management, screen sharing, recording and web access [R6]. The public material reviewed for this blueprint does not expose a documented participant-level developer media API, so no native media capability is assumed.

### 18.2 Recommended path

Treat KingsConference as a direct-partnership integration candidate. If its engineering team can expose participant-level WebRTC tracks, SFU/media hooks or a server-side media interface, build a first-class adapter. If those hooks are not available, use an embedded/Media Bridge proof while negotiating a supported integration surface.

**Access is the gating question, not engineering.** The integration path is
decided by what KingsConference's own team can expose, so P6.6 opens with a
read-only access investigation and a written request to them, not with code.
Until that answer exists, no adapter shape is committed to. See
`docs/adapters/kingsconference-integration.md` for the surveyed paths, the
questions put to their team, and the decision record.

- Request signaling and media topology docs.

- Request participant-ID and track lifecycle hooks.

- Request supported per-participant or per-language audio injection.

- Map all external IDs to Videofy IDs.

- Use native Videofy Call as the expected behavior reference.

## 19. SIP/RTP and Enterprise Telephony

A SIP/RTP gateway lets Videofy translate enterprise calls, PBX extensions, call-center conversations and local-network VoIP without requiring browser Videofy clients.

```text
PBX / SIP endpoint
      |
      v
Videofy SIP Signaling Gateway
      |
      v
RTP Media Termination / Normalization
      |
      v
ParticipantMedia
      |
      v
Realtime Language Engine
      |
      v
Translated RTP media
      |
      v
Remote endpoint
```

- Gateway owns SIP dialogs, DTMF, codec negotiation and RTP/RTCP.

- Core receives normalized PCM/media and never parses SIP.

- Each call leg maps to a participant.

- Generated audio is transcoded back to negotiated codec.

- Test jitter, packet loss, narrowband speech and echo independently.

- Support on-premise/region-bound deployment for enterprise policy where required.

## 20. Closed Consumer Calling Platforms and Media Bridge

For consumer calling products such as WhatsApp or Facebook/Messenger calling, Videofy should not claim native integration until an officially supported bidirectional real-time media interface for the exact calling product is verified. The platform can still support a controlled desktop Media Bridge where technically and legally appropriate.

```text
Closed calling application
      |
      +-- speaker output -> Videofy virtual input
      +-- camera/window   -> optional capture
      |
      v
Videofy Media Bridge
      |
      v
Realtime Language Engine
      |
      v
Videofy virtual microphone / playback output
      |
      v
Calling application
```

The Bridge is a fallback. It has weaker participant identity and depends on operating-system routing. Strict feedback isolation is mandatory.

## 21. AI Provider, Commercialization and Videofy-Native Intelligence Architecture

The AI layer must support four realities at the same time:

1. a stable, low-cost local development/demonstration stack;
2. commercially licensed local providers;
3. commercial cloud providers where coverage, quality or speed justifies them; and
4. progressively stronger Videofy-owned models and voice assets.

The media/session architecture must not care which of those four supplies STT, translation or synthesized voice.

```text
                         VIDEOfY AI ORCHESTRATOR
                                  |
          +-----------------------+-----------------------+
          |                       |                       |
         STT                 TRANSLATION                 VOICE
          |                       |                       |
   Provider Contract        Provider Contract        Provider Contract
          |                       |                       |
  +-------+-------+       +-------+-------+       +-------+-------+
  |       |       |       |       |       |       |       |       |
 Dev   Commercial Native   Dev   Commercial Native   Dev  Commercial Native
```

### 21.1 Current implemented development/demonstration stack

| Function | Current verified repository state | Commercial interpretation |
| --- | --- | --- |
| VAD | Gateway energy gate; `silero` request falls back honestly because Silero is not implemented in the current WebRTC gateway path. | Current gate may remain for development; true Silero integration is separate work, not a documentation assumption. |
| STT | `faster-whisper`; validated runtime documentation uses `Systran/faster-whisper-small.en`. | Commercial/legal approval is tracked separately. Spanish-input native calling requires a multilingual ASR path. |
| Translation | OPUS-MT primary, M2M100/NLLB-200 fallback capability, persistent Python workers, multiple EN->target routes. | NLLB-200 is non-commercial; M2M100/model-specific OPUS licences and quality require registry review. |
| Standard TTS | Multi-voice Piper plus MMS-TTS fallback. | MMS assets are non-commercial; Piper voice rights are voice-specific and must be recorded individually. Current voices are not yet Male/Female classified. |
| Personal voice | Not yet a production feature. | OpenVoice V2 is a commercial-capable prototype candidate; Videofy-native voice technology is a strategic target. |

### 21.2 Provider contracts

The platform-standard interfaces are:

```text
VadProvider
TranscriptionProvider
TranslationProvider
LanguageDetectionProvider
VoiceProvider
VoiceProfileProvider
ModelRegistry
ProviderResolver
```

Provider implementations may be local processes, in-process models, HTTP APIs or future Videofy services. Session/media code may request a capability but must not import provider-specific model libraries directly.

### 21.3 Model, voice and provider registry

The registry becomes machine-readable and authoritative. Documentation alone is insufficient.

```typescript
type CommercialUseState =
  | 'approved'
  | 'blocked-noncommercial'
  | 'review-required'
  | 'internal-only'

type ProviderAsset = {
  assetId: string
  providerId: string
  capability: 'vad' | 'stt' | 'translation' | 'tts' | 'voice-clone'
  modelId: string
  versionOrRevision: string
  languages: string[]
  deploymentMode: 'local' | 'cloud' | 'videofy-native'

  licenseId: string
  licenseEvidence: string
  commercialUseState: CommercialUseState

  qualityStatus: 'unvalidated' | 'development' | 'accepted'
  latencyStatus: 'unmeasured' | 'measured' | 'accepted'
  securityStatus: 'unreviewed' | 'reviewed'
  productionApproved: boolean
}
```

A permissive licence and production approval are deliberately separate. A model can be legally usable and still fail quality, latency, security or accuracy gates.

### 21.4 Standard voice registry

```typescript
type StandardVoiceProfile = {
  voiceId: string
  language: string
  locale?: string
  gender: 'male' | 'female'
  providerId: string
  modelId: string

  licenseId: string
  licenseEvidence: string
  commercialUseState: CommercialUseState
  rightsVerified: boolean

  qualityStatus: 'unvalidated' | 'development' | 'accepted'
  productionApproved: boolean
}
```

A language is **fully voice-ready** only when it has at least one approved Male and one approved Female standard voice in the active runtime profile. The participant may choose either; the setting is a voice preference and must not be inferred from the participant's gender.

### 21.5 AI runtime profiles

Videofy uses explicit profiles instead of one environment that quietly mixes licences.

```text
AI_RUNTIME_PROFILE=development-demo
AI_RUNTIME_PROFILE=commercial-local
AI_RUNTIME_PROFILE=commercial-cloud
AI_RUNTIME_PROFILE=videofy-native
```

**Development-demo** may use development-only/non-commercial assets when they are truthfully classified.

**Commercial-local** uses only local/self-hosted assets explicitly approved for commercial use and production.

**Commercial-cloud** uses paid/contracted providers through the same provider interfaces, with credentials, cost controls, region policy and data-processing rules outside client code.

**Videofy-native** uses Videofy-owned/controlled models. It is not automatically commercial merely because Videofy trained it; its dataset rights, evaluation, security and release state still pass the same gates.

### 21.6 Fail-closed commercial provider resolution

Commercial profiles must validate the entire dependency chain before service readiness becomes `ready`.

```text
Commercial profile selected
        |
        v
Resolve STT primary + fallback
Resolve translation primary + every fallback
Resolve TTS/voice + every fallback
Resolve voice-clone provider when enabled
        |
        v
Every selected asset:
  commercialUseState == approved
  productionApproved == true
        |
   +----+----+
   |         |
  yes       no
   |         |
 READY      STARTUP/READINESS FAIL
```

There is no warning-only mode for a commercial profile. A blocked asset cannot be reached by a fallback hidden several layers deep.

### 21.7 Current licence/readiness classification

This table is an architecture classification, not legal advice. Exact model/voice artefacts remain registry entries with evidence.

| Asset/family | Current role | Architecture classification |
| --- | --- | --- |
| NLLB-200 (`facebook/nllb-200-distilled-600M`) | Current fallback, especially where OPUS coverage/quality is insufficient. | `blocked-noncommercial` for commercial runtime; CC-BY-NC-4.0. Keep in development/demo only. |
| MMS-TTS voices such as Yoruba | Current fallback for languages without configured Piper voices. | `blocked-noncommercial` for commercial runtime; CC-BY-NC-4.0. Keep in development/demo only. |
| M2M100 418M | Implemented multilingual translation option. | MIT model card; candidate commercial-local asset, but quality must be accepted per language pair. Current audit noted poor Yoruba quality relative to NLLB. |
| OPUS-MT models | Primary local translation for many English-target pairs. | Per-model review; many models are permissively licensed, but each exact model/revision is registered rather than assumed. |
| Piper voices | Current local standard TTS. | Voice-specific rights review required. Do not infer that every voice model shares the same commercial terms. |
| faster-whisper / selected Whisper model | Current STT. | Licence/model review plus quality/latency approval required per selected checkpoint. |
| OpenVoice V2 | Proposed personal voice prototype. | Official project states MIT commercial/research use; still requires dependency/model/data/quality/security approval. |
| MADLAD-400-3B-MT | Proposed local commercial translation evaluation. | Model card states Apache-2.0 and 400+ language coverage; benchmark memory, latency and Yoruba/target quality before approval. |

### 21.8 Commercial replacement strategy

Videofy should not replace every current provider now. It should create interchangeable commercial paths and gradually certify them.

```text
Development translation:
  OPUS-MT -> NLLB fallback where needed

Candidate commercial-local translation:
  approved OPUS-MT pair -> M2M100 or MADLAD candidate

Candidate commercial-cloud translation:
  CommercialTranslationProvider implementation

Future:
  VideofyTranslateProvider
```

Equivalent provider ladders apply to STT and TTS. Provider selection may later consider language, quality, latency, cost, data region, privacy, availability and customer policy, but only from the set allowed by the active runtime profile.

### 21.9 Videofy Intelligence - long-term native AI programme

Videofy should progressively become less dependent on external AI vendors while retaining the ability to use them whenever they are better. This is a strategic R&D programme, not an excuse to delay the product.

```text
Videofy Intelligence
|
+-- Videofy Speech
|   +-- ASR
|   +-- language detection
|   +-- accent/domain adaptation
|
+-- Videofy Translate
|   +-- multilingual translation
|   +-- domain terminology
|   +-- low-resource language work
|
+-- Videofy Voice
|   +-- standard voices
|   +-- personal voice technology
|   +-- voice-cloning/speaker identity
|
+-- Videofy Language Lab
|   +-- licensed datasets
|   +-- evaluation corpora
|   +-- accent/code-switching corpora
|   +-- terminology and domain sets
|
+-- Videofy Model Registry
    +-- external assets
    +-- commercial-provider assets
    +-- Videofy-native assets
```

The long-term commercial opportunity is not limited to Videofy Call. Mature native capabilities may later be exposed as Videofy Speech API, Videofy Translate API, Videofy Voice API and Realtime Interpretation API through Videofy Connect.

### 21.9.1 Videofy Intelligence is a learning system

Owner decision, 2026-08-16. The objective is no longer "eventually train our
own models". It is:

> Videofy continuously learns from legally usable development models,
> commercial teachers, verified human corrections and rights-cleared
> first-party data, while building smaller, faster, context-aware native
> speech, translation and voice models optimized specifically for real-time
> multilingual communication.

The difference matters architecturally: learning capability becomes part of
the platform rather than a future research project, so the contracts for it
are owed now, not at VI-R2.

**Two speeds, deliberately separated.** Live adaptation and model training are
different mechanisms with different risk. Session context adapts in seconds —
names, terminology, pronunciation, speaker and accent characteristics. Model
weights change only through a verified training and evaluation release. A
speech model permitted to rewrite itself from live calls is a speech model
being taught somebody's cough as a surname.

**Streaming-first.** The native runtime targets continuous audio with cached
acoustic state and a context-aware decoder, not collect-chunk-wait-decode.
Context must survive segment boundaries: a new chunk must not give the model
amnesia. This is the architectural wall the P6.1 chunk-tuning work found
experimentally (§22), and it is the reason it cannot be tuned away.

**Development models stay.** faster-whisper, OPUS-MT and Piper remain useful
teachers and baselines when commercial providers arrive. They are not
discarded on arrival.

### 21.9.2 Training rights are a hard gate

Videofy trains from a provider's outputs only when that provider's terms
explicitly permit training or distillation. Where they do not, the provider
remains available as a benchmark, comparison, error detector, quality judge
and production route — but its outputs never become training data.

This lives in the model registry as provider metadata rather than in anyone's
memory:

```ts
TeacherProvider {
  providerId: string
  mayServeProduction: boolean
  mayGenerateEvaluationData: boolean
  mayGenerateTrainingData: boolean
  mayBeUsedForDistillation: boolean
  rightsEvidence: string
  rightsVerifiedAt: string
  capabilities: { speech, translation, tts, streaming }
}
```

Every training example carries its own provenance — source audio, reference
transcript, teacher outputs, human verification, consent state, training
rights, dataset version — so the question "where did this voice come from?"
has an answer that predates being asked.

**Customer calls are excluded from training by default.** Only explicitly
permitted data crosses that boundary. Non-negotiable.

### 21.9.2.1 What P6.3 proves, and what it does not

Recorded precisely, because the difference is easy to lose on a checklist.

**P6.3 guarantee.** Enrollment grants no training consent by default, and P6.3
exposes no training-ingest path at all.

**VI-L0 guarantee.** When a training-ingest path exists, withheld or absent
consent is proven to reject the example before it can enter a training
dataset.

These are not the same claim. P6.3's holds because the subsystem does not
exist; it says nothing about what happens once one does. Treating the absence
of a pipeline as proof that the pipeline cannot leak is efficient mathematics
and terrible engineering, so the second guarantee is owed at VI-L0 and cannot
be inherited from the first.

### 24.6 Call Mode — normal and translated calls

Owner decision, 2026-08-16. Contract recorded ahead of implementation.

Videofy Call is a calling system that can invoke translation, not a translation
app that happens to place calls. Call Mode sits ABOVE the existing audio modes
and must not be confused with them:

```text
Call Mode          normal | translated        session level
Audio Mode         translated | interpretation | original
                                              participant level,
                                              inside a translated call
```

**Normal call.** Direct WebRTC conversation. No VAD, STT, translation, TTS or
personal-voice synthesis runs, and no AI-provider cost is incurred. Camera,
microphone and screen sharing behave exactly as in any ordinary call. A
45-minute meeting that needs translation for ten minutes must not be processed
through paid providers for forty-five.

**Translated call.** The Videofy realtime language engine is active and the
existing pipeline applies unchanged.

**Mode changes are revisioned**, exactly like language changes, and carry
`callMode` plus `callModeRevision`. Switching must not restart the call, drop
the WebRTC session, or disturb cameras and microphones — only the
language-processing path changes.

Leaving translated mode:

- stop admitting new utterances into translation;
- invalidate queued translated and personal-voice audio that has not played,
  reusing the P6.3 revocation semantics;
- reject stale translation results carrying the old revision;
- restore direct original audio.

Entering translated mode: processing begins at the NEXT speech. Backfilling the
previous ten minutes would be neither expected nor causal.

**Authority.** `callMode` is session level and belongs to the host, or the
moderator in a conference; a participant cannot switch the whole room. Spoken
language, preferred language, caption preference, audio mode and voice profile
remain individual once translated mode is active. That separation is what P6.4
Conference will need anyway.

**Personal voice follows from this cleanly.** In a normal call personal voice is
inactive, because there is no translated speech for it to speak. It applies only
inside a translated call, where the P6.3 chain runs: personal when usable, then
standard, then captions plus original audio.

**UI.** Call mode is a two-way choice presented plainly. Language and audio
controls are revealed when translated is selected and collapse when it is not,
rather than sitting scattered around a call that is not translating anything.

Implementation is a dedicated wave after P6.3, before or within P6.4.

### 21.9.2.3 Personal-voice engine decision

Owner decision, 2026-08-16. **OpenVoice V2** is the selected personal-voice
engine candidate, on licence grounds before quality grounds: it is MIT, and a
better-sounding voice Videofy cannot sell is worth less than a good one it can.

**XTTS-v2 is blocked from any commercial runtime.** Its Coqui Public Model
License restricts the model and its outputs to non-commercial use. It may be
used as a development benchmark only.

Selection is not approval. OpenVoice enters the registry as
`development-unvalidated` and must still pass licence/checkpoint provenance, a
dependency audit, installation reproducibility, EN→ES and ES→EN cloning,
identity similarity, intelligibility, latency, GPU/CPU behaviour, and failure
and cleanup behaviour before any production claim. No model receives a
commercial halo because a metadata field says MIT.

**Isolation is architectural, not stylistic.** OpenVoice runs as a local AI
service behind `VoiceProfileProvider`, never inside the Node call runtime or
the React call app. It also gets its own Python environment: its official
instructions target Python 3.9 while the working Videofy AI environment is
3.11.9, and contaminating a proven speech environment to add a voice feature
would be an expensive way to lose both.

**The derived asset is a representation, not a model per person.** Enrollment
extracts a small reusable tone-colour representation; synthesis combines
translated text, a base target-language voice and that representation. Nobody
waits through per-person model training to enroll.

### 21.9.2.4 OpenVoice V2 acceptance — two gates, recorded separately

Owner decision, 2026-08-16, after human review of a real browser enrollment.

**Engine viability: PASS.** Real enrollment through the browser path, real
human voice, cross-language conversion in both directions, measured identity
movement (EN→ES 0.26→0.79, ES→EN 0.10→0.63 cosine against the speaker),
~0.36–0.52s engine latency, RTF ~0.06, ~1.5 GB VRAM, with the fallback,
consent and revocation architecture already proven.

**Human quality: ACCEPTABLE FOR DEVELOPMENT-DEMO. NOT PRODUCTION QUALITY.**
Owner scored it approximately 7/10: "still a bit synthetic, doesn't have the
accent or emotions, sounds straight."

These are deliberately recorded as two results rather than one. The original
B4 gate asked for identity ≥4/5, and the owner's actual perception is nearer
3.5/5. **That gate did not pass as written.** The decision is that the
prototype is useful enough to integrate despite falling short of the
aspirational bar — not that the bar was met. Restating the criterion to match
the result would be how a project quietly loses the ability to fail.

`productionApproved = false`.

**Why the limitation is architectural.** OpenVoice V2 transfers tone colour —
timbre — only. Accent, rhythm and expressiveness come from the base speaker,
so translated speech carries the enrolled voice's colour over MeloTTS's
delivery. No converter tuning changes this, and P6.3 must not be held open
waiting for it.

**Product wording is constrained by what was demonstrated.** "Your translated
voice" and "a voice based on your recording" are supportable. "Your exact
voice", "speak exactly like yourself in another language" and "preserves your
accent and emotion" are not: speaker/timbre transfer was demonstrated,
faithful preservation of accent, prosody, emotion, cadence and speaking style
was not.

**Base speaker is configuration, not a prerequisite.** It measurably changes
delivery and belongs beneath the provider so it can be tuned later. Comparison
across all five MeloTTS English bases is recorded in the spike evidence.

**Two accent problems, related but distinct.** C-AI1 concerns recognition
robustness — Nigerian-accented speech being understood correctly by STT. This
concerns expressive synthesis — a speaker's accent and prosody surviving into
translated output. They should eventually share evaluation material; they are
not one subsystem, and collapsing them would produce a component responsible
for everything and accountable for nothing.

Accent preservation, prosody, emotion and streaming-native synthesis belong to
Videofy Voice (VI-R1), not to this engine.

### 21.9.2.2 Prototype voice ownership is temporary by design

P6.3 binds a personal voice to a `VoiceOwnerId` minted into browser
localStorage, because Videofy has no account authentication yet and a voice
profile must outlive the call it was recorded in.

**The limitation, stated so it cannot be forgotten:** localStorage is scoped to
a browser profile, not to a human. Two people sharing one browser profile share
one prototype identity, and would share a personal voice. This is acceptable
for development and unacceptable for production.

The replacement is mandatory, not optional, and must not be skipped on the
grounds that the prototype has proven reliable. `VoiceOwnerId` exists precisely
so the replacement is cheap: an account id takes its place, and neither the
voice-provider nor the call-routing contracts move. What must never happen is
the prototype mechanism being promoted into production architecture because it
survived enough tests to feel established.

### 21.9.3 Disagreement is the training signal

Videofy does not learn equally from everything. It learns preferentially where
its teachers disagree, and where the native student is wrong while verified
teachers are right. An utterance every system already transcribes correctly
teaches nothing on the four-hundredth repetition; a Nigerian surname that one
teacher hears and another mangles is worth a great deal.

This makes the C-AI1 bake-off dual-purpose. It was built to choose a vendor;
it also produces exactly the artefacts the learning engine needs — teacher
outputs, measured disagreement, difficult names, accent cases and latency
evidence.

### 21.10 Model-development maturity ladder

Videofy should learn and grow in stages:

1. Use current development/demo providers to prove product behavior.
2. Fine-tune or adapt commercially compatible foundation models using rights-cleared Videofy datasets.
3. Build specialized models first: voices, Nigerian-English/other accent ASR adaptation, Yoruba/English translation, terminology/domain adapters and endpointing models.
4. Build reusable multilingual components only after the datasets and evaluations are mature.
5. Train larger Videofy-native models when data volume, compute, product demand and economics justify it.
6. Promote a Videofy-native model into commercial runtime only after the same licence/data-rights, quality, latency, security and production gates used for third parties.

The aim is progressive capability ownership, not an expensive attempt to reproduce every foundation model immediately.

### 21.11 Videofy Voice Studio - internal training and library system

Voice ownership is the practical first native-model programme because it directly addresses the Male/Female standard-voice requirement and languages with weak commercial TTS coverage.

```text
Create Voice Project
  -> choose language / locale / Male or Female
  -> execute speaker rights + consent agreement
  -> generate/approve recording script
  -> supervised recording sessions
  -> automated audio-quality validation
  -> transcript and pronunciation review
  -> dataset segmentation/normalization
  -> fine-tune/train approved voice architecture
  -> objective evaluation
  -> native-speaker human review
  -> legal/data-rights verification
  -> latency/runtime benchmark
  -> publish to Videofy Voice Library
```

Standard Videofy voices and personal voices are separate assets:

```text
STANDARD VIDEOfY VOICE
  professionally recorded
  rights-cleared for product use
  reusable by authorized customers

PERSONAL VIDEOfY VOICE
  enrolled by one individual
  private/authorized scope
  not automatically added to the standard library
  not general training data without separate consent
```

### 21.12 Videofy Language Lab and dataset governance

Owning models requires owning or controlling lawful, high-quality data. Data lineage is therefore part of architecture.

```typescript
type DatasetAsset = {
  datasetId: string
  version: string
  languages: string[]
  domains: string[]
  sourceDescription: string
  sourceRights: string
  consentBasis?: string
  allowedPurposes: string[]
  commercialTrainingAllowed: boolean
  containsPersonalData: boolean
  retentionPolicy: string
  contentHashManifest: string
  approvedForTraining: boolean
}
```

Dataset priorities should include clean studio speech, natural conversation, Male/Female voices, accents, age ranges where lawful, names, dates, numbers, currencies, business language, technical terminology, noisy speech, code-switching and region-specific usage. For Yoruba and Nigerian English in particular, culturally and linguistically accurate evaluation data can become a meaningful Videofy advantage.

Customer calls are not harvested into this corpus by default. Any contribution programme must use separate, explicit and revocable rights/consent and must be technically separable from normal communication consent.

### 21.13 Model lineage and release records

Every Videofy-native release stores:

- parent/base model and licence;
- training code/version;
- training-run identifier;
- dataset versions and rights state;
- hyperparameters and hardware profile;
- evaluation results by language/domain;
- known limitations;
- safety/abuse review where relevant;
- commercial approval state;
- rollback/fallback model;
- model card and change log.

Model binaries, voice recordings and private datasets do not belong in the Git repository. Git stores manifests, hashes, training/evaluation code and release metadata; protected object storage/model registry stores artefacts.
## 22. Latency and Streaming Strategy

Conversational translation is far more sensitive to delay than programme interpretation. Long silence between speaker and translated output breaks turn-taking and causes people to talk over translations.

| Stage | Design target | Comment |
| --- | --- | --- |
| Endpointing/VAD | ~300-700 ms after useful pause | Avoid long fixed chunks. |
| STT partial/final | ~300-1,000 ms incremental target | Model/hardware dependent. |
| Translation | ~100-500 ms short-utterance target | Reuse per target language. |
| TTS first audio | ~200-700 ms target | Prefer phrase streaming if provider supports it. |
| Perceived delay | Aim ~1-3 s in optimized call mode | Target, not current guarantee. |

All figures above are engineering targets, not current performance claims. Actual latency must be benchmarked for each language pair, model and deployment profile.

### 22.1 Streaming progression

1. Begin with short reliable final utterances.

2. Introduce partial transcript events with revision-safe replacement.

3. Translate stable clauses, not every unstable token.

4. Generate phrase-level TTS and preserve ordering.

5. Cancel/supersede stale partial synthesis when meaning changes.

6. Measure perceived first-audio latency separately from full-segment completion.

## 23. Security, Consent, Privacy and Voice Protection

### 23.1 Media/data

- Encrypted transport for media/signaling/service APIs.

- Minimize raw media retention by default.

- Separate ephemeral call media from durable voice-profile storage.

- Least-privilege service identities.

- No raw audio, reusable embeddings or secrets in logs.

- Participant-visible indication when transcription/translation/personal voice is active.

- Region/on-premise options for enterprise policy as the product matures.

### 23.2 Voice controls

| Control | Requirement |
| --- | --- |
| Enrollment | Explicit opt-in before capture. |
| Identity assurance | Live challenge/equivalent policy; arbitrary third-party recordings not default. |
| Purpose limitation | Only approved translated-speech use unless separately consented. |
| Disable | Immediate switch to standard voice. |
| Delete | Verifiable deletion of profile/reference material. |
| API exposure | No ordinary client access to reusable embeddings. |
| Audit | Creation, policy change, disable and deletion events. |

### 23.3 Platform compliance

Each adapter must document platform terms, user-consent requirements, transcription/recording indicators, data residency implications, app-review requirements and restrictions. These are adapter certification requirements, not informal deployment notes.

## 24. Data Contracts and API Surface

### 24.1 ParticipantMedia

```typescript
type ParticipantMedia = {
  sessionId: string
  participantId: string
  adapterId: string
  mediaRevision: number
  audioTrack?: NormalizedAudioTrack
  videoTrack?: NormalizedVideoTrack
  timestamps: MediaClockDescriptor
  capabilities: ParticipantMediaCapabilities
}
```

### 24.2 LanguagePreference

```typescript
type LanguagePreference = {
  sourceLanguage: string | null
  sourceLanguageMode: manual | auto | confirmed-auto
  sourceLanguageLocked: boolean
  preferredLanguage: string
  captionLanguage: string
  languageRevision: number
}
```

### 24.3 VoicePreference

```typescript
type VoicePreference = {
  mode: standard | personal | original-only
  standardVoiceGender?: male | female
  standardVoiceId?: string
  voiceProfileId?: string
  fallbackVoiceId?: string
}
```

### 24.4 Transcript event

```typescript
type TranscriptEvent = {
  sessionId: string
  participantId: string
  mediaRevision: number
  languageRevision: number
  sequence: number
  startTimestampMs: number
  endTimestampMs: number
  sourceLanguage: string
  text: string
  confidence?: number
  isFinal: boolean
  provider: string
}
```

### 24.5 Routed translation and generated voice

```typescript
type RoutedTranslationEvent = {
  sessionId; participantId; mediaRevision; languageRevision
  sourceSequence; targetLanguage; translatedText; provider; createdAtMs
}

type GeneratedVoiceEvent = {
  sessionId; speakerParticipantId; mediaRevision; languageRevision
  sourceSequence; targetLanguage; voiceMode; voiceId
  audioRef; startTimestampMs; durationMs
}
```

> **Contract naming rule.** The repository already contains legacy translation event terminology. Phase 6 must not reuse an incompatible `TranslationEvent` name. New call-routing contracts use collision-safe names such as `RoutedTranslationEvent`; compatibility adapters translate legacy events at the boundary.

### 24.6 SDK duties

- Join/leave sessions.

- Register language, caption, audio and voice preferences.

- Publish media or provide adapter track handles.

- Receive translated caption/audio events.

- Report capabilities/health.

- Expose explicit cleanup.

- Do not let clients invent internal revision values.

## 25. Deployment and Runtime Topology

### 25.1 Initial monorepo

```text
videofy-live/
|
+-- apps/
|   +-- operator-web/
|   +-- listener-web/
|   +-- call-web/                  # Phase 6 native calls
|
+-- services/
|   +-- realtime-gateway/
|   +-- media-ingest/
|   +-- call-session/              # new
|   +-- language-router/           # new/extracted
|   +-- voice-service/             # new/extracted
|   +-- ai-registry/               # provider/model/voice metadata and runtime policy
|   +-- connect-gateway/           # new
|
+-- adapters/
|   +-- native-webrtc/
|   +-- zoom/
|   +-- kingsconference/   (adapter, P6.6)
|   +-- sip/
|   +-- media-bridge/
|
+-- packages/
|   +-- shared-types/
|   +-- media-contracts/
|   +-- participant-contracts/
|   +-- call-contracts/
|   +-- connect-sdk/
|
+-- research/
    +-- videofy-intelligence/      # training/evaluation code, manifests and model cards only
```

Private datasets, voice recordings, large model binaries, embeddings and training artefacts do **not** live in Git. Git stores code, schemas, dataset/model manifests, checksums, evaluation definitions and release metadata. Protected object/model storage holds the artefacts.
### 25.2 Why one repository now

- Contracts change atomically with consumers.

- P5 and P6 regressions run together.

- Avoid duplicate provider registries and session semantics.

- Simpler CI while boundaries stabilize.

- Services can still deploy independently.

### 25.3 Scale path

Conference scale will eventually require an SFU/media-server strategy, persistent session state, production TURN, horizontal gateway scaling, queue/backpressure controls, region-aware AI workers and capacity management. These belong to explicit scale milestones after the native call architecture is proven.

## 26. Observability, Quality and Operations

| Domain | Required metrics |
| --- | --- |
| Media | Track counts, packet loss, jitter, bitrate, reconnects, revision, source ended. |
| VAD/STT | Speech duration, endpoint delay, STT latency, empty transcript rate, confidence. |
| Translation | Latency, target, retry/failure, stale rejection, duplicate rate. |
| Voice | Load time, synthesis/first-audio latency, fallback, generation failures. |
| Recipient | Queue depth, translated-audio delay, play failures, mix mode/volume. |
| Session | Participant count, active languages, adapter capabilities, cleanup counts. |
| Voice profile | Enrollment/load/fallback/deletion events; no biometric payload in ordinary telemetry. |

Logs and metrics should correlate sessionId and participantId; derived events add media/language revisions and sequence. This lets one utterance be traced across the system without logging its raw audio.

## 27. Failure Handling and Graceful Degradation

| Failure | Required behavior |
| --- | --- |
| STT unavailable | Original media continues; translation/caption status becomes unavailable. |
| Translation unavailable | Original audio and source captions continue. |
| Personal voice unavailable | Use the participant's selected standard Male/Female voice automatically. |
| Standard TTS unavailable | Translated text continues; original audio remains. |
| Autoplay blocked | Prompt recipient action; do not regenerate duplicate audio. |
| Adapter media loss | Mark interrupted, recover adapter, increment media revision if replaced. |
| Detection uncertain | Keep current/unknown language and ask for confirmation. |
| Stale AI result | Reject by revision/sequence and record event. |
| No external egress | Offer supported caption/sidecar/bridge experience; do not claim full native audio. |

## 28. Migration from Current Videofy Live and Repository Baseline

### 28.1 Current proven baseline

The current authoritative baseline is remote `main` at `b4ac24e6ef8220847efd2795e0dbf94cce7d5ad6`, not the older `2ada7a...` Phase 5 milestone. Phase 5 has already been merged. The repository now includes the later multilingual viewer, sentence segmentation, persistent AI workers, multi-provider translation/TTS, listener/gateway/media-ingest hardening and contract fixes.

The permanent regression promise remains the same: unified programme/session authority, source/media revision safety, live/uploaded programme delivery, WebRTC media, translation/caption delivery, generated-audio playback, mix controls, source switching and cleanup must not regress while the shared call architecture is extracted.

### 28.2 Current development/demonstration stack is preserved

The existing AI stack is **not replaced as a prerequisite for Phase 6 engineering**. It remains the development/demo profile. Commercial provider work happens behind provider boundaries and runtime profiles.

This separates two questions that humans tend to mash together for sport:

1. "Does the call/conference architecture work?"
2. "Is every AI asset approved for commercial production?"

Both matter, but they are different gates.

### 28.3 Extraction sequence

1. Freeze current `main` behavior with regression evidence.
2. Add/ratify Phase 6 ADRs and the commercial-runtime policy before moving authority.
3. Introduce participant/call contracts without moving runtime authority.
4. Represent the existing programme broadcaster as a special participant/media producer with `role=programme`.
5. Move shared language/revision/generated-audio contracts into reusable packages.
6. Extract recipient routing policy behind a service boundary while preserving listener behavior.
7. Introduce call-session service and call-web using `development-demo` providers first.
8. Add commercial provider implementations through existing provider contracts, not through separate media pipelines.
9. Add external adapters only after native 1-to-1 call is stable.
10. Begin Videofy Intelligence R&D in parallel without making it a blocking dependency for product delivery.

### 28.4 Prohibited migration shortcuts

- No forked media-ingest pipeline for calls.
- No separate transcript/translation event shapes per platform without a compatibility reason.
- No platform ID used as universal participant ID.
- No voice-cloning bypass around generated-audio provenance/queue rules.
- No disabling stale-result rejection for lower latency.
- No commercial profile that can reach NLLB/MMS or any other non-commercial/unknown asset through fallback.
- No automatic conversion of customer media into training datasets.
- No replacing proven development infrastructure merely to make a licensing table look tidy.
## 29. Phase 6 and Commercialization Roadmap

| Milestone / track | Scope | Exit condition |
| --- | --- | --- |
| P6-G0 Truth, governance and provider boundary | Ratify current `main` baseline; update master architecture; add ADRs; define machine-readable licence/readiness metadata; define runtime profiles; branch/CI strategy. | Architecture and provider policy accepted; no runtime-authority change required. |
| P6-UX0 Experience foundation | Establish shared Videofy design system, premium role-based public/participant/listener/operator/admin shells, progressive disclosure, responsive layouts and browser visual-QA workflow. | Reference screens are approved; primary user flows are media-first and uncluttered; internal engineering state is role-gated; design tokens/components are reusable before P6.1 visual closure. |
| P6.0 Architecture extraction | Participant, call-session, recipient-routing and adapter contracts; programme-as-participant compatibility. | Current Phase 5/current-main behavior preserved; no call UI required. |
| P6.1A Duplex language prerequisites | Spanish-capable STT; explicit ES->EN translation/English target; English TTS; EN Male+Female and ES Male+Female standard voices. | Both call directions have validated speech, translation and standard voice capability under `development-demo`; voice pair rule satisfied. |
| P6.1B Native two-person call runtime | EN<->ES media, independent raw mic streams, captions, translated audio, recipient routing, feedback isolation, reconnect/cleanup. | Both directions work in one native call session. |
| P6.1C P6.1 acceptance | Combine P6.1A+B, real browsers/devices, latency evidence, quality review and regression. | P6.1 criteria pass literally; no partial voice-ready waiver. |
| P6.2 | Auto-detect assistance and personalized captions. | Confidence/confirm/override/lock are revision-safe. |
| P6.3 | Videofy Voice personal-voice prototype with consent/fallback. | Approved EN/ES personal-voice proof; standard voice fallback preserved. |
| P6.4 | 3+ participant conference routing. | At least three language preferences with deduped target routing and correct attribution. |
| P6.5 | Videofy Connect SDK/API. | Independent sample app integrates through public contracts only. Strengthened 2026-08-19 by the Connect Reference App (`apps/connect-reference-web`, `services/connect-reference-server`): a full conference product — rooms, host keys, Normal/Translated modes, captions, transcripts, recovery — built on `@videofy/connect` and `@videofy/server-sdk` only, proven against SDK tarballs installed outside the workspace. |
| P6.6 | KingsConference adapter: the FIRST third-party platform integration. KingsConference keeps its own conference; Videofy supplies the language layer through a trusted server-side adapter into Connect. (Corrected 2026-08-19: an earlier same-day ratification wrongly framed KingsConference as a first-party product. The artifact built under it is retained as the Connect Reference App and counts as P6.5 evidence, not as P6.6.) | A real KingsConference meeting carries at least two languages end to end: a speaker's audio leaves their conference, is recognised and translated by the existing Videofy engine, and translated audio plus captions return to the correct listeners inside that same meeting, with participant identity preserved across the seam and no Videofy-internal vocabulary crossing the adapter boundary. |
| P6.7 | Zoom adapter. | RTMS ingress plus verified supported egress/sidecar behavior. |
| P6.8 | SIP/RTP gateway. | Two SIP endpoints complete translated call. |
| C-AI1 Commercial provider certification | Implement and certify at least one commercial translation/TTS/STT route per launch language, local or cloud. | Commercial profile has no blocked/unknown fallback and passes quality/latency/security gates. |
| VI-L0 Videofy Learning Foundation | TeacherProvider contract, training-rights registry, contextual-memory contract, disagreement collection, correction/reference format, dataset provenance, evaluation-harness integration and streaming-native performance requirements. | Rights metadata gates every teacher; a disagreement example can be collected, attributed and refused on rights grounds without human memory being the control. |
| VI-R1 Videofy Voice Library | Voice Studio, rights-cleared recording/training flow and first Videofy-owned standard voice assets. | At least one native voice release has full data/model lineage and can be loaded through `VoiceProvider`. |
| VI-R2 Videofy Speech/Translate specialization | Fine-tuning/adapters for priority accents/language pairs and evaluation corpus. | First specialized native model beats or complements the chosen baseline on a defined acceptance suite. |
| VI-R3 Videofy-native service offering | Harden selected native models for internal production and later external API use. | Native capability passes commercial runtime gates and can be exposed through Videofy Connect without special media code. |

### 29.1 Parallel tracks

The following proceed in parallel with native Call/Conference engineering:

- commercial-provider evaluation and licensing evidence;
- local-commercial candidates such as M2M100/MADLAD benchmarking;
- commercial-cloud provider adapters behind the same contracts;
- Videofy Voice Studio and owned voice-library R&D;
- Videofy Language Lab datasets/evaluation tooling;
- external platform partnership discussions;
- TURN/SFU production planning;
- authentication, persistence, billing and deployment planning;
- CI/branch protection hardening;
- commercial packaging.
- premium experience/design-system implementation and browser visual QA;

Native P6.1 may use the locked `development-demo` profile. **Commercial launch may not.** The product does not wait for Videofy to train every future model, and Videofy does not paint itself into a vendor-dependent corner while shipping the product.
## 30. Acceptance Criteria by Milestone

### 30.1 P6-G0

- Current remote `main` baseline and Phase 5 merge are recorded.
- Master architecture reflects actual gateway VAD state, current providers and licence restrictions.
- `sourceLanguageRevision` is recognized as already fixed; no duplicate work order exists.
- Runtime profile contract exists at architecture/config level.
- Registry schema distinguishes licence/commercial approval from production approval.
- Non-commercial fallback prohibition is testable.
- Branch/CI ADR is ratified.

### 30.2 P6.0

- All current Live/uploaded programme regressions pass.
- Participant/call contracts exist with no duplicate authority.
- Programme source maps through common media contract.
- Recipient routing has no external-platform dependency.
- Legacy translation event compatibility is preserved; new call contracts use collision-safe names.

### 30.3 P6.1A - duplex language prerequisites

- Spanish speech is transcribed by a validated Spanish-capable/multilingual STT path.
- English speech remains validated.
- EN->ES translation works.
- ES->EN translation works.
- English is a valid recipient target.
- English standard TTS works.
- Spanish standard TTS works.
- English exposes at least one approved Male and one approved Female standard voice in the active development profile.
- Spanish exposes at least one approved Male and one approved Female standard voice in the active development profile.
- Voice metadata is machine-readable, not inferred from filenames.

### 30.4 P6.1B/P6.1C - native call

- Two devices join one call.
- A selects English; B selects Spanish.
- A speech -> B Spanish caption/audio.
- B speech -> A English caption/audio.
- Original audio remains according to mix mode.
- Generated audio never enters STT.
- Reconnect does not duplicate peers/participants/audio.
- Leave/stop returns resources to baseline.
- Latency is measured and reported honestly.
- Standard voice Male/Female selection works on both ends.
- No `voice-partial` label is accepted as P6.1 closure for English or Spanish.
- Current Videofy Live programme regressions remain green.

### 30.5 P6.3 - personal voice

- Explicit consent.
- Enrollment can be skipped.
- Voice profile separately protected.
- Human-reviewed cross-lingual personal voice proof.
- Personal-voice failure falls back to the participant's selected Male or Female standard voice.
- Disable/delete verified.
- Enrollment audio/profile is not reused as general training data without separate consent.

### 30.6 P6.4 - conference

- Three participants and at least three language preferences.
- Speaker attribution correct.
- Translation deduplicated by target language.
- Personalized outputs do not leak between recipients.
- Concurrent-listener WebRTC regression remains green.
- Cleanup returns counts to baseline.

### 30.7 Commercial runtime acceptance

A commercial runtime profile is releaseable only when:

- every selected STT/translation/TTS/voice/voice-clone primary and fallback has `commercialUseState=approved`;
- every selected asset has `productionApproved=true`;
- development-only assets are unreachable by configuration and verified in tests;
- provider credentials and customer data policy are production-safe;
- launch-language Male/Female standard voice requirements are satisfied;
- human language/voice quality and latency acceptance is complete;
- dependency/model/voice licences and evidence are archived;
- the runtime can fail over only to other approved assets.

### 30.8 Videofy-native model acceptance

A Videofy-owned model is not promoted merely because training finished. It requires:

- dataset rights/provenance approval;
- parent-model licence compatibility where applicable;
- reproducible training-run record;
- quality benchmark and human review;
- latency/cost benchmark;
- known-limitations/model card;
- security/abuse review for voice cloning or identity-sensitive models;
- rollback/fallback plan;
- production approval in the registry.
## 31. End-to-End Test Strategy

| Layer | Purpose | Examples |
| --- | --- | --- |
| Unit/contract | Deterministic semantics | Revision rejection, language authority, routing. |
| Provider | AI runtime | Non-empty STT, translation ordering, voice fallback. |
| Service integration | Cross-service flow | Participant media -> transcript -> translation -> voice. |
| Browser/WebRTC | Real media | Two-person call, reconnect, autoplay, source replacement. |
| Network | NAT/TURN | Separate networks, relay proof, packet loss. |
| Human quality | Language/voice | Accent, names, numbers, meaning, voice acceptability. |
| Adapter | Platform-specific | Zoom RTMS, KingsConference hooks, SIP codecs. |

### 31.1 Required test corpus

- Clean English and Spanish conversational speech.

- Nigerian-accented English with human review.

- Names, dates, currencies, technical terms and numbers.

- Moderate background noise.

- Overlapping speech.

- Short code-switching.

- Network interruption/reconnect.

- Voice-profile enrollment test sample with explicit consent.

- Rights-cleared standard-voice training/evaluation samples for Voice Studio.

- Commercial-profile negative fixture proving NLLB/MMS/non-approved fallbacks are rejected.

### 31.2 Quality reporting

Technical delivery, transcription accuracy, translation adequacy, voice intelligibility, identity preservation and latency are separate dimensions. Passing media transport does not mean language quality is approved.

## 32. Operational Execution Playbook

### 32.1 P6-G0 - truth and governance before extraction

1. Confirm local worktree branch/clean state and compare it with remote `main` at the current verified baseline.
2. Preserve the current master architecture in history, then ratify this Version 3.0 as the single current architecture source of truth.
3. Create ADR files for identity, session authority, media clock, adapter boundary, commercial provider policy, runtime profiles, voice rights, training-data policy and native-AI lineage.
4. Add a machine-readable provider/model/voice registry design with `commercialUseState`, production approval and evidence references.
5. Mark NLLB-200 and MMS-TTS as development/demo only; do not remove them.
6. Define `development-demo`, `commercial-local`, `commercial-cloud` and `videofy-native` profiles.
7. Add branch/CI strategy: required checks and protected commercial-release workflow before launch.
8. Record the current gateway VAD truth: energy fallback is active; Silero integration is future work.
9. Record that `sourceLanguageRevision` is already present in the current schema and must not be reworked as an unfixed defect.
10. Do not move runtime authority during this governance wave.

### 32.2 P6.0 implementation sequence

1. Define `ParticipantId`, `CallSessionId`, `MediaRevision` and `LanguageRevision` types.
2. Define `ParticipantMediaCapabilities` and adapter capabilities.
3. Define language/caption/audio/voice preferences.
4. Use collision-safe names for new routed translation contracts.
5. Wrap the existing programme broadcaster in `ParticipantMedia` abstraction without changing media behavior.
6. Extract recipient output policy from listener-specific implementation.
7. Add compatibility adapters for existing socket events.
8. Run current-main media, interpretation and multilingual viewer regressions.
9. Commit only when behavior is unchanged.

### 32.3 P6.1A implementation sequence - duplex prerequisites

1. Select/enable a Spanish-capable multilingual STT path while preserving the current English baseline.
2. Add Spanish->English translation capability and English as a valid target.
3. Add English standard TTS.
4. Create/validate Male and Female standard voices for English and Spanish in the development profile.
5. Add gender and commercial/readiness metadata to voice registry entries.
6. Prove all four voice selections and both translation directions in focused provider tests.
7. Do not label English or Spanish fully voice-ready until the pair requirement passes.

### 32.4 P6.1B implementation sequence - native call

1. Create `call-web` skeleton and call-session service.
2. Implement participant join/leave registry.
3. Publish each participant raw microphone/video separately.
4. Attach language preference before media processing.
5. Route each raw microphone to its own STT stream.
6. Translate canonical transcript for each recipient's preferred language.
7. Generate selected standard TTS and route only to intended recipient.
8. Add captions and mix modes.
9. Add reconnect/revision handling and cleanup.
10. Benchmark latency; optimize the dominant stage only after measurement.

### 32.5 Commercial provider certification sequence

1. Choose a capability/language gap, not a vendor.
2. Add provider implementation behind the existing interface.
3. Register exact model/service/version, licence/contract evidence and allowed languages.
4. Test quality, latency, failure mapping and privacy/data handling.
5. Test every configured fallback recursively.
6. Run a commercial-profile negative test with a blocked development asset and confirm readiness fails.
7. Promote only after legal/rights evidence, engineering review and human quality acceptance.
8. Keep the development profile untouched for R&D/demo use.

### 32.6 Videofy Voice Studio execution sequence

1. Create a rights-cleared voice project.
2. Approve speaker agreement, permitted uses and training rights before recording.
3. Prepare phonetically/domain-balanced scripts for the language.
4. Capture controlled recordings and quality metadata.
5. Segment, normalize and verify transcripts/pronunciation.
6. Fine-tune/train a commercially compatible voice architecture.
7. Evaluate naturalness, intelligibility, pronunciation, latency and stability.
8. Conduct native-speaker human review.
9. Register dataset/model lineage and rights evidence.
10. Publish only through the standard `VoiceProvider` and `StandardVoiceProfile` registry.

### 32.7 Adapter certification sequence

1. Document official/supported platform interface and prerequisites.
2. Build capability probe.
3. Map identity/timestamps.
4. Prove ingress.
5. Prove egress separately.
6. Prove join/leave/reconnect.
7. Prove no feedback loop.
8. Run language/latency tests.
9. Document unsupported capabilities.
10. Only then label adapter ready.

### 32.8 Codex Agent-Team Execution and Claude Reconciliation

For every milestone wave:

1. Codex verifies branch, HEAD and worktree.
2. Codex creates the wave plan and identifies independent work packages.
3. Codex assigns only the required specialist agents.
4. Each agent receives bounded ownership and acceptance tests.
5. Agents return diffs/evidence without committing unless explicitly allowed.
6. Codex reviews every result and corrects/rejects deviations.
7. Codex integrates in dependency order.
8. Codex runs focused tests, full required regression and visual QA.
9. Codex reconciles docs/ADRs with the integrated repository.
10. Codex prepares a handoff pack containing:
   - branch/HEAD;
   - exact changed files;
   - tests and results;
   - screenshots/evidence for UI work;
   - architecture decisions touched;
   - commercial/provider impacts;
   - known defects/deferred items.
11. Claude independently audits the integrated wave.
12. Claude reconciles defects and polish items within locked architecture, then reruns the required evidence.
13. The project owner decides final milestone closure/commit/merge progression.

For UI work, at least one implementation pass and one independent visual/interaction review must occur. The reviewer must inspect real rendered/browser states at representative desktop and mobile sizes.


## 33. Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| High conversational latency | Unnatural unusable calls. | Streaming endpointing, partial STT/translation, phrase TTS, acceleration, benchmarks. |
| Voice cloning abuse | Safety/legal/trust harm. | Live consent enrollment, revocation, secure storage, audit, no arbitrary third-party samples by default. |
| Platform API asymmetry | Can ingest but cannot return unique audio. | Separate ingress/egress capabilities; sidecar/bridge/partnership. |
| Media feedback | System retranscribes synthesized output. | Strict input/output bus isolation. |
| Session drift | Wrong or stale output. | One authority, revisions, stale rejection. |
| Conference compute explosion | Cost/capacity failure. | Deduplicate by target language; reuse standard TTS; backpressure. |
| Language quality inconsistency | Loss of trust. | Human acceptance corpus and model registry. |
| Development-only licence leaks into commercial runtime | Commercial/legal blocker. | Runtime profiles, machine-readable licence state, recursive fallback validation and fail-closed readiness. |
| Piper/other voice licence assumptions | A specific voice may be unusable commercially even if the engine is permissive. | Per-voice rights evidence; no family-wide licence assumptions. |
| Spanish-input STT gap | P6.1 reverse direction cannot work correctly. | Explicit multilingual-ASR prerequisite before P6.1 closure. |
| Male/Female voice catalogue incomplete | Locked voice-ready contract cannot be met. | Voice registry, provider sourcing and Videofy Voice Studio. |
| Training-data rights failure | Videofy-native model cannot be safely commercialized. | Dataset registry, rights/consent lineage, purpose restrictions and audit. |
| Customer media reused for training without proper consent | Trust/privacy/legal harm. | Training opt-in is separate from service consent; default is no training. |
| Native-model R&D consumes product roadmap | Delivery slows without commercial return. | Specialized staged model programme; product and R&D have separate gates. |
| Vendor dependency/cost escalation | Margin and strategic control degrade. | Provider interchangeability, local-commercial options and Videofy-native roadmap. |
| Platform policy changes | Adapter breakage. | Official interfaces, isolated adapters, periodic capability review. |
| Monorepo coupling | Deployment friction. | Strict package/service boundaries; split only when justified. |
| Unprotected main / weak CI governance | Regression or unreviewed changes reach baseline. | Required CI checks, protected release flow, milestone evidence and controlled merges. |
| Agent concurrency collision | Conflicting implementations or overwritten work. | Bounded ownership, one high-risk owner at a time, supervisor integration and independent verification. |
| Supervisor rubber-stamping workers | Defects are multiplied by automation. | Codex must inspect diffs/tests and correct or reject work before handoff. |
| Functional but weak/basic UI | Product looks unfinished despite strong backend. | P6-UX0 design system, premium reference screens, browser visual QA and experience acceptance gates. |
| UI clutter / engineering leakage | Users see irrelevant diagnostics and lose confidence. | Role-separated surfaces, progressive disclosure, protected diagnostics/admin routes and user-facing error translation. |
| Over-designed visual effects | Motion/depth reduce readability or media performance. | Media-first hierarchy, restrained motion, performance budgets and accessibility review. |
## 34. Architecture Decision Record

| ID | Decision | Status | Rationale |
| --- | --- | --- | --- |
| ADR-001 | One platform, modular services | Accepted | Shared core/contracts; separately deployable services; one monorepo initially. |
| ADR-002 | Videofy Live remains | Accepted | Programme product preserved and becomes shared-core consumer. |
| ADR-003 | Native Call before external adapters | Accepted | Proves engine without third-party ambiguity. |
| ADR-004 | Manual language authority | Accepted | Manual lock overrides auto-detect; auto-detect is assistive. |
| ADR-005 | Separate ingress/egress capability | Accepted | Do not assume external media read/write symmetry. |
| ADR-006 | Personal voice optional | Accepted | Never blocks joining/translation. |
| ADR-007 | Standard voice fallback is provider-agnostic | Accepted | Piper is current development implementation; the fallback contract survives provider changes. |
| ADR-008 | OpenVoice V2 prototype | Provisional | Evaluate behind provider boundary after dependency/licence/quality/security review. |
| ADR-009 | SIP/RTP enterprise gateway | Direction accepted | Enterprise/local-network telephony after core stabilizes. |
| ADR-010 | Media Bridge for closed platforms | Fallback accepted | Only where native/supported APIs are unavailable. |
| ADR-011 | Male/Female standard voice pair per language | Accepted | Every fully voice-ready language exposes at least one approved Male and one approved Female standard voice; personal voice falls back to the selected standard voice. |
| ADR-012 | Current AI infrastructure is development/demonstration locked | Accepted | Preserve the working local stack; do not confuse demonstration readiness with commercial deployment readiness. |
| ADR-013 | Commercial provider interchangeability | Accepted | STT/translation/TTS/voice providers can be replaced without changing media/session architecture. |
| ADR-014 | Videofy Intelligence native-AI programme | Accepted | Develop Videofy Speech, Translate, Voice and Language Lab progressively. |
| ADR-015 | Voice training/library is first-class capability | Accepted | Voice Studio and standard voice library address product identity and low-resource commercial TTS gaps. |
| ADR-016 | Dataset/model lineage is mandatory | Accepted | Training rights, dataset versions, parent models, runs and evaluations are traceable. |
| ADR-017 | Customer communication data is not training data by default | Accepted | Service consent and model-training consent are separate. |
| ADR-018 | Videofy-native models use the same provider contracts/gates | Accepted | No special architecture or weaker commercial/quality rules for models trained in-house. |
| ADR-019 | Progressive external-dependency reduction | Accepted | Replace external dependencies where Videofy-native quality, cost and coverage justify it; retain external providers when they are better. |
| ADR-020 | Commercial runtime fails closed | Accepted | Any non-commercial, unknown or non-production-approved primary/fallback makes the commercial profile not ready. |
| ADR-021 | Runtime profiles are explicit | Accepted | `development-demo`, `commercial-local`, `commercial-cloud` and `videofy-native` prevent licence/policy ambiguity. |
| ADR-022 | New translation contracts avoid legacy name collision | Accepted | Phase 6 uses collision-safe routed/canonical names and compatibility adapters. |
| ADR-023 | Current gateway VAD truth is energy fallback | Accepted current-state fact | Silero package presence is not equivalent to runtime integration; Silero remains future work until actually wired. |
| ADR-024 | Phase 6 uses current `main` baseline | Accepted | Old `2ada7a...` is historical; Phase 5 is merged and later hardening is part of the baseline. |
| ADR-025 | Commercial release requires protected/verified source-control flow | Accepted direction | Required CI checks and controlled release/merge policy must exist before commercial production. |
| ADR-026 | Codex Sol6 uses supervised agent-team execution | Accepted | Codex decomposes work, assigns bounded ownership, reviews/corrects workers and owns integration/evidence. |
| ADR-027 | Claude is independent reconciliation/closure auditor | Accepted | Claude audits Codex-integrated waves, reconciles defects and polishes without creating a competing architecture. |
| ADR-028 | Premium experience is an architecture requirement | Accepted | Public and user-facing Videofy surfaces must be grand, rich, media-first, responsive and commercially credible rather than basic developer UI. |
| ADR-029 | Internal engineering state is role-gated | Accepted | Model/provider IDs, raw diagnostics, worker health and transport detail stay in protected admin/developer surfaces. |
| ADR-030 | Progressive disclosure is mandatory | Accepted | Primary tasks dominate; advanced configuration and diagnostics appear contextually rather than creating permanent clutter. |
| ADR-031 | Shared Videofy design system | Accepted | Live, Call, Conference, listener, operator and admin products share tokens/components/interaction semantics while preserving role-specific information architecture. |
## 35. Audit Checklist

### 35.1 Architecture completeness

- [x] WHAT is defined: Live, Call, Conference, Voice, Connect, integrations and native-AI direction.
- [x] WHY is defined: avoid duplicate timelines, platform coupling, vendor lock and commercial licence traps.
- [x] HOW is defined: contracts, services, adapters, runtime profiles, registry, milestones, tests, training workflow and operations.
- [x] Current remote repository baseline is updated to `main` at `b4ac24e6...`.
- [x] Phase 5 is recognized as merged; old partner-preview commit is historical rather than authoritative.
- [x] Current development/demonstration AI infrastructure is explicitly preserved and classified.
- [x] Current gateway VAD is truthfully described as energy fallback; Silero is not falsely claimed as active there.
- [x] `sourceLanguageRevision` is recognized as already present/fixed.
- [x] Participant/session/media/language authority is explicit.
- [x] Auto-detect authority is bounded and the current `0.82` threshold is recorded as implementation truth.
- [x] Feedback-loop prevention is explicit.
- [x] External integration claims are capability-based.
- [x] Ingress/egress are independent capabilities.
- [x] Voice cloning is optional, consent-based and separately secured.
- [x] Male/Female standard voice policy is explicit and cannot be waived for full voice-ready status.
- [x] P6.1 reverse-direction prerequisites now include Spanish-capable STT, ES->EN translation, English target/TTS and EN/ES Male+Female voices.
- [x] Commercial runtime profiles and fail-closed fallback policy are explicit.
- [x] NLLB/MMS are explicitly development/demo-only for commercial policy.
- [x] Provider licensing and production quality/readiness are separate gates.
- [x] Videofy-native AI, Voice Studio, Language Lab and model lineage are defined.
- [x] Customer call/training consent separation is explicit.
- [x] Graceful degradation is specified.
- [x] Latency figures are labeled targets rather than guarantees.
- [x] Each Phase 6 milestone has an exit condition.
- [x] Platform/model claims are sourced or marked for re-verification.
- [x] New translation contracts avoid the existing legacy-name collision.
- [x] Codex supervised agent-team execution and correction responsibilities are explicit.
- [x] Claude independent audit/reconciliation/polish role is explicit.
- [x] Premium user experience is defined as an acceptance requirement.
- [x] Public, participant, listener, operator, admin and developer surfaces are separated.
- [x] Internal provider/model/worker/transport details are prevented from dominating ordinary user surfaces.
- [x] Progressive disclosure, responsive design and accessibility requirements are defined.
- [x] P6-UX0 experience foundation is integrated into Phase 6 sequencing.

### 35.2 Implementation gate

Before any implementation wave:

- confirm local branch/clean state against current remote `main`;
- read the relevant ADRs and this architecture version;
- freeze regression evidence for affected current behavior;
- define contracts before runtime authority movement;
- reject any design that adds a second AI pipeline;
- reject adapters that leak platform logic into AI providers;
- reject commercial fallback chains containing blocked/unknown assets;
- reject any training-data ingestion without rights/provenance metadata;
- do not let an implementation worker weaken the architecture to make its own tests pass;
- route architecture changes through supervisor/author approval.
- require Codex to inspect and correct delegated agent work before handoff;
- require independent Claude audit of the integrated wave before milestone closure;
- require browser-based visual QA for any changed user-facing surface;
- reject user-facing UI that exposes internal diagnostics without role/need justification.

### 35.3 Document audit outcome

This Version 3.0 update was checked for the following locked decisions before delivery:

- one-platform / modular-services structure;
- native multilingual call and conference;
- external integration through Videofy Connect;
- optional personal voice and Male/Female standard voices;
- current development/demo runtime preserved;
- commercial provider switching without media rewrite;
- fail-closed commercial licensing policy;
- Videofy-native AI growth strategy;
- Voice Studio and owned voice library;
- training-data consent/provenance;
- current repository baseline and current implementation gaps.
- supervised Codex agent-team execution and Claude closure workflow;
- premium visual/interaction architecture and internal-information separation.
## 36. References

External APIs, model licences and repository state are time-sensitive. The references below were checked for this Version 3.0 update on **14 August 2026**. They must be re-verified at implementation/commercial-certification time.

| Ref | Source | URL | Verified use in this blueprint |
| --- | --- | --- | --- |
| R1 | Videofy Live repository - `main` branch | https://github.com/masterzee001/videofy-live/tree/main | Current repository baseline and source structure. |
| R2 | Videofy README on current `main` | https://github.com/masterzee001/videofy-live/blob/main/README.md | Phase 1-5 completion statement, nine-language viewer catalogue and stated production limitations. |
| R3 | Videofy Model and Voice Registry | https://github.com/masterzee001/videofy-live/blob/main/docs/MODEL_AND_VOICE_REGISTRY.md | Current local models/voices and explicit NLLB/MMS non-commercial caution. |
| R4 | Videofy WebRTC transcription chunker | https://github.com/masterzee001/videofy-live/blob/main/services/realtime-gateway/src/webrtc-transcription-chunker.ts | Current gateway truth: requested Silero mode falls back to energy gate because Silero is not implemented there. |
| R5 | Videofy language controls | https://github.com/masterzee001/videofy-live/blob/main/services/media-ingest/src/language-controls.ts | Manual/auto language authority, revision changes and default `0.82` confidence threshold. |
| R6 | Videofy timestamped translation schema | https://github.com/masterzee001/videofy-live/blob/main/packages/media-contracts/src/timestamped-translation-schema.ts | `sourceLanguageRevision` is already present on current `main`. |
| R7 | Videofy AI runtime setup | https://github.com/masterzee001/videofy-live/blob/main/docs/AI_RUNTIME_SETUP.md | Validated `small.en` English ASR baseline and local provider setup. |
| R8 | Zoom Developer Docs - Realtime Media Streams | https://developers.zoom.us/docs/rtms/ | RTMS is a live-media data pipeline for supported Zoom products. |
| R9 | Zoom Developer Docs - meeting media | https://developers.zoom.us/docs/rtms/meetings/media/ | Meeting audio can be participant-separated/merged with timestamps/identifiers; implementation must verify exact current egress capability separately. |
| R10 | OpenVoice official repository | https://github.com/myshell-ai/OpenVoice | V2 zero-shot/cross-lingual voice cloning; native EN/ES/FR/ZH/JA/KO; official repo states MIT free commercial/research use. |
| R11 | Meta M2M100 418M model card | https://huggingface.co/facebook/m2m100_418M | Model card lists MIT licence and Yoruba among covered languages; quality remains a separate acceptance issue. |
| R12 | Google MADLAD-400-3B-MT model card | https://huggingface.co/google/madlad400-3b-mt | Model card lists Apache-2.0 and 400+ language coverage; candidate only until Videofy benchmarks quality/latency/resources. |
| R13 | Meta MMS Yoruba TTS model card | https://huggingface.co/facebook/mms-tts-yor | Current model card lists CC-BY-NC-4.0; blocked from commercial runtime. |
| R14 | Meta NLLB-200 distilled 600M model card | https://huggingface.co/facebook/nllb-200-distilled-600M | Current repository already records CC-BY-NC non-commercial restriction; re-check exact model card before commercial certification. |
| R15 | KingsConference official product site | https://kingsconference.app/ | Browser-based conference product. No public developer media API is assumed; deep integration remains partnership/API discovery. |
| R16 | KingsConference official help center | https://kingsconference.app/help-center | Meeting/recording/screen-sharing/browser workflows relevant to integration discovery. |

### 36.1 External-source and licence-control policy

Before implementing or certifying any external adapter, model or voice:

1. Re-check the official developer/model/voice source and terms.
2. Record exact model/service/version/revision and verification date.
3. Archive licence/contract evidence in the registry or compliance evidence store.
4. Distinguish code licence, model-weight licence, voice/dataset rights and cloud-service contractual terms.
5. Probe platform capabilities programmatically where available.
6. Prove ingress and egress independently.
7. Test quality/latency rather than treating licence compatibility as technical approval.
8. Treat undocumented behavior as unsupported until confirmed.
9. Never design a production dependency around an unofficial/private interface merely because a local experiment works.
10. Never allow a commercial profile to resolve an asset whose rights/readiness state is unknown.
## 37. Glossary

| Term | Meaning |
| --- | --- |
| Adapter | Maps an external communication system to/from Videofy contracts. |
| Canonical transcript | Authoritative text of one participant utterance before recipient-specific translation. |
| Commercial-local | Runtime profile using only commercially approved self-hosted/local assets. |
| Commercial-cloud | Runtime profile using only commercially approved cloud/service providers. |
| CommercialUseState | Registry field separating approved, blocked, review-required and internal-only assets. |
| Development-demo | Locked local R&D/demonstration runtime that may contain explicitly non-commercial assets. |
| Egress | Media/events sent from Videofy to a client or external platform. |
| Ingress | Media/events entering Videofy. |
| Language revision | Revision incremented when confirmed language authority changes. |
| Media revision | Revision incremented when media source is replaced/reconnected. |
| Media Bridge | Virtual-device/OS integration for systems without suitable native media APIs. |
| Model lineage | Trace from parent model, training code/run and datasets through evaluation and release. |
| ParticipantMedia | Normalized representation of one participant media source and capabilities. |
| Personal voice | Consent-based synthesized voice intended to preserve one participant's vocal identity; private/authorized scope. |
| ProviderResolver | Policy component selecting only providers/assets allowed by capability, runtime profile and readiness. |
| Recipient Router | Policy/service deciding what each participant hears and sees. |
| RoutedTranslationEvent | Phase 6 collision-safe translation event intended for recipient routing; avoids incompatible legacy `TranslationEvent` naming. |
| RTMS | Zoom Realtime Media Streams. |
| SFU | Selective Forwarding Unit for routing real-time media at conference scale. |
| SIP/RTP | Common VoIP signaling/media standards. |
| Standard voice | Shared product voice from the approved Male/Female catalogue for a language. |
| Videofy Connect | SDK/API/adapter layer for external integration. |
| Videofy Live Viewer | The audience-facing page for a programme: video, translated captions, language choice and audio mode. The product name for what the repository calls `listener-web`. |
| Videofy Intelligence | Native AI programme spanning Speech, Translate, Voice, Context Engine, Teacher Network, Learning Engine and Model Registry. A learning system, not a set of future models (§21.9.1). |
| Teacher | A model or human whose output can train or evaluate a Videofy native model, subject to explicit training rights (§21.9.2). |
| Videofy Language Lab | Rights/provenance-controlled datasets and evaluation corpora for native AI development. |
| Videofy Voice | Male/Female standard voices for every fully voice-ready language plus optional personal translated voice subsystem. |
| Videofy Voice Studio | Internal workflow/tooling for rights-cleared voice recording, training, evaluation and library publication. |
| Videofy-native | Models/assets trained or controlled by Videofy but still subject to the same commercial/quality/security release gates. |


---

**ONE PLATFORM - ONE LANGUAGE ENGINE - MANY COMMUNICATION SYSTEMS**

*Speak naturally in your language. Hear and read everyone in yours.*
