# ADR-010 — Premium, role-separated experience and internal-information boundary

Repository owner: masterzee001

**Status:** Accepted  
**Covers:** ADR-028, ADR-029, ADR-030, ADR-031

Premium experience is an architecture requirement. Public and user-facing Live, Call, Conference and listener surfaces are rich, media-first, responsive and commercially credible—not developer dashboards. A shared Videofy design system supplies reusable tokens, components and interaction semantics while retaining role-specific information architecture.

Internal model/provider IDs, raw diagnostics, worker health, transport details, licence flags and infrastructure state remain in protected operator/admin/developer surfaces unless actionability requires disclosure. Progressive disclosure keeps primary tasks dominant and reveals advanced controls or diagnostics contextually.

Experience acceptance includes role-appropriate visual quality; it does not weaken privacy, consent, readiness, provenance or media/session controls.
