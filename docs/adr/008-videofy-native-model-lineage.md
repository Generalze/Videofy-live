# ADR-008 — Videofy-native model lineage

Repository owner: masterzee001

**Status:** Accepted  
**Covers:** ADR-014, ADR-018, ADR-019

Videofy Intelligence progressively develops Speech, Translate, Voice and Language Lab. A Videofy-native model uses the same provider contracts and commercial, quality, provenance and production gates as any external provider; it receives no special architecture or weaker rule.

Every native release records parent/base model and licence, training code/version, run ID, dataset versions and rights state, hyperparameters/hardware, language/domain evaluations, known limitations, approval and rollback. External dependencies may be replaced only where native quality, cost and coverage justify it; better external providers may remain.

Native R&D proceeds in parallel and does not block product delivery or change runtime authority in P6-G0.
