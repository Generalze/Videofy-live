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

import {
  createTranslationGate,
  type RouteGate,
  type TranslationScope,
} from './translation-gate.js';

export interface GateWiring {
  readonly gate: ReturnType<typeof createTranslationGate>;
  /** For the boot line and /health: what was loaded, and from where. */
  readonly description: string;
  readonly approvedDirections: readonly string[];
  readonly failedClosed: boolean;
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
  };
}

function defaultLoad(documentPath: string | undefined): RegistryLoad {
  // Imported lazily so a deployment with translation off, or a test that
  // injects its own loader, never pays to read a document it will not consult.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('@videofy-live/translation-routes/document-file') as {
    loadTranslationRouteRegistry: (o: { documentPath?: string }) => RegistryLoad;
  };
  return mod.loadTranslationRouteRegistry(
    documentPath === undefined ? {} : { documentPath },
  );
}
