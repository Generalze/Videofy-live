# P6.1B Native Two-Person Call Runtime — Implementation Report

- **Repository owner:** masterzee001
- **Date:** 2026-08-14
- **Milestone:** P6.1B — Native two-person call runtime (development profile)
- **Implementation status:** Complete and machine-verified at the unit/integration level;
  P6.1C (real two-browser acceptance, latency evidence, video, human review) remains open
- **Baseline:** `main@25a84a1` (P6-G0, P6.0, and P6.1A merged and CI-verified)
- **Execution:** Acting-lead Claude supervision with a bounded agent team (session, frontend,
  runtime, and independent-review agents) per §32.8, on the owner's standing instruction while
  Codex Sol6 was unavailable. Design decisions are locked in
  [P6_1B_CALL_RUNTIME_DESIGN.md](P6_1B_CALL_RUNTIME_DESIGN.md).

## Outcome

Two browsers can join a native Videofy call at `apps/call-web` (port 5175): each participant
selects the language they speak, the language they hear, a Male/Female standard voice, captions,
and an audio mode. Each raw microphone feeds the existing gateway backend-peer → transcription
bridge → media-ingest pipeline as its own `call_`-prefixed session (no second AI pipeline);
translated captions and generated voice come back recipient-scoped, and each participant hears
the other's original audio through a per-call receive peer with mix-mode ducking. The Phase 5
programme runtime is untouched: call events are intercepted before every programme broadcast
path and the full legacy regression suite stays green.

## Delivered components

| Component | Content | Tests |
| --- | --- | --- |
| `services/call-session` | Pure call/participant core: two-person registry, manual-locked languages, resume authenticated by private tokens, revision-scoped ingest plans with membership-change bumps, recipient-gender voice map, stale-rejecting caption/audio routing, sanitized snapshots | 50 |
| `services/realtime-gateway` call runtime | `call:*` socket handlers with rejection guards and coded failure acks, participant-stable publish peers with frame-time ingest indirection, revision-scoped ingest registry with old-id retirement and media-ingest deletion, disconnect grace reaper, recipient-room event interception, per-call RTCAudioSink→RTCAudioSource original-audio bus, `call_` programme-id rejection | 38 new (145 total gateway) |
| `services/media-ingest` | Per-session `voiceIdsByLanguage` TTS override (endpoint → session → generation), `call_` session-prefix support with reserved-prefix upload rejection, unsafe-value rejection | 258 suite incl. new override test |
| `apps/call-web` | Pre-join (name/call code/languages/voice/captions/audio mode), call stage with null-safe speaker-attributed captions, translated-audio queue (playback-only), mix modes with ducking, sessionStorage reload-resume with private tokens and code-aware credential retention, mute/leave with guaranteed mic release | 68 |

## Verification (final integrated run)

| Gate | Result |
| --- | --- |
| `npm test` (12 workspaces) | Passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npm run test:integration` | Passed |
| speech-worker `pytest` | 23 passed |
| Independent adversarial review of the whole wave | Recorded before landing; see findings section |

## Architecture invariants held

- **No second AI pipeline (§28.4):** calls reuse the programme providers through per-participant
  media-ingest WebRTC sessions.
- **Feedback isolation (§13):** the browser publishes only the raw microphone track; generated
  audio is URL-playback only; the gateway fan-out never feeds frames back into the bridge or the
  speaker's own receive peer.
- **Recipient personalization (§6):** captions/generated audio are emitted only to
  `call:{callId}:participant:{id}` rooms; the recipient's Male/Female choice selects the actual
  Piper voice used for their direction.
- **Revision safety (§8.3):** resume bumps mediaRevision, recreates the ingest session at the new
  revision, and the store rejects stale events.
- **Collision safety:** `call:*` events, `call_`/`callcast_` ids; programme/operator/language
  rooms never see call traffic and vice versa.
- **Role-appropriate surfaces (§5.1):** call-web renders no provider, model, session-id, or
  revision internals; call ids are constrained to a safe charset end-to-end.

## Adversarial review and correction round

The first integrated build passed every automated gate but the independent adversarial review
returned **REJECT** with verified findings: a same-language caption null-crash in call-web
(BLOCKER), a structural bypass of revision/stale safety during resume, unbounded seat/state
leakage on tab close plus reload lockout, an unauthenticated resume takeover, a deferred-stop
race that could kill a replacement ingest session, stale voice-gender application, a bridge
session-map leak, `call_` id squatting from programme paths, unhandled promise rejections, and
three client hygiene defects. The lead prescribed the correction design and the same agents
implemented it:

- **Revision-scoped ingest identity** (`..._r{mediaRevision}`) with registry rekeying and
  explicit old-id retirement — stale events and deferred stops are structurally inert.
- **Membership-change revision bumps** — every join/resume recreates all connected speakers'
  ingest sessions with the current recipient set and voice choices.
- **Private resume tokens** issued only in the join ack; all auth failures are byte-identical;
  tokens never appear in snapshots, room emissions, logs, or UI; call-web persists credentials in
  sessionStorage so page reloads resume instead of locking the user out.
- **Disconnect grace reaper** (default 120 s, injectable) frees abandoned seats and returns all
  maps/counts to baseline.
- **Frame-time ingest indirection** over participant-stable publish peers — membership changes
  redirect the next audio frame into the new-revision bridge context with zero renegotiation.
- **Guarded handlers**, bridge `cleanupClosedSessions()` on stop paths, `call_` prefix rejection
  on both programme entry points, null-safe captions with revision-aware ordering, and mic
  release on every failed-join path.

The focused re-review returned **APPROVE-WITH-CORRECTIONS** (all eleven findings resolved) with
two required follow-ups, both closed before landing: retired call sessions are now deleted from
media-ingest through a guarded internal endpoint restricted to `call_` ids (no session/disk
accumulation from membership churn), and join-failure acks carry a machine-readable code so the
client clears stored resume credentials only when the seat is truly gone. Accepted residuals are
recorded in the design note: up to one in-flight chunk of the other speaker's speech is dropped
at each membership-change boundary, and a new tab/browser cannot resume a seat before the grace
reaper frees it.

Earlier supervisor corrections during the build wave: call-session `callId` validation tightened
to `[A-Za-z0-9_-]{1,64}`; `safeSessionOutputDir` deliberately extended with the `call_` prefix
(same fixed-prefix + safe-charset property as `ps_`/`wrs_`).

## Known limitations (documented in code, accepted for this wave)

- Brief resume window in which a late old-revision event could be stamped with the new revision;
  the store still drops it once revisions move, and media-ingest's own revision replacement
  bounds the window.
- A voice-gender change on resume applies to the other speaker's ingest session at its next
  revision bump, not retroactively.
- Solo-participant ingest sessions are deferred until a second participant joins (no translation
  targets exist yet); same-language pairs use a synthetic other-language target so transcription
  and captions still flow.
- Ducking uses element-volume driven by speech-active signals; Web-Audio ramp polish goes with
  P6.1C.

## Explicitly open for P6.1C / owner closure

- Real two-device/two-browser acceptance evidence (§30.4 sign-off table) and honest end-to-end
  latency measurement.
- Camera video tiles.
- Human quality review (voices remain `qualityStatus=development`; P6.1A owner gates unchanged).
- Owner approval; no milestone closure is claimed by this report.
