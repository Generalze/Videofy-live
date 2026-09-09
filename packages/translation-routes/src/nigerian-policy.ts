/** @author masterzee001 */
import { normaliseLanguageTag, type TranslationRouteRecord } from './route-record.js';

export const GOOGLE_CLOUD_TRANSLATION_PROVIDER = 'google-cloud';
export const GOOGLE_CLOUD_TRANSLATION_MODEL_ID = 'google-cloud:translate-v3';
export const OPUS_MT_TRANSLATION_PROVIDER = 'opus-mt';

export const NIGERIAN_MACHINE_TRANSLATION_LANGUAGES = ['yo', 'ig', 'ha'] as const;
export type NigerianMachineTranslationLanguage =
  (typeof NIGERIAN_MACHINE_TRANSLATION_LANGUAGES)[number];

export const NIGERIAN_TRANSLATION_PRIMARY_CHOICES = [
  OPUS_MT_TRANSLATION_PROVIDER,
  GOOGLE_CLOUD_TRANSLATION_PROVIDER,
] as const;
export type NigerianTranslationPrimary = (typeof NIGERIAN_TRANSLATION_PRIMARY_CHOICES)[number];

const NIGERIAN_LANGUAGE_SET = new Set<string>(NIGERIAN_MACHINE_TRANSLATION_LANGUAGES);

function baseLanguage(tag: string): string {
  return normaliseLanguageTag(tag).split(/[-_]/u)[0] ?? '';
}

export function isNigerianMachineTranslationLanguage(
  language: string,
): language is NigerianMachineTranslationLanguage {
  return NIGERIAN_LANGUAGE_SET.has(baseLanguage(language));
}

/**
 * The Google/OPUS Nigerian MT switch is deliberately narrow: English in one
 * direction, Yoruba, Igbo or Hausa in the other. It is not a vendor-wide cloud
 * switch and it is not a bridge from Nigerian languages to arbitrary targets.
 */
export function isNigerianMachineTranslationPair(
  sourceLanguage: string,
  targetLanguage: string,
): boolean {
  const source = baseLanguage(sourceLanguage);
  const target = baseLanguage(targetLanguage);
  if (source === target) return false;
  return (
    (source === 'en' && NIGERIAN_LANGUAGE_SET.has(target)) ||
    (target === 'en' && NIGERIAN_LANGUAGE_SET.has(source))
  );
}

export function isGoogleCloudTranslationProvider(provider: string | undefined): boolean {
  return providerMatchesTranslationProvider(GOOGLE_CLOUD_TRANSLATION_PROVIDER, provider);
}

export function isOpusMtTranslationProvider(provider: string | undefined): boolean {
  return providerMatchesTranslationProvider(OPUS_MT_TRANSLATION_PROVIDER, provider);
}

/**
 * Route documents use stable provider ids (`google-cloud`, `opus-mt`) while
 * runtime providers may expose model-qualified names (`google-cloud:translate-v3`)
 * or composite names (`opus-mt+m2m100`). Matching is prefix/exact over provider
 * chain segments, never substring.
 */
export function providerMatchesTranslationProvider(
  routeProvider: string | undefined,
  providerName: string | undefined,
): boolean {
  const route = routeProvider?.trim().toLowerCase();
  const runtime = providerName?.trim().toLowerCase();
  if (!route || !runtime) return false;
  for (const segment of runtime.split(/[+>]/u)) {
    const cleaned = segment.replace(/^gated:/u, '').trim();
    if (cleaned === route || cleaned.startsWith(`${route}:`)) return true;
  }
  return runtime === route || runtime.startsWith(`${route}:`);
}

export function isApprovedGoogleNigerianTranslationRoute(
  record: TranslationRouteRecord,
  sourceLanguage: string,
  targetLanguage: string,
): boolean {
  return (
    isNigerianMachineTranslationPair(sourceLanguage, targetLanguage) &&
    record.executionClass === 'cloud' &&
    isGoogleCloudTranslationProvider(record.provider)
  );
}
