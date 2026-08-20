/** @author masterzee001 */
/**
 * The HTTPS control plane, and the JSON carried inside control frames.
 *
 * Validated with zod rather than hand-written guards, matching `call-wire`.
 * This parses untrusted input from adapter processes: hand-rolled validation of
 * a security boundary is how a field arrives as an object where a string was
 * expected and something downstream indexes it.
 *
 * What is NOT here is as important as what is. There is no field for source
 * language, target language, voice, provider, translation mode, personal voice,
 * pacing, STT engine or TTS engine. An adapter says what arrived and where from;
 * the gateway decides what the platform does about it. `schemaMentionsNoProduct
 * Configuration` in the tests makes that a checked property rather than an
 * intention.
 */
import { z } from 'zod';
import { PROTOCOL_VERSION } from './protocol.js';

/** Non-empty, bounded, and printable. Identifiers are not free-text fields. */
const identifier = z.string().trim().min(1).max(256);

/**
 * Opaque to this package. Step 5 issues and validates these; Step 4 reserves
 * the slot so adding authority later is not a transport redesign. Deliberately
 * NOT given a homemade format here — an interim shared secret invented for
 * convenience is exactly the kind of thing that becomes the permanent answer.
 */
export const sessionCapabilitySchema = z.string().min(1).max(4096);

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

// --- control plane (HTTPS) -------------------------------------------------

export const createSessionRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    /** The ADAPTER's own reference. Correlation; never platform authority. */
    adapterSessionRef: identifier,
    /** Which configured route this call arrived on. Supplied by the remote
     *  client from its route-scoped binding, never by the semantic seam. */
    routeRef: identifier,
    /**
     * Deterministic from adapter identity + routeRef + adapterSessionRef, so a
     * lost response cannot produce a second session. SIP retransmits.
     */
    idempotencyKey: identifier,
    /** The external system's own id — a SIP Call-ID, a meeting id. Metadata. */
    platformSessionRef: z.string().trim().max(1024).optional(),
  })
  .strict();

export const createSessionResponseSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    adapterSessionRef: identifier,
    /** Step 5 fills this with something meaningful. */
    sessionCapability: sessionCapabilitySchema,
    /** True when this request matched an existing binding rather than making one. */
    idempotentReplay: z.boolean(),
  })
  .strict();

export const participantRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    adapterSessionRef: identifier,
    sessionCapability: sessionCapabilitySchema,
    participantId: identifier,
    displayName: z.string().trim().max(512).optional(),
  })
  .strict();

export const closeSessionRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    adapterSessionRef: identifier,
    sessionCapability: sessionCapabilitySchema,
    reason: z.string().trim().max(512),
  })
  .strict();

// --- media-channel control envelopes --------------------------------------

export const helloSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    /**
     * Correlation only. The service credential authenticates the HTTP Upgrade,
     * BEFORE this frame is read — long-lived secrets do not belong inside
     * application frames that get logged, buffered and replayed.
     */
    adapterInstanceId: identifier,
  })
  .strict();

export const helloAckSchema = z
  .object({ protocolVersion: protocolVersionSchema, connectionId: identifier })
  .strict();

export const streamOpenSchema = z
  .object({
    adapterSessionRef: identifier,
    /** Must already have been announced over the control plane. */
    participantId: identifier,
    sessionCapability: sessionCapabilitySchema,
  })
  .strict();

export const streamOpenAckSchema = z
  .object({
    /** Never 0, and never reused within one connection's lifetime. */
    streamId: z.number().int().positive(),
  })
  .strict();

export const streamCloseSchema = z
  .object({ streamId: z.number().int().positive(), reason: z.string().trim().max(512) })
  .strict();

/**
 * Every sequence at or below `settledThroughSequence` has a terminal
 * disposition. Anything not named by a negative DISPOSITION was accepted.
 *
 * This replaced `acceptedThroughSequence`, which could not state the truth when
 * a frame inside the range was refused: the cumulative value would have
 * asserted the refused frame was accepted, and holding it back would have left
 * everything after it unresolved forever. One number was being asked to carry
 * two facts.
 *
 * Settlement is GATEWAY WIRE-INGRESS CUSTODY and nothing further. It does not
 * promise the speech reached STT.
 */
export const settlementSchema = z
  .object({
    streamId: z.number().int().positive(),
    settledThroughSequence: z.number().int().min(0),
  })
  .strict();

export const dispositionSchema = z
  .object({
    streamId: z.number().int().positive(),
    outcome: z.enum([
      /**
       * The gateway never received these sequences.
       *
       * Distinct from every refusal below it: nothing rejected this audio, it
       * simply did not arrive. Without this the client's frames would sit in
       * flight forever waiting for a settlement that can never come, which
       * breaks its own accounting invariant — found by implementing the server
       * against the contract rather than by reading it.
       */
      'lost-in-transit',
      'rejected-auth',
      'rejected-route',
      'rejected-session',
      'rejected-participant',
      'rejected-stale',
      'dropped-backpressure',
      'timed-out',
      'protocol-error',
      'internal-failure',
    ]),
    fromSequence: z.number().int().min(0),
    toSequence: z.number().int().min(0),
    count: z.number().int().positive(),
    detail: z.string().trim().max(512).optional(),
  })
  .strict();

export const wireErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    detail: z.string().trim().max(512).optional(),
    /** Present when the fault is scoped to one stream rather than the link. */
    streamId: z.number().int().positive().optional(),
  })
  .strict();

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type ParticipantRequest = z.infer<typeof participantRequestSchema>;
export type CloseSessionRequest = z.infer<typeof closeSessionRequestSchema>;
export type Hello = z.infer<typeof helloSchema>;
export type HelloAck = z.infer<typeof helloAckSchema>;
export type StreamOpen = z.infer<typeof streamOpenSchema>;
export type StreamOpenAck = z.infer<typeof streamOpenAckSchema>;
export type StreamClose = z.infer<typeof streamCloseSchema>;
export type Settlement = z.infer<typeof settlementSchema>;
export type Disposition = z.infer<typeof dispositionSchema>;
export type WireError = z.infer<typeof wireErrorSchema>;

/** Encode a control envelope for a frame payload. */
export function encodeJsonPayload(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

/** Decode and validate a control envelope from a frame payload. */
export function decodeJsonPayload<T>(payload: Buffer, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(payload.toString('utf8')) as unknown);
}
