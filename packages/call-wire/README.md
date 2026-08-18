# @videofy-live/call-wire

PRIVATE internal wire contract for the native call plane (`call:*` Socket.IO
events). Single source of truth since P6.5: the gateway runtime
(`services/realtime-gateway/src/call-runtime.ts`) imports event names and
payload validation from here, and `apps/call-web`'s `callTypes.ts` retires its
hand-maintained mirror in favour of re-exports from this package.

This package is NOT a public SDK surface. Public SDKs wrap it and must never
re-export event names, revision counters, slots, or resume tokens.

## What lives here

- `CALL_EVENTS` — the `call:*` event names, byte-identical to the values the
  gateway has always used. The test suite pins every name against a literal
  table; renaming a value is a wire protocol break.
- zod schemas for every client->server payload (`wire-schemas.ts`) — the
  gateway's acceptance authority.
- TypeScript types for client->server payloads (nominal shapes),
  server->client payloads, and acks (`wire-types.ts`).

## Behavior-preservation contract (P6.5 R3)

The schemas were extracted from the gateway's hand-rolled `typeof` checks and
accept exactly what those checks accepted. Where zod's natural idiom is
stricter, the schema is deliberately LOOSENED to match legacy behavior:

| Schema | Loosening kept from the legacy check |
| --- | --- |
| `CallJoinPayloadSchema` | Object-ness only (arrays included). The call-session store is the single validation authority for join fields; its rejection wording is part of the ack contract. |
| `CallBoundPayloadSchema` | Object-ness only. Binding equality (callId/participantId vs the socket's binding) is the runtime's check. |
| `CallCaptionLanguagePayloadSchema` | `hearLanguage` is any string; the store owns the language vocabulary. |
| `CallAudioModePayloadSchema` | `audioMode` is any string, not the enum; the store answers 'invalid-audio-mode'. |
| `CallIceCandidateInitSchema` | Wrong-typed `sdpMid`/`sdpMLineIndex` coerce to `null` instead of refusing; `usernameFragment` survives only as a string; NaN passes the number read. |
| `CallCaptureSettingsPayloadSchema` | `settings` is recorded as reported, never validated; `reason`/`requestedCaptureProfile` coerce instead of refusing. |
| `CallPlaybackPayloadSchema` | Every field coerces (`stream`/`phase`/`clipId`/`atMs`); a malformed report degrades field by field, it is never refused. |

Tightening any schema is a wire change and needs its own wave with deployed
clients in mind — never a drive-by cleanup.

## Internal instrumentation events

`CAPTURE_SETTINGS` (`call:capture-settings`, W1 capture provenance) and
`PLAYBACK` (`call:playback`, W4 loudspeaker ledger) are INTERNAL
instrumentation: acoustic-forensics plumbing with no product behavior. They
are part of this private contract so the gateway and call-web agree on them,
but they must never appear in a public SDK's typings, docs, or events.

## Reserved fields

`CallJoinPayload.connectToken` is reserved for P6.5 wave 2 (Videofy Connect
joins). The wave-1 gateway strips it before the store sees it and attaches no
meaning to it.
