/** @author masterzee001 */
/**
 * Request/response contracts for every /v1 endpoint.
 *
 * All object schemas are strict: an unrecognised key is a refusal
 * (INVALID_REQUEST), not a warning, so a partner discovers a typo on the first
 * request instead of in production. Responses are strict too — the server
 * asserting its own output is what keeps accidental surface growth out of v1.
 */
import { z } from 'zod';
import { PublicCallIdSchema } from './identifiers.js';
import {
  AudioModeSchema,
  CallModeSchema,
  CallTypeSchema,
  LanguageTagSchema,
  VoiceGenderSchema,
} from './enums.js';

export const CONNECT_API_BASE_PATH = '/v1';

/** Correlation header: accepted inbound, always present on responses. */
export const REQUEST_ID_HEADER = 'X-Request-Id';
/** POST replay guard: same key + same body replays; same key + new body refuses. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export const JOIN_TOKEN_DEFAULT_TTL_SECONDS = 300;
/** R6: hard ceiling — requests above it are refused, never clamped. */
export const JOIN_TOKEN_MAX_TTL_SECONDS = 900;

export const CALL_METADATA_MAX_BYTES = 1024;
export const DISPLAY_NAME_MAX_LENGTH = 80;
export const SUBJECT_MAX_LENGTH = 128;

export const IsoDateTimeSchema = z.string().datetime().describe('UTC ISO-8601 timestamp.');

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Opaque partner data, echoed back verbatim. The cap is on SERIALIZED UTF-8
 * BYTES, not characters: the limit exists to bound storage and echo cost, and
 * multibyte text would dodge a character count.
 */
export const CallMetadataSchema = z
  .record(z.unknown())
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= CALL_METADATA_MAX_BYTES, {
    message: `metadata must serialize to at most ${CALL_METADATA_MAX_BYTES} bytes of JSON`,
  })
  .describe(
    `Opaque partner-supplied JSON object, echoed back verbatim; serialized size is capped at ${CALL_METADATA_MAX_BYTES} bytes.`,
  );
export type CallMetadata = z.infer<typeof CallMetadataSchema>;

/** R8: partner-supplied stable identity. Opaque — Videofy never interprets it. */
export const SubjectSchema = z
  .string()
  .min(1)
  .max(SUBJECT_MAX_LENGTH)
  .describe('Partner-supplied stable identity for the participant; opaque to Videofy.');
export type Subject = z.infer<typeof SubjectSchema>;

/** Surrounding whitespace is dropped before length rules apply (store parity). */
export const DisplayNameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH);
export type DisplayName = z.infer<typeof DisplayNameSchema>;

/**
 * R8: Videofy-minted per-participation identity, distinct from `subject` and
 * never interchangeable with it. Validated structurally only — its internal
 * format is not part of this contract.
 */
export const ConnectParticipantIdSchema = z.string().min(1).max(64);
export type ConnectParticipantId = z.infer<typeof ConnectParticipantIdSchema>;

export const CreateCallRequestSchema = z
  .object({
    type: CallTypeSchema,
    mode: CallModeSchema,
    metadata: CallMetadataSchema.optional(),
  })
  .strict();
export type CreateCallRequest = z.infer<typeof CreateCallRequestSchema>;

/** Response body for POST /v1/calls, GET /v1/calls/:id, PATCH, and POST .../end. */
export const CallResourceSchema = z
  .object({
    callId: PublicCallIdSchema,
    type: CallTypeSchema,
    mode: CallModeSchema,
    createdAt: IsoDateTimeSchema,
    metadata: CallMetadataSchema.optional(),
    ended: z.boolean().optional(),
  })
  .strict();
export type CallResource = z.infer<typeof CallResourceSchema>;

export const CallParticipantStateSchema = z
  .object({
    participantId: ConnectParticipantIdSchema,
    subject: SubjectSchema,
    displayName: DisplayNameSchema,
    speakLanguage: LanguageTagSchema,
    hearLanguage: LanguageTagSchema,
    connected: z.boolean(),
  })
  .strict();
export type CallParticipantState = z.infer<typeof CallParticipantStateSchema>;

export const CallStateResponseSchema = z
  .object({
    callId: PublicCallIdSchema,
    type: CallTypeSchema,
    mode: CallModeSchema,
    participants: z.array(CallParticipantStateSchema),
  })
  .strict();
export type CallStateResponse = z.infer<typeof CallStateResponseSchema>;

/**
 * Defaults mirror the P6.4 first-party client, so a Connect participant whose
 * partner states no preference behaves identically to a native one.
 * voiceGender 'female' is the locked P6.4 default.
 */
export const JoinParticipantRequestSchema = z
  .object({
    subject: SubjectSchema,
    displayName: DisplayNameSchema,
    speakLanguage: LanguageTagSchema,
    hearLanguage: LanguageTagSchema,
    audioMode: AudioModeSchema.default('translated'),
    captionsEnabled: z.boolean().default(true),
    voiceGender: VoiceGenderSchema.default('female'),
  })
  .strict();
export type JoinParticipantRequest = z.infer<typeof JoinParticipantRequestSchema>;

/** The echo is fully resolved: every default the server applied is visible. */
export const JoinParticipantEchoSchema = z
  .object({
    subject: SubjectSchema,
    displayName: DisplayNameSchema,
    speakLanguage: LanguageTagSchema,
    hearLanguage: LanguageTagSchema,
    audioMode: AudioModeSchema,
    captionsEnabled: z.boolean(),
    voiceGender: VoiceGenderSchema,
  })
  .strict();
export type JoinParticipantEcho = z.infer<typeof JoinParticipantEchoSchema>;

export const JoinTokenRequestSchema = z
  .object({
    participant: JoinParticipantRequestSchema,
    expiresInSeconds: z
      .number()
      .int()
      .min(1)
      .max(JOIN_TOKEN_MAX_TTL_SECONDS)
      .optional()
      .describe(
        `Token lifetime in seconds; server default ${JOIN_TOKEN_DEFAULT_TTL_SECONDS}, hard maximum ${JOIN_TOKEN_MAX_TTL_SECONDS}.`,
      ),
  })
  .strict();
export type JoinTokenRequest = z.infer<typeof JoinTokenRequestSchema>;

/**
 * The public face of a join token: the credential string and when it stops
 * being redeemable. Its contents are deliberately NOT part of this contract —
 * integrators hold it, hand it to the client SDK unmodified, and never parse it.
 */
export const IssuedJoinTokenSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .describe('Opaque single-use credential; hand it to the client SDK unmodified.'),
    expiresAt: IsoDateTimeSchema,
  })
  .strict();
export type IssuedJoinToken = z.infer<typeof IssuedJoinTokenSchema>;

export const JoinTokenResponseSchema = IssuedJoinTokenSchema.extend({
  participant: JoinParticipantEchoSchema,
});
export type JoinTokenResponse = z.infer<typeof JoinTokenResponseSchema>;

/** R4: project authority may change mode; nothing else is patchable in v1. */
export const UpdateCallModeRequestSchema = z.object({ mode: CallModeSchema }).strict();
export type UpdateCallModeRequest = z.infer<typeof UpdateCallModeRequestSchema>;

/**
 * R9: this shape is EXACT and its evolution is additive-only. No provider,
 * model, or internal detail may ever join it.
 */
export const CapabilityLimitsSchema = z
  .object({
    personalParticipants: z.number().int().positive(),
    conferenceParticipants: z.number().int().positive(),
  })
  .strict();
export const CapabilityFeaturesSchema = z
  .object({
    personalCall: z.boolean(),
    conference: z.boolean(),
    video: z.boolean(),
    translatedCalls: z.boolean(),
    personalVoice: z.boolean(),
  })
  .strict();
export const CapabilitiesResponseSchema = z
  .object({
    languages: z.array(LanguageTagSchema).min(1),
    limits: CapabilityLimitsSchema,
    features: CapabilityFeaturesSchema,
  })
  .strict();
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;
