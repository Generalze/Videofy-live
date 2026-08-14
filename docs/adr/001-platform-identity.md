# ADR-001 — One platform, modular services

Repository owner: masterzee001

**Status:** Accepted  
**Covers:** ADR-001, ADR-002, ADR-003, ADR-004

Videofy is one platform with shared core contracts and separately deployable services, initially in one monorepo. Videofy Live remains a permanent shared-core consumer; Native Call proves the engine before external adapters. Manual locked language is authoritative and auto-detect is assistive only.

Phase 6 extraction preserves current behaviour: no second AI pipeline, no platform ID as a universal participant ID, and no movement of runtime authority during P6-G0.

See [session authority](002-session-authority-and-time.md) and [adapter boundary](003-adapter-boundary.md).
