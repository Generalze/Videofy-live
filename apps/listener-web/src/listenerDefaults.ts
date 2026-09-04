/** @owner masterzee001 */
/**
 * Which language a viewer lands on before choosing one.
 *
 * Why this is computed and not a constant: the listener used to open on a
 * hard-coded Spanish. That was right for the P6.1 partner preview and wrong
 * for every programme since -- a channel translating into Yoruba and French
 * greeted its viewers with a Spanish row that had nothing in it, and the
 * fallback effect in App then silently hopped them to whatever came first.
 * The default is now the session's first ENABLED target: one the deployment
 * can actually translate into, in the operator's order. Until the session has
 * reported one, the viewer stays on the original channel, which always works.
 */
import type { MediaStateEvent, TargetLanguageCapability } from '@videofy-live/shared-types';
import { targetLanguagesForSession } from './listenerLanguageSelection';

/** Whether this deployment will produce anything for the language at all. */
export function isEnabledTargetLanguage(capability: TargetLanguageCapability | undefined): boolean {
  return capability?.translationAvailable === true;
}

/**
 * The first session target the deployment has enabled, or -- when the session
 * has targets but no catalogue to judge them by (an older ingest) -- the first
 * target as listed. `undefined` means "no default yet": stay on the original.
 */
export function defaultListenerTargetLanguage(state: MediaStateEvent | null): string | undefined {
  const targets = targetLanguagesForSession(state);
  if (targets.length === 0) return undefined;
  const catalogue = state?.targetLanguageCatalogue;
  if (catalogue === undefined) return targets[0];
  const enabled = targets.find((language) =>
    isEnabledTargetLanguage(catalogue.find((capability) => capability.language === language)),
  );
  return enabled ?? undefined;
}
