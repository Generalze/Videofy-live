/** @author masterzee001 */
import { z } from 'zod';

/**
 * Adapter reads are declared independently from writes. A capable ingress is
 * never treated as evidence that generated audio can be returned to a caller.
 */
export const AdapterIngressCapabilitiesSchema = z
  .object({
    participantSeparatedAudio: z.boolean(),
    mergedAudio: z.boolean(),
    video: z.boolean(),
    screenShare: z.boolean(),
    participantIds: z.boolean(),
    timestamps: z.boolean(),
    transcriptEvents: z.boolean(),
    codecInformation: z.boolean(),
  })
  .strict();

export const AdapterEgressCapabilitiesSchema = z
  .object({
    inboundSynthesizedAudioInjection: z.boolean(),
    perRecipientEgress: z.boolean(),
    muteControl: z.boolean(),
  })
  .strict();

export const AdapterLifecycleCapabilitiesSchema = z
  .object({
    reconnectHooks: z.boolean(),
  })
  .strict();

/** Complete §16.1 declaration without platform-specific adapter enums. */
export const AdapterCapabilitiesSchema = z
  .object({
    ingress: AdapterIngressCapabilitiesSchema,
    egress: AdapterEgressCapabilitiesSchema,
    lifecycle: AdapterLifecycleCapabilitiesSchema,
  })
  .strict();

export type AdapterIngressCapabilities = z.infer<typeof AdapterIngressCapabilitiesSchema>;
export type AdapterEgressCapabilities = z.infer<typeof AdapterEgressCapabilitiesSchema>;
export type AdapterLifecycleCapabilities = z.infer<typeof AdapterLifecycleCapabilitiesSchema>;
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;

export function parseAdapterCapabilities(raw: unknown): AdapterCapabilities {
  return AdapterCapabilitiesSchema.parse(raw);
}
