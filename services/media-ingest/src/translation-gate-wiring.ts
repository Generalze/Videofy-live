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
  readonly gate: ReturnType<typeof createTranslationGate>;
  /** For the boot line and /health: what was loaded, and from where. */
  readonly description: string;
  readonly approvedDirections: readonly string[];
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
  readonly scope: TranslationScope;
  readonly documentPath?: string | undefined;
  readonly maxCharacters?: number | undefined;
  /** Injected in tests; production passes nothing and reads the real package. */
  readonly loadRegistry?: () => RegistryLoad;
}

export interface RegistryLoad {
  readonly ok: boolean;
  readonly registry?: RouteGate & {
    approvedDirections?: () => readonly string[];
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
  const approved = registry.approvedDirections?.() ?? [];
  return {
    gate: createTranslationGate({
      gate: registry,
      scope: options.scope,
      ...(options.maxCharacters === undefined ? {} : { maxCharacters: options.maxCharacters }),
    }),
    description:
      `route document loaded; ${approved.length} approved direction(s) for ${options.scope}`,
    approvedDirections: approved,
    failedClosed: false,
    registry: hasFullEvidence(registry) ? registry : null,
  };
}

function closed(options: WiringOptions, why: string): GateWiring {
  return {
    gate: createTranslationGate({
      gate: refuseEverything(`Translation is unavailable: ${why}`),
      scope: options.scope,
      ...(options.maxCharacters === undefined ? {} : { maxCharacters: options.maxCharacters }),
    }),
    description: `FAILED CLOSED -- ${why}`,
    approvedDirections: [],
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
