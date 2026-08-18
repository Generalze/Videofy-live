/** @author masterzee001 */
/**
 * Public enumerations for Videofy Connect v1.
 *
 * These value sets match the P6.4 product contract exactly. Removing or
 * renaming a member is a breaking API change; additions are not, which is why
 * consumers must treat every union here as open-ended when reading, and closed
 * when writing.
 */
import { z } from 'zod';

export const CALL_TYPES = ['personal', 'conference'] as const;
export const CallTypeSchema = z.enum(CALL_TYPES);
export type CallType = z.infer<typeof CallTypeSchema>;

export const CALL_MODES = ['normal', 'translated'] as const;
export const CallModeSchema = z.enum(CALL_MODES);
export type CallMode = z.infer<typeof CallModeSchema>;

/**
 * How a participant asks to hear the far side: fully translated voices, the
 * original attenuated under live interpretation, or the original untouched.
 */
export const AUDIO_MODES = ['translated', 'interpretation', 'original'] as const;
export const AudioModeSchema = z.enum(AUDIO_MODES);
export type AudioMode = z.infer<typeof AudioModeSchema>;

export const VOICE_GENDERS = ['female', 'male'] as const;
export const VoiceGenderSchema = z.enum(VOICE_GENDERS);
export type VoiceGender = z.infer<typeof VoiceGenderSchema>;

/**
 * BCP-47 SHAPE check: a 2-3 letter primary subtag plus optional 1-8 character
 * subtags. Deliberately a shape check and not a registry lookup — whether a
 * well-formed tag is actually supported is answered by GET /v1/capabilities,
 * and an unsupported-but-well-formed tag is refused by the server as
 * INVALID_LANGUAGE, not by this schema.
 */
export const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
export const LanguageTagSchema = z
  .string()
  .max(35)
  .regex(LANGUAGE_TAG_PATTERN)
  .describe('BCP-47 language tag (shape-checked; supported values come from GET /v1/capabilities).');
export type LanguageTag = z.infer<typeof LanguageTagSchema>;
