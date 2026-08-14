/** @author masterzee001 */
import { z } from 'zod';

const NonEmptyIdentifierSchema = z.string().min(1);
const RevisionSchema = z.number().int().nonnegative();

/**
 * Canonical language-tag boundary for every participant preference and routed
 * language event. The permissive 1..64 range preserves the existing BCP-47-like
 * contract, including private-use and provider-specific language tags.
 */
export const LanguageTagSchema = z.string().min(1).max(64);

/** Internal identity only; adapter/external identities remain boundary metadata. */
export const ParticipantIdSchema = NonEmptyIdentifierSchema.brand<'ParticipantId'>();
export const CallSessionIdSchema = NonEmptyIdentifierSchema.brand<'CallSessionId'>();
export const MediaRevisionSchema = RevisionSchema.brand<'MediaRevision'>();
export const LanguageRevisionSchema = RevisionSchema.brand<'LanguageRevision'>();

export type ParticipantId = z.infer<typeof ParticipantIdSchema>;
export type CallSessionId = z.infer<typeof CallSessionIdSchema>;
export type MediaRevision = z.infer<typeof MediaRevisionSchema>;
export type LanguageRevision = z.infer<typeof LanguageRevisionSchema>;
export type LanguageTag = z.infer<typeof LanguageTagSchema>;
