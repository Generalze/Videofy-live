/** @author masterzee001 */
/**
 * The voice rows of the Audio & Voices page, from real registry state only.
 *
 * Founder directive (LOCKED, 30 Aug 2026): "Voice rows may show real
 * registry/capability state only. No fake per-programme voice picker." The
 * deployment's target-language catalogue -- built by media-ingest from the
 * shared catalogue and ai-registry's capability resolver -- is the one feed
 * that says which vendor will speak a language and whether a voice exists
 * for it. Everything on a row derives from that; where the catalogue has
 * not arrived yet the row is honest: provider unknown, status Waiting.
 *
 * THE GRADE AND THE FLAG ARE NOT RESOLVED HERE. 04-audio-voices-reference
 * draws a national flag and a Standard / Premium chip on every row, and
 * nothing in the deployment produces either: the capability resolver accepts
 * a grade and returns the same rows for both ("the live path does not yet
 * select synthesis by grade"), and no feed names a country for a language.
 * So a row carries both fields and buildVoiceRows sets both to null -- the
 * page then shows the language code and the availability word, which is what
 * the master's own caption promises ("Status reflects current voice
 * availability"). A row that one day HAS a grade behind it can say so
 * without the page inventing one, and the visual fixture (which production
 * cannot read) fills them in to measure the master's layout.
 */
import type { TargetLanguageCapability } from '@videofy-live/shared-types';

export type VoiceStatus = 'ready' | 'limited' | 'captions-only' | 'waiting';

/** The commercial grade a voice is sold at. Never resolved by the live path today. */
export type VoiceGrade = 'standard' | 'premium';

export interface VoiceRow {
  readonly code: string;
  /** Catalogue label; the code upper-cased until the catalogue arrives. */
  readonly label: string;
  /** "Azure Neural (en-GB)" style; null until the registry has reported. */
  readonly provider: string | null;
  readonly status: VoiceStatus;
  /** Why the status is what it is, for a title/hint. */
  readonly reason: string | undefined;
  /**
   * ISO 3166-1 alpha-2 of a flag to show beside the language, or null when
   * nothing names one. Null is the production value: no feed maps a language
   * to a country, and the page shows the language code instead.
   */
  readonly flag: string | null;
  /** The sold grade, or null when nothing has resolved one. Null in production. */
  readonly grade: VoiceGrade | null;
}

export const VOICE_GRADE_WORDS: Readonly<Record<VoiceGrade, string>> = {
  standard: 'Standard',
  premium: 'Premium',
};

export const VOICE_STATUS_WORDS: Readonly<Record<VoiceStatus, string>> = {
  ready: 'Ready',
  limited: 'Limited',
  'captions-only': 'Captions only',
  waiting: 'Waiting',
};

/** Registry provider ids as the operator reads them. Unknown ids show as given. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  azure: 'Azure Neural',
  elevenlabs: 'ElevenLabs',
  naijalingo: '9jaLingo',
  google: 'Google',
  openai: 'OpenAI',
  local: 'Local synthesis',
};

export function providerLabel(providerId: string | undefined, voiceId: string | null | undefined): string | null {
  if (providerId === undefined || providerId.length === 0) return null;
  const name = PROVIDER_LABELS[providerId.toLowerCase()] ?? providerId;
  return voiceId ? `${name} (${voiceId})` : name;
}

function statusFor(entry: TargetLanguageCapability): VoiceStatus {
  if (entry.textOnly || (entry.translationAvailable && !entry.voiceAvailable)) return 'captions-only';
  if (!entry.voiceAvailable) return 'waiting';
  if (entry.state === 'limited' || entry.experimental) return 'limited';
  return 'ready';
}

/**
 * One row per selected target language, in the operator's order. The
 * catalogue may be absent (no session yet, gateway down) or may lack a
 * selected language (chosen before the catalogue arrived); both give a
 * Waiting row rather than an invented one.
 */
export function buildVoiceRows(
  targetLanguages: readonly string[],
  catalogue: readonly TargetLanguageCapability[] | undefined,
): readonly VoiceRow[] {
  return targetLanguages.map((code) => {
    const entry = catalogue?.find((candidate) => candidate.language === code);
    if (entry === undefined) {
      return {
        code,
        label: code.toUpperCase(),
        provider: null,
        status: 'waiting',
        reason: catalogue === undefined ? 'The registry has not reported yet.' : 'This language is outside the deployment catalogue.',
        flag: null,
        grade: null,
      };
    }
    return {
      code,
      label: entry.label,
      provider: providerLabel(entry.providers?.tts, entry.voiceId),
      status: statusFor(entry),
      reason: entry.reason,
      flag: null,
      grade: null,
    };
  });
}
