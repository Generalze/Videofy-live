/** @author masterzee001 */
/**
 * MAY THIS LANGUAGE PAIR CARRY A LIVE TRANSLATED CALL?
 *
 * ENGINE AVAILABLE DOES NOT IMPLY ROUTE APPROVED. The gateway already knows
 * whether a translation engine exists (`translationEngineReal`), and that is a
 * different fact from whether a DIRECTION has been qualified to put a synthetic
 * voice in somebody's ear in real time. Until now the call path consulted only
 * the first: the `call-live` service scope existed in the route registry's
 * vocabulary and nothing anywhere asked it anything.
 *
 * NONE OF THESE IS APPROVAL, and each has been mistaken for it somewhere:
 *   the 98-language profile catalogue
 *   the `'en' | 'es' | 'fr'` TypeScript union
 *   provider credentials being configured
 *   a translation engine being installed
 *   a language specialist's record
 *   approval for `programme-live`
 *   approval for `messaging`
 *
 * Messaging is text a reader can re-read and challenge; a live call is a voice
 * somebody acts on immediately with nothing to check it against. The registry
 * keeps those scopes apart deliberately, and this asks it the call question.
 *
 * FAIL CLOSED. No document, an unreadable one, or an unapproved direction all
 * produce "no". A deployment whose route control silently evaporates on a typo
 * is indistinguishable from a working one right up until somebody hears a
 * sentence nobody qualified.
 */

import type { TranslationDecision } from '@videofy-live/translation-routes';

/** The single question the call path asks. */
export interface CallLiveRouteAuthority {
  /** Approved to translate `sourceLanguage` into `targetLanguage` on a live call. */
  approved(sourceLanguage: string, targetLanguage: string): boolean;
  /** Why not, for the log line. Never shown to a caller. */
  explain(sourceLanguage: string, targetLanguage: string): string;
  /** What was loaded, for the boot line. */
  readonly description: string;
}

/** A registry that can answer for a scope. Structural: the real one satisfies it. */
export interface CallRouteRegistryLike {
  mayTranslate(
    sourceLanguage: string,
    targetLanguage: string,
    scope: string,
  ): TranslationDecision;
}

export interface CallLiveRouteAuthorityOptions {
  /** Path to the reviewed route document; absent falls back to the package seed. */
  readonly documentPath?: string | undefined;
  /** Injected in tests; production reads the real package. */
  readonly loadRegistry?: () => {
    ok: boolean;
    registry?: CallRouteRegistryLike | undefined;
    problems?: readonly { readonly message: string }[] | undefined;
  };
}

/** An authority that refuses everything, and says why it cannot do otherwise. */
export function refuseEveryCallRoute(reason: string): CallLiveRouteAuthority {
  return {
    approved: () => false,
    explain: (source, target) =>
      `${source}->${target} is not approved for call-live: ${reason}`,
    description: `FAILED CLOSED -- ${reason}`,
  };
}

export function createCallLiveRouteAuthority(
  options: CallLiveRouteAuthorityOptions = {},
): CallLiveRouteAuthority {
  const load = options.loadRegistry ?? (() => defaultLoad(options.documentPath));

  let loaded: { ok: boolean; registry?: CallRouteRegistryLike | undefined; problems?: readonly { readonly message: string }[] | undefined };
  try {
    loaded = load();
  } catch (error) {
    const why = error instanceof Error ? error.message : 'unknown error';
    return refuseEveryCallRoute(`the route document could not be read: ${why}`);
  }

  if (!loaded.ok || !loaded.registry) {
    const problems = (loaded.problems ?? []).map((p) => p.message).join('; ');
    return refuseEveryCallRoute(`the route document was rejected: ${problems || 'no routes'}`);
  }

  const registry = loaded.registry;

  return {
    approved(sourceLanguage, targetLanguage) {
      /*
       * SAME LANGUAGE IS NOT A TRANSLATION. Nothing is produced, so nothing
       * needs approving -- and refusing it would block an ordinary call
       * between two people who already share a language.
       */
      if (normalise(sourceLanguage) === normalise(targetLanguage)) return true;
      return registry.mayTranslate(sourceLanguage, targetLanguage, 'call-live').allowed;
    },
    explain(sourceLanguage, targetLanguage) {
      if (normalise(sourceLanguage) === normalise(targetLanguage)) {
        return `${sourceLanguage}->${targetLanguage} needs no translation`;
      }
      const decision = registry.mayTranslate(sourceLanguage, targetLanguage, 'call-live');
      return decision.allowed
        ? `${sourceLanguage}->${targetLanguage} is approved for call-live`
        : decision.explanation;
    },
    description: 'route document loaded; call-live decisions come from the registry',
  };
}

function normalise(tag: string): string {
  return tag.trim().toLowerCase();
}

function defaultLoad(documentPath: string | undefined): {
  ok: boolean;
  registry?: CallRouteRegistryLike | undefined;
  problems?: readonly { readonly message: string }[] | undefined;
} {
  // Loaded lazily so a deployment with no translated calling never pays to
  // read a document it will not consult.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('@videofy-live/translation-routes/document-file') as {
    loadTranslationRouteRegistry: (o: { documentPath?: string }) => {
      ok: boolean;
      registry?: CallRouteRegistryLike;
      problems?: readonly { readonly message: string }[];
    };
  };
  return mod.loadTranslationRouteRegistry(
    documentPath === undefined ? {} : { documentPath },
  );
}
