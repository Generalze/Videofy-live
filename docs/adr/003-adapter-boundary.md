# ADR-003 — Adapter boundary and independent ingress/egress

Repository owner: masterzee001

**Status:** Accepted  
**Covers:** ADR-005, ADR-009, ADR-010, ADR-013, ADR-022, ADR-023

Adapters normalize external systems into Videofy contracts; core media/session and AI providers remain platform-agnostic. Ingress and egress are independent capabilities and must be proven separately. SIP/RTP is an enterprise direction after core stability; Media Bridge is a fallback only where supported/native APIs are unavailable.

Commercial STT, translation, TTS and voice providers remain interchangeable behind provider contracts. New Phase 6 translation contracts use collision-safe routed/canonical names with compatibility adapters. Current gateway VAD truth is energy fallback; Silero is future work until wired.

Adapter readiness requires the §32.7 sequence, including official-interface documentation, capability probe, identity/timestamp mapping, separate ingress and egress proof, reconnect and feedback-loop proof, tests, and documented limits.
