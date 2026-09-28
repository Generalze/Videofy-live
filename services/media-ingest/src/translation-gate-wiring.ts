/** @author masterzee001 */
/**
 * THE JOIN. Builds the translation gate media-ingest actually uses, from the
 * reviewed route document on disk.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS SHORT. `@videofy-live/translation-routes`
 * was written, tested, and listed in this service's package.json -- and no
 * source file here imported it. Uploaded and live programmes translated
 * whatever they were asked to, while a registry that would have refused sat
 * one `import` away. That is the fifth time in this project both halves of a
 * seam were built and the join was not, so the join gets its own file, its own
 * boot line, and its own test.
 *
 * FAIL CLOSED. A missing, unreadable or invalid document does not fall back to
 * "translate everything" -- it produces a gate that refuses every direction.
 * The alternative is a deployment whose route control silently evaporates on a
 * typo, which is indistinguishable from working right up until somebody reads
 * the output.
 */

import type { ServiceScope, TranslationRouteRecord, TranslationDecision } from '@videofy-live/translation-routes';
/*
 * STATICALLY IMPORTED, because these services are ESM.
 *
 * This was a lazy `require(...)` -- "so a deployment with translation off
 * never pays to read a document it will not consult". Both services declare
 * `type: module`, so at runtime `require` is not defined at all: the load threw
 * `require is not defined`, the builder caught it, and the gate failed closed.
 *
 * Which is the SAFE direction, and that is exactly why nobody noticed. A gate
 * that refuses everything looks identical to a deployment with no approved
 * routes, and the boot line said "FAILED CLOSED" in a deployment that had no
 * document configured anyway. It was found on staging, in the boot log, not by
 * anything failing.
 *
 * The saving was never real either: this module is a few kilobytes and reads
 * nothing until it is called. Correctness beats a micro-optimisation that
 * silently disabled the control it was optimising.
 */
import { loadTranslationRouteRegistry } from '@videofy-live/translation-routes/document-file';
import {
  createTranslationGate,
  type RouteGate,
  type TranslationScope,
} from './translation-gate.js';

/**
 * THE WIRING HAS NO SCOPE OF ITS OWN. Measured in production, 28 Sep 2026.
 *
 * It used to take one at construction, and this service built exactly one:
 * `programme-live`. Every path then asked that question regardless of what it
 * was doing. A native call asked whether French was approved for PROGRAMMES;
 * a chat message asked the same. On the production document `en->fr` is
 * approved for `messaging` and `call-live` and unapproved for `programme-live`
 * -- which is correct, nobody has reviewed it for broadcast -- so the gate
 * refused, the pipeline honoured the refusal, and a 55-second translated call
 * produced zero frames of audio in both directions with no error anywhere.
 *
 * The gate was working. It was being asked the wrong question, by a caller
 * that had the right answer sitting next to it: the OPEN frame carries
 * `serviceCategory`, and the pipeline holds it.
 *
 * So scope moved to the point of use. One document is loaded once -- two loads
 * of one file are two answers waiting to disagree after an edit -- and each
 * caller names the scope it is actually operating in.
 */

/**
 * The full-fidelity registry, for surfaces that must EXPLAIN a decision rather
 * than merely obey it.
 *
 * The gate's own `RouteGate` stays deliberately narrow -- it needs "may I" and
 * a provider name, and widening it would invite a caller to start re-judging
 * approval. But the operator console has to say WHY a route is refused, which
 * model is behind it and what was measured, and none of that is on the gate's
 * interface. So the wiring hands back the registry it already loaded instead
 * of anybody reading the document a second time: two loads of one file is two
 * answers waiting to disagree after an edit.
 */
export interface RouteEvidenceSource {
  mayTranslate(
    sourceLanguage: string,
    targetLanguage: string,
    scope: string,
  ): TranslationDecision;
  /**
   * The records themselves, for the readiness ladder.
   *
   * The gate only ever needs a yes or no, and this interface was that narrow
   * on purpose. But a rung like "has a human judged this route, and against
   * which model and corpus" is a question about the RECORD, and the
   * alternative is reading the document a second time -- two loads of one
   * file being two answers waiting to disagree after an edit, which is the
   * reason this interface exists at all.
   */
  routes(): readonly TranslationRouteRecord[];
  /** Which scopes admit this direction. Empty is a refusal, not an absence. */
  approvedScopes(sourceLanguage: string, targetLanguage: string): readonly ServiceScope[];
}

export interface GateWiring {
  /**
   * The gate for ONE scope, built off the single loaded document.
   *
   * A function rather than a value because approval is directional AND
   * scoped: `en->fr` may be approved for a call and not for a broadcast, and
   * a caller that cannot name its scope cannot be given a correct answer.
   * Cheap to call -- it wraps the already-loaded registry.
   */
  gateFor(scope: TranslationScope): ReturnType<typeof createTranslationGate>;
  /** For the boot line and /health: what was loaded, and from where. */
  readonly description: string;
  /**
   * Every direction this document approves for `scope`, as `en->fr`.
   *
   * NULL MEANS "CANNOT ENUMERATE", NOT "NONE". The previous version read an
   * `approvedDirections()` method off the loaded object; the real registry has
   * never had one, so the boot line printed `approvedDirections: 0` on every
   * deployment that had ever run -- including ones with approved routes. A
   * zero that means "I did not ask" is indistinguishable from a zero that
   * means "nothing is approved", and that line is exactly where somebody
   * should have seen this defect months ago. Null is printed as an admission.
   */
  approvedDirectionsFor(scope: TranslationScope): readonly string[] | null;
  readonly failedClosed: boolean;
  /**
   * The loaded registry, or null when none was. Null is not "allow": a surface
   * reading this must report that it cannot answer, exactly as the gate
   * refuses.
   */
  readonly registry: RouteEvidenceSource | null;
}

/** True when the loaded object is the real registry rather than a test double. */
function hasFullEvidence(candidate: unknown): candidate is RouteEvidenceSource {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as { mayTranslate?: unknown }).mayTranslate === 'function' &&
    typeof (candidate as { lookup?: unknown }).lookup === 'function'
  );
}

export interface WiringOptions {
  readonly documentPath?: string | undefined;
  readonly maxCharacters?: number | undefined;
  /** Injected in tests; production passes nothing and reads the real package. */
  readonly loadRegistry?: () => RegistryLoad;
}

export interface RegistryLoad {
  readonly ok: boolean;
  readonly registry?: RouteGate & {
    /**
     * Every direction the document NAMES, approved or not. Optional because a
     * test double is allowed to be a bare `RouteGate`; absent means the boot
     * line reports that it cannot enumerate rather than reporting zero.
     */
    directions?: () => readonly {
      readonly sourceLanguage: string;
      readonly targetLanguage: string;
    }[];
  };
  readonly problems?: readonly { readonly message: string }[];
}

/** A gate that says no to everything, with the reason it cannot say otherwise. */
function refuseEverything(explanation: string): RouteGate {
  return {
    mayTranslate: () => ({ allowed: false, reason: 'no-approved-route', explanation }),
  };
}

export function buildTranslationGate(options: WiringOptions): GateWiring {
  const load = options.loadRegistry ?? (() => defaultLoad(options.documentPath));

  let result: RegistryLoad;
  try {
    result = load();
  } catch (error) {
    const why = error instanceof Error ? error.message : 'unknown error';
    return closed(options, `route document could not be read: ${why}`);
  }

  if (!result.ok || !result.registry) {
    const problems = (result.problems ?? []).map((p) => p.message).join('; ');
    return closed(options, `route document rejected: ${problems || 'no routes'}`);
  }

  const registry = result.registry;
  /*
   * ONE GATE PER SCOPE, built at most once and kept.
   *
   * Memoised so a per-segment caller does not rebuild a gate for every
   * sentence, and so every path in this process that names the same scope is
   * demonstrably holding the same object -- there is no second copy to drift.
   */
  const gates = new Map<TranslationScope, ReturnType<typeof createTranslationGate>>();
  return {
    gateFor(scope: TranslationScope) {
      const existing = gates.get(scope);
      if (existing !== undefined) return existing;
      const built = createTranslationGate({
        gate: registry,
        scope,
        ...(options.maxCharacters === undefined ? {} : { maxCharacters: options.maxCharacters }),
      });
      gates.set(scope, built);
      return built;
    },
    approvedDirectionsFor(scope: TranslationScope) {
      return enumerateApproved(registry, scope);
    },
    description: 'route document loaded',
    failedClosed: false,
    registry: hasFullEvidence(registry) ? registry : null,
  };
}

/**
 * Which directions this scope actually admits, asked of the registry rather
 * than read off a method that never existed.
 *
 * Returns null when the loaded object cannot list its directions. A caller
 * printing this must print the null, not flatten it to an empty list: the
 * whole reason this defect survived is a zero nobody could distinguish from an
 * unasked question.
 */
function enumerateApproved(
  registry: RegistryLoad['registry'] & object,
  scope: TranslationScope,
): readonly string[] | null {
  if (typeof registry.directions !== 'function') return null;
  return registry
    .directions()
    .filter((d) => registry.mayTranslate(d.sourceLanguage, d.targetLanguage, scope).allowed)
    .map((d) => `${d.sourceLanguage}->${d.targetLanguage}`);
}

function closed(options: WiringOptions, why: string): GateWiring {
  const refusing = refuseEverything(`Translation is unavailable: ${why}`);
  const gates = new Map<TranslationScope, ReturnType<typeof createTranslationGate>>();
  return {
    gateFor(scope: TranslationScope) {
      const existing = gates.get(scope);
      if (existing !== undefined) return existing;
      const built = createTranslationGate({
        gate: refusing,
        scope,
        ...(options.maxCharacters === undefined ? {} : { maxCharacters: options.maxCharacters }),
      });
      gates.set(scope, built);
      return built;
    },
    /*
     * EMPTY, not null. Nothing was loaded, so nothing is approved for any
     * scope, and that is a real answer rather than an unasked question. The
     * null above means "I could not enumerate"; this means "there is nothing
     * to enumerate", and a deployment reading its boot line needs to be able
     * to tell those apart.
     */
    approvedDirectionsFor: () => [],
    description: `FAILED CLOSED -- ${why}`,
    failedClosed: true,
    // Nothing was loaded, so there is no evidence to show. The quality surface
    // reports "cannot answer" rather than an empty list of healthy routes.
    registry: null,
  };
}

function defaultLoad(documentPath: string | undefined): RegistryLoad {
  /*
   * `path`, NOT `documentPath`. The option this passed did not exist on
   * LoadOptions, so an explicitly configured document was silently ignored and
   * the loader fell through to the environment variable. That happens to name
   * the same file, which is why it never showed -- a wrong argument masked by a
   * fallback that agreed with it.
   */
  return loadTranslationRouteRegistry(
    documentPath === undefined ? {} : { path: documentPath },
  ) as RegistryLoad;
}
