# ADR-006 — Standard voice rights and truthful readiness

Repository owner: masterzee001

**Status:** Accepted, except ADR-008 remains Provisional  
**Covers:** ADR-006, ADR-007, ADR-008, ADR-011, ADR-015

Personal voice is optional and never blocks joining or translation. Standard-voice fallback is provider-agnostic; Piper is the current development implementation, but each voice needs its own rights review. OpenVoice V2 remains a provider-bound prototype pending dependency, licence, quality and security review.

A language is fully voice-ready only when validated, approved Male and Female standard voices exist. A personal-voice failure immediately falls back to the participant's selected standard Male/Female voice. Voice Studio and the standard voice library are first-class capabilities, with standard rights-cleared reusable voices kept separate from private personal voices.

The machine registry reconciles the identity/licence fields in §21.4 with §14.3.1 by also requiring `modelRevision`, `runtimeStatus` and deterministic `fallbackPriority`. Its `unvalidated`/`development`/`accepted` quality values correspond to §14.3.1's `unverified`/`experimental`/`approved` maturity. Development readiness requires verified rights, accepted quality and validated runtime; commercial readiness additionally requires approved commercial use and production approval.

Enrollment requires explicit opt-in, identity assurance, limited purpose, protected storage, audit, immediate disable-to-standard-voice, and verifiable deletion. No reusable embedding is exposed to ordinary clients.
