/** @author masterzee001 */
/**
 * The right voice for the language, rather than one voice for all of them.
 *
 * WHAT THIS FIXES, and it was found by listening rather than by any test. The
 * synthesis chain was LANGUAGE-BLIND: one ordered list of vendors served every
 * target language. That is correct while every language is served comparably
 * well, and it stops being correct the moment it is not.
 *
 * Both general vendors accepted Yoruba, Hausa and Igbo and returned HTTP 200
 * with real audio. Neither lists those languages. What comes back is a
 * multilingual voice reading unfamiliar orthography with the phonology it does
 * know, and it is wrong in the specific way that is hardest to catch from a
 * server: every signal is green. Latency is fine, byte counts are fine, no
 * error is raised, and the only thing that reveals it is a person who speaks
 * the language listening to the output.
 *
 * So routing cannot be a property of the vendor list. A specialist exists for
 * exactly four languages, and a general vendor is better at the other ninety.
 * This picks per target language and gets out of the way.
 *
 * IT ROUTES, IT DOES NOT RANK. Each route is itself a provider -- ordinarily a
 * fallback chain -- so "prefer the specialist, fall back to the general vendor"
 * is expressed by handing this a chain, not by adding precedence rules here.
 * One concept per module: this one answers WHICH chain, the chain answers WHICH
 * VENDOR.
 *
 * EVERY DECISION IS OBSERVABLE. A specialist silently not being used looks
 * exactly like a specialist being used -- audio plays either way. That is the
 * failure this module exists to prevent, so it must not be able to hide its own
 * misconfiguration.
 */
import type {
  StreamingSpeechSynthesisProvider,
  StreamingSynthesisOptions,
  StreamingSynthesisResult,
} from './streaming-speech-synthesis-provider.js';

export interface SynthesisRouteObservation {
  /** The language as the caller asked for it, before normalisation. */
  readonly requestedLanguage: string;
  /** The key that actually matched, or null when the default was used. */
  readonly matchedLanguage: string | null;
  readonly servedBy: string;
}

export interface LanguageRoutedSynthesisOptions {
  /**
   * Language to provider. Keys are base subtags, lower case: `yo`, not `yo-NG`.
   *
   * A region does not change who speaks a language best, so the map is keyed on
   * the language alone and every regional variant of it lands on the same
   * route. Keeping regions out of the keys also removes the failure where
   * `yo-NG` is configured, `yo` arrives, and the specialist is quietly skipped.
   */
  readonly routes: ReadonlyMap<string, StreamingSpeechSynthesisProvider>;
  /** Everything not named above. */
  readonly fallback: StreamingSpeechSynthesisProvider;
  readonly onRoute?: (observation: SynthesisRouteObservation) => void;
}

/**
 * `yo-NG`, `YO_ng` and `yo` are one language.
 *
 * Underscore is accepted alongside hyphen because it arrives from callers that
 * borrowed a POSIX locale, and refusing it would route those requests to the
 * general vendor -- silently, and in exactly the languages this module exists
 * to protect.
 */
export function baseLanguage(tag: string): string {
  return tag.toLowerCase().split(/[-_]/u)[0] ?? '';
}

export function createLanguageRoutedSynthesisProvider(
  options: LanguageRoutedSynthesisOptions,
): StreamingSpeechSynthesisProvider {
  const routed = [...options.routes.keys()].sort();

  return {
    name:
      routed.length === 0
        ? options.fallback.name
        : `routed(${routed.join(',')} -> specialist; * -> ${options.fallback.name})`,

    async synthesize(request: StreamingSynthesisOptions): Promise<StreamingSynthesisResult> {
      const base = baseLanguage(request.targetLanguage);
      const specialist = options.routes.get(base);
      const provider = specialist ?? options.fallback;

      options.onRoute?.({
        requestedLanguage: request.targetLanguage,
        matchedLanguage: specialist === undefined ? null : base,
        servedBy: provider.name,
      });

      /*
       * Passed through untouched. A router that rewrote the request would be
       * making a second decision, and the provider it selected is the thing
       * entitled to make that one.
       */
      return provider.synthesize(request);
    },
  };
}
