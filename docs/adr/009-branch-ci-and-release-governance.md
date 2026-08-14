# ADR-009 — Branch, CI and release governance

Repository owner: masterzee001

**Status:** Accepted direction  
**Covers:** ADR-024, ADR-025, ADR-026, ADR-027

Phase 6 uses the current `main` baseline; historical baseline references are not the active truth. Changes reach `main` through focused pull requests owned by `masterzee001`. Before commercial launch, repository settings must protect `main`, reject force pushes and deletion, require current review, require resolution of review conversations, and require the repository CI check.

CI must run TypeScript tests, lint, type-check, build, Python worker tests, and the cross-process integration smoke. Releases are cut only from a green protected `main` through an owner-authorized release workflow; a tag or version label is evidence of a release, not a substitute for milestone acceptance evidence.

Codex Sol6 executes supervised, bounded agent-team work: it decomposes, reviews, corrects and owns integration evidence. Claude provides independent reconciliation/closure audit without creating a competing architecture. This governance does not authorize code changes beyond an approved work order.

For P6-G0, ratify governance and preserve the development-demo stack; no runtime-authority change occurs. GitHub branch-protection settings are external state and remain an explicit `masterzee001` action before commercial release.
