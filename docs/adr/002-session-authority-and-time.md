# ADR-002 — Session authority, revision axes and one media clock

Repository owner: masterzee001

**Status:** Accepted governance constraint

Every programme or participant source belongs to exactly one authoritative session and one media clock. Video, original audio, transcript, translation, captions and generated audio share that timebase. Generated audio is playback-only and never enters STT.

`mediaRevision` changes when media is replaced or reconnected; `languageRevision` changes when confirmed language authority changes; signaling/session revision is a separate control-plane concern. Consumers reject stale, duplicate, or out-of-order results by the applicable revision and sequence. Clients do not invent internal revision values. `sourceLanguageRevision` already exists and is not to be reworked as an unfixed defect.

This records the §28 extraction rule: add contracts without moving runtime authority.

**P6.0 implementation note (2026-08-14):** `participant-contracts` now defines canonical
participant/session identifiers, media and language revisions, raw-only participant media, and a
shared millisecond media-clock descriptor. `call-contracts` composes those definitions; it does not
redeclare or replace the Phase 5 gateway/media-ingest session authority. Runtime authority remains
where it was until a separately approved native-call milestone.
