# ADR-004 — Commercial providers fail closed

Repository owner: masterzee001

**Status:** Accepted  
**Covers:** ADR-012, ADR-020

The current AI infrastructure is development/demonstration locked and is preserved as such. Commercial readiness fails closed: a non-commercial, unknown, or non-production-approved primary **or fallback** makes a commercial profile not ready. There is no warning-only commercial mode and no hidden fallback path around the policy.

NLLB-200 and MMS-TTS are `blocked-noncommercial` and remain development/demo only; they must not be removed merely to tidy the licence table. Every exact model/voice requires registry evidence for provider, version, licence, commercial-use state, approval, quality, latency and fallback. This is an architectural classification, not legal advice.

See [runtime profiles](005-runtime-profiles.md).
