# ADR-005 — Explicit AI runtime profiles

Repository owner: masterzee001

**Status:** Accepted  
**Covers:** ADR-021

Provider selection is constrained by an explicit runtime profile:

- `development-demo` — preserves the current local stack; development-only assets may be used.
- `commercial-local` — only approved commercial local assets and fallbacks.
- `commercial-cloud` — only approved commercial cloud assets and fallbacks.
- `videofy-native` — only Videofy-native assets that pass the same provider, rights, quality and production gates.

Profiles prevent licence and policy ambiguity. They do not create a second media pipeline or alter session authority. A commercial profile cannot reach NLLB/MMS or any other non-commercial, unknown, or unapproved asset through fallback.

During P6-G0, media-ingest accepts only `development-demo`. Selecting another profile fails startup until a complete provider route is explicitly configured and passes registry validation; a profile name alone can never promote the current stack.
