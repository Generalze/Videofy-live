/** @owner masterzee001 */
import { z } from 'zod';
import { WEBRTC_SIGNALLING_LIMITS } from '@videofy-live/shared-types';

/**
 * Gateway acceptance schemas for every client->server `call:*` payload,
 * extracted from call-runtime.ts's hand-rolled checks (P6.5, R3).
 *
 * BEHAVIOR-PRESERVING BY CONTRACT: each schema accepts exactly what the check
 * it replaced accepted, byte for byte of observable behavior. Where zod's
 * natural idiom is stricter than the legacy check, the schema is LOOSENED to
 * match the legacy check and the loosening is noted on the schema. Tightening
 * any of these is a wire change: it needs its own wave, with the deployed
 * clients in mind, never a drive-by cleanup.
 *
 * Two rules the schemas deliberately do NOT own:
 * - Binding equality (payload callId/participantId vs the socket's binding)
 *   is the runtime's check — only the runtime knows the binding.
 * - Join field validation is the call-session store's — its user-facing
 *   messages are part of the ack contract.
 */

/**
 * The legacy object guard `!raw || typeof raw !== 'object'`, as a schema.
 * z.object() would refuse arrays; the legacy guard does not, so a custom
 * check keeps the acceptance set identical. The value passes through by
 * reference — no clone — exactly like the check this replaces.
 */
export const CallWireObjectSchema = z.custom<Record<string, unknown>>(
  (value): value is Record<string, unknown> => value !== null && typeof value === 'object',
);

/**
 * `typeof value === 'number'` as a schema: NaN and Infinity pass, exactly
 * like the legacy reads (z.number() would refuse NaN).
 */
const WireNumberSchema = z.custom<number>((value): value is number => typeof value === 'number');

/**
 * call:join. LOOSENED (deliberate): object-ness is the ONLY gateway-side
 * check, as before — the store is the single validation/auth authority for
 * every join field (including resume credentials), and its specific rejection
 * messages are part of the ack contract. Field-level zod here would intercept
 * payloads the store currently answers with its own wording.
 */
export const CallJoinPayloadSchema = CallWireObjectSchema;

/**
 * Every bound event's payload names the sender's own callId/participantId.
 * LOOSENED (deliberate): the schema checks only object-ness (the legacy
 * guard); the runtime compares the ids against the socket's binding, which
 * is what actually rejects arrays and impersonation alike.
 */
export const CallBoundPayloadSchema = CallWireObjectSchema;

/**
 * call:caption-language. LOOSENED (deliberate): any string passes — the store
 * owns the language vocabulary and the 'unsupported-language' answer.
 */
export const CallCaptionLanguagePayloadSchema = z
  .object({ hearLanguage: z.string() })
  .passthrough();

/**
 * call:audio-mode:set. LOOSENED (deliberate): z.string(), not the
 * CallAudioMode enum — the gateway forwarded any string and the store's
 * 'invalid-audio-mode' answer (with its own ack wording) is the contract for
 * out-of-vocabulary values.
 */
export const CallAudioModePayloadSchema = z.object({ audioMode: z.string() }).passthrough();

/** call:transcript-policy:set. */
export const CallTranscriptPolicyPayloadSchema = z
  .object({ allowed: z.boolean() })
  .passthrough();

/**
 * call:mode:set. The one enum enforced gateway-side: the legacy handler
 * refused out-of-vocabulary modes itself ('invalid-mode') before the store.
 */
export const CallSetModePayloadSchema = z
  .object({ mode: z.enum(['normal', 'translated']) })
  .passthrough();

/**
 * call:publish:offer / call:receive:offer. Same size limit as programme
 * signalling; empty refused.
 */
export const CallSdpPayloadSchema = z
  .object({ sdp: z.string().min(1).max(WEBRTC_SIGNALLING_LIMITS.sdpMaxLength) })
  .passthrough();

/**
 * Legacy readCandidate semantics, all of them: the candidate string is the
 * only hard requirement (non-empty, size-limited); wrong-typed sdpMid /
 * sdpMLineIndex COERCE to null rather than refusing (`.catch`, matching the
 * legacy ternaries); usernameFragment survives only as a string and is
 * `undefined` otherwise (the runtime spreads it conditionally); unknown keys
 * are dropped, as the legacy rebuild dropped them.
 */
/** The exact shape legacy readCandidate returned; what the ICE schemas emit. */
export interface CallWireNormalizedIceCandidateInit {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string;
}

export const CallIceCandidateInitSchema = z
  .object({
    candidate: z.string().min(1).max(WEBRTC_SIGNALLING_LIMITS.iceCandidateMaxLength),
    sdpMid: z.string().nullable().catch(null),
    sdpMLineIndex: WireNumberSchema.nullable().catch(null),
    usernameFragment: z.string().optional().catch(undefined),
  })
  // The legacy rebuild OMITTED usernameFragment when it was not a string; a
  // present-but-undefined key would also fail exactOptionalPropertyTypes at
  // every consumer, so the transform reproduces the omission.
  .transform(
    ({ candidate, sdpMid, sdpMLineIndex, usernameFragment }): CallWireNormalizedIceCandidateInit => ({
      candidate,
      sdpMid,
      sdpMLineIndex,
      ...(usernameFragment !== undefined ? { usernameFragment } : {}),
    }),
  );

/** call:publish:ice / call:receive:ice (client->server). A null candidate is refused, as before. */
export const CallIcePayloadSchema = z
  .object({ candidate: CallIceCandidateInitSchema })
  .passthrough();

/**
 * call:video:offer / call:video:answer. targetParticipantId membership in the
 * sender's call is the runtime's check, not the schema's — the lookup must
 * never leave the sender's own call.
 */
export const CallVideoSdpPayloadSchema = z
  .object({
    targetParticipantId: z.string(),
    sdp: z.string().min(1).max(WEBRTC_SIGNALLING_LIMITS.sdpMaxLength),
  })
  .passthrough();

/** call:video:ice. null candidate = end-of-candidates marker, relayed as such. */
export const CallVideoIcePayloadSchema = z
  .object({
    targetParticipantId: z.string(),
    candidate: CallIceCandidateInitSchema.nullable(),
  })
  .passthrough();

/**
 * INTERNAL INSTRUMENTATION — call:capture-settings (W1). `settings` is
 * recorded exactly as reported — provenance, never validated — so it only has
 * to BE an object (arrays included, per the legacy guard). `reason` and
 * `requestedCaptureProfile` keep the legacy coercions rather than refusing:
 * an unrecognised profile name is a corpus provenance question, and rewriting
 * it would destroy the evidence.
 */
export const CallCaptureSettingsPayloadSchema = z
  .object({
    settings: CallWireObjectSchema,
    requestedCaptureProfile: z.string().nullable().catch(null),
    reason: z.enum(['join', 'device-change']).catch('join'),
  })
  .passthrough();

/**
 * INTERNAL INSTRUMENTATION — call:playback (W4). Every field keeps its legacy
 * coercion — a malformed report was never refused, it degraded field by
 * field. atMs keeps `typeof === 'number'` semantics (NaN survives: the
 * transcript log records the client's clock verbatim; the ledger's finite
 * check stays beside the ledger call in the runtime).
 */
export const CallPlaybackPayloadSchema = z
  .object({
    stream: z.enum(['generated', 'remote-original']).catch('generated'),
    clipId: z.string().nullable().catch(null),
    phase: z.enum(['start', 'end']).catch('start'),
    atMs: WireNumberSchema.nullable().catch(null),
  })
  .passthrough();
