/** @owner masterzee001 */
import { z } from 'zod';
import {
  CallSessionIdSchema,
  LanguageRevisionSchema,
  LanguageTagSchema,
  MediaClockDescriptorSchema,
  MediaRevisionSchema,
  ParticipantIdSchema,
} from '@videofy-live/participant-contracts';

export {
  CallSessionIdSchema,
  LanguageRevisionSchema,
  LanguageTagSchema,
  MediaClockDescriptorSchema,
  MediaRevisionSchema,
  ParticipantIdSchema,
};

/** Canonical Videofy identifiers; adapter/platform identifiers are never accepted here. */
export const EventSequenceSchema = z.number().int().nonnegative();
export const ProviderIdSchema = z.string().min(1).max(256);
export const TimestampMsSchema = z.number().int().nonnegative();

export type {
  CallSessionId,
  LanguageRevision,
  LanguageTag,
  MediaClockDescriptor,
  MediaRevision,
  ParticipantId,
} from '@videofy-live/participant-contracts';
