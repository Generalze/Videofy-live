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
 * DELIBERATELY NOT HERE: a Standard / Premium grade. The resolver accepts a
 * grade and returns the same rows for both ("the live path does not yet
 * select synthesis by grade"), so no per-language grade exists to show. The
 * status chip therefore reports voice availability, which the master's
 * caption says it does ("Status reflects current voice availability").
 */
import type { TargetLanguageCapability } from '@videofy-live/shared-types';

export type VoiceStatus = 'ready' | 'limited' | 'captions-only' | 'waiting';

export interface VoiceRow {
  readonly code: string;
  /** Catalogue label; the code upper-cased until the catalogue arrives. */
  readonly label: string;
  /** "Azure Neural (en-GB)" style; null until the registry has reported. */
  readonly provider: string | null;
  readonly status: VoiceStatus;
  /** Why the status is what it is, for a title/hint. */
  readonly reason: string | undefined;
}

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
      };
    }
    return {
      code,
      label: entry.label,
      provider: providerLabel(entry.providers?.tts, entry.voiceId),
      status: statusFor(entry),
      reason: entry.reason,
    };
  });
}
