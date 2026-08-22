/** @author masterzee001 */
/**
 * What a provider can DO, and what each Videofy service REQUIRES. Owner: masterzee001.
 *
 * Two halves that must be compared, never conflated:
 *
 *   CAPABILITY   an observed fact about a vendor's API
 *   REQUIREMENT  a platform policy about a service category
 *
 * Selection is the comparison. Neither half may be inferred from the other, and
 * neither may be inferred from a transport: P6.9 already spent a round removing
 * behaviour that was inferred from a `call_` id prefix, and routing an AI
 * provider off `sourceKind: 'webrtc'` would be the same mistake wearing a
 * different hat.
 */
import { z } from 'zod';

/**
 * How a provider executes a capability.
 *
 * These are ALTERNATIVE EXECUTION STRATEGIES FOR TRANSCRIPTION, not two
 * pipelines. Both normalize into the same platform transcript representation
 * before translation, and everything downstream of that is shared.
 */
export const ProviderExecutionModeSchema = z.enum(['batch', 'streaming']);
export type ProviderExecutionMode = z.infer<typeof ProviderExecutionModeSchema>;

/**
 * A capability claim, with `unverified` as a first-class value.
 *
 * `unverified` is NOT `no`, and it must never satisfy a requirement. Vendor
 * capability pages change, marketing overstates language coverage, and a
 * capability matrix filled in from memory is worse than an empty one because it
 * will be believed. Every cell starts here and only moves when a documentation
 * reference is recorded in `capabilityEvidence`.
 */
export const CapabilityFlagSchema = z.enum(['yes', 'no', 'unverified']);
export type CapabilityFlag = z.infer<typeof CapabilityFlagSchema>;

/** Fail closed: only an explicit `yes` counts as support. */
export function capabilitySupported(flag: CapabilityFlag | undefined): boolean {
  return flag === 'yes';
}

export const TranscriptionCapabilitiesSchema = z.object({
  batch: CapabilityFlagSchema,
  streaming: CapabilityFlagSchema,
  /** Interim hypotheses during an utterance. Required for realtime captions. */
  partialResults: CapabilityFlagSchema,
  /** Provider detects utterance boundaries itself. */
  endpointing: CapabilityFlagSchema,
  wordTimestamps: CapabilityFlagSchema,
});
export type TranscriptionCapabilities = z.infer<typeof TranscriptionCapabilitiesSchema>;

export const TranslationCapabilitiesSchema = z.object({
  requestResponse: CapabilityFlagSchema,
  /** Incremental translation of a growing clause. Not used in this wave. */
  streaming: CapabilityFlagSchema,
});
export type TranslationCapabilities = z.infer<typeof TranslationCapabilitiesSchema>;

export const TtsCapabilitiesSchema = z.object({
  completeAudio: CapabilityFlagSchema,
  /** Audio returned progressively. Materially reduces perceived call latency. */
  streamingAudio: CapabilityFlagSchema,
});
export type TtsCapabilities = z.infer<typeof TtsCapabilitiesSchema>;

/**
 * The execution capability matrix.
 *
 * Streaming MT and streaming TTS are DECLARABLE HERE AND NOT IMPLEMENTED in
 * this wave. They are present so the contracts do not preclude them later --
 * the cost of adding a field now is nil, and the cost of discovering the model
 * cannot express a capability we want is a migration.
 */
export const ProviderExecutionCapabilitiesSchema = z.object({
  transcription: TranscriptionCapabilitiesSchema.optional(),
  translation: TranslationCapabilitiesSchema.optional(),
  tts: TtsCapabilitiesSchema.optional(),
});
export type ProviderExecutionCapabilities = z.infer<typeof ProviderExecutionCapabilitiesSchema>;

/** Everything unverified. The only honest starting point for a new vendor. */
export const UNVERIFIED_TRANSCRIPTION: TranscriptionCapabilities = {
  batch: 'unverified',
  streaming: 'unverified',
  partialResults: 'unverified',
  endpointing: 'unverified',
  wordTimestamps: 'unverified',
};
export const UNVERIFIED_TRANSLATION: TranslationCapabilities = {
  requestResponse: 'unverified',
  streaming: 'unverified',
};
export const UNVERIFIED_TTS: TtsCapabilities = {
  completeAudio: 'unverified',
  streamingAudio: 'unverified',
};

// --- service context ------------------------------------------------------

/**
 * Which Videofy service this media belongs to.
 *
 * A DISCRIMINATED UNION, so `{ serviceCategory: 'call', mediaMode: 'uploaded' }`
 * cannot be written down. A call is live by definition; there is no such thing
 * as an uploaded conversation. Expressing that as two independent fields would
 * make the impossible state representable and push the check to runtime, where
 * somebody has to remember to write it.
 *
 * PLATFORM POLICY, NOT A CLIENT CLAIM. These values are set where the session is
 * created. SIP, Zoom, browser WebRTC, upload and microphone sources neither
 * supply nor influence them. Note that the existing `mediaSessionMode`
 * (`programme | live-conversation`) CANNOT express this: it has no way to
 * separate a live programme from an uploaded one.
 */
export const ProviderServiceContextSchema = z.discriminatedUnion('serviceCategory', [
  z.object({
    serviceCategory: z.literal('call'),
    mediaMode: z.literal('live'),
  }),
  z.object({
    serviceCategory: z.literal('programme'),
    mediaMode: z.enum(['live', 'uploaded']),
  }),
]);
export type ProviderServiceContext = z.infer<typeof ProviderServiceContextSchema>;

/** Stable key for tables, logs and certification records. */
export function serviceContextKey(service: ProviderServiceContext): string {
  return `${service.serviceCategory}:${service.mediaMode}`;
}

// --- requirements ---------------------------------------------------------

/**
 * How strongly a service wants an execution mode for its PRIMARY provider.
 *
 * `required` is a gate: a provider lacking it cannot be primary at all.
 * `preferred` ranks: it is chosen first when available, but a provider without
 * it is still selectable. The distinction is real and collapsing it would
 * either block live programmes unnecessarily or let a batch provider become
 * the primary for interactive calls.
 */
export const RequirementStrengthSchema = z.enum(['required', 'preferred']);
export type RequirementStrength = z.infer<typeof RequirementStrengthSchema>;

export interface ServiceExecutionPolicy {
  /** Execution mode the PRIMARY transcription provider should offer. */
  readonly primaryTranscriptionMode: ProviderExecutionMode;
  readonly primaryStrength: RequirementStrength;
  /** Modes acceptable for a FALLBACK behind the primary. */
  readonly fallbackTranscriptionModes: readonly ProviderExecutionMode[];
  /** Partial results needed for realtime captions in this service. */
  readonly requiresPartialResults: boolean;
  readonly rationale: string;
}

/**
 * The platform's service-category policy, in one table.
 *
 * Adding a service means adding a row here, never editing a branch somewhere
 * downstream -- the same discipline `mediaSessionMode` already uses in the
 * gateway bridge.
 */
export const SERVICE_EXECUTION_POLICY: Readonly<Record<string, ServiceExecutionPolicy>> = {
  'call:live': {
    primaryTranscriptionMode: 'streaming',
    primaryStrength: 'required',
    fallbackTranscriptionModes: ['streaming', 'batch'],
    requiresPartialResults: true,
    rationale:
      'Interactive conversation. Turn-taking breaks when translated output lags, so ' +
      'time-to-first-partial and interruption responsiveness dominate accuracy. A ' +
      'batch-only provider cannot be primary here however good its WER on files is; ' +
      'it remains acceptable as a fallback.',
  },
  'programme:live': {
    primaryTranscriptionMode: 'streaming',
    primaryStrength: 'preferred',
    fallbackTranscriptionModes: ['streaming', 'batch'],
    requiresPartialResults: false,
    rationale:
      'Live interpretation for an audience. Latency matters, but one-way delivery ' +
      'tolerates more stabilisation than two-way conversation, so streaming is ' +
      'preferred rather than required.',
  },
  'programme:uploaded': {
    primaryTranscriptionMode: 'batch',
    primaryStrength: 'preferred',
    fallbackTranscriptionModes: ['batch', 'streaming'],
    requiresPartialResults: false,
    rationale:
      'Prerecorded media with no listener waiting. Accuracy, context and cost per ' +
      'hour matter more than first-token latency, and batch processing generally ' +
      'wins on all three.',
  },
};

export function executionPolicyFor(service: ProviderServiceContext): ServiceExecutionPolicy {
  const policy = SERVICE_EXECUTION_POLICY[serviceContextKey(service)];
  if (policy === undefined) {
    // Unreachable while the union and the table agree; a compile-time exhaustive
    // check cannot see through the string key, so this is the runtime backstop.
    throw new Error(`No execution policy for service context ${serviceContextKey(service)}.`);
  }
  return policy;
}
