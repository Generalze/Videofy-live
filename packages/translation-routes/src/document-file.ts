/** @author masterzee001 */
/**
 * Reading the document off disk, kept in its own module and its own export
 * subpath so the decision logic imports NOTHING from `node:`. The gate is pure
 * and testable with a literal object; only this file touches a filesystem.
 *
 * WHY A FILE AT ALL. Evidence is produced by measuring a route, and a
 * measurement that can only be acted on by shipping a release will not be acted
 * on. The document lets a measured, reviewed route be promoted by editing one
 * JSON file next to the deployment -- and every rule in validate.ts still
 * applies to it, so "no code change" never means "no check".
 *
 * THE ENV VAR IS A NAME. `TRANSLATION_ROUTES_DOCUMENT` names a path, and this
 * file prints its VALUE nowhere: not in a log line, not in an error message.
 * Errors here say which VARIABLE was consulted, never what it contained.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  TranslationRouteRegistry,
  type RegistryCreation,
  type RegistryOptions,
} from './registry.js';
import type { DocumentProblem } from './validate.js';

/**
 * The env var whose VALUE is the path to the document in force. A NAME, so it
 * is safe to log; the value never is, on principle rather than because a path
 * is secret -- the rule in this repository is that nothing prints an env value,
 * and an exception for "harmless" ones is how the rule stops being followed.
 */
export const ROUTE_DOCUMENT_PATH_ENV_VAR = 'TRANSLATION_ROUTES_DOCUMENT';

/**
 * The document shipped with this package: the twelve directions, every one
 * unapproved. Resolved from this module's own URL so it works from `dist/`
 * whatever the working directory is.
 */
export const SEED_DOCUMENT_PATH: string = fileURLToPath(
  new URL('../routes/translation-routes.seed.json', import.meta.url),
);

export interface LoadOptions extends RegistryOptions {
  /** Explicit path. Beats the environment, which beats the shipped seed. */
  path?: string;
  /** Defaults to `process.env`. Injectable so tests never mutate the real one. */
  env?: Record<string, string | undefined>;
}

/** Which document will be read, and why that one. */
export interface ResolvedDocumentSource {
  path: string;
  origin: 'explicit' | 'environment' | 'seed';
}

export function resolveDocumentSource(options: LoadOptions = {}): ResolvedDocumentSource {
  if (options.path !== undefined && options.path.trim() !== '') {
    return { path: options.path, origin: 'explicit' };
  }
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const configured = env[ROUTE_DOCUMENT_PATH_ENV_VAR];
  if (configured !== undefined && configured.trim() !== '') {
    return { path: configured, origin: 'environment' };
  }
  return { path: SEED_DOCUMENT_PATH, origin: 'seed' };
}

/**
 * Read and parse the JSON, returning a problem rather than throwing. A missing
 * or malformed document is an operational fact the caller has to decide about,
 * not an exception to be swallowed three frames up.
 */
export function readRouteDocument(
  path: string,
): { ok: true; document: unknown } | { ok: false; problems: readonly DocumentProblem[] } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      ok: false,
      problems: [
        {
          path: '',
          message: `route document could not be read: ${(error as Error).message}`,
        },
      ],
    };
  }
  try {
    return { ok: true, document: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      ok: false,
      problems: [{ path: '', message: `route document is not valid JSON: ${(error as Error).message}` }],
    };
  }
}

/**
 * The whole load in one call. Fail-closed at every step: an unreadable file, a
 * JSON syntax error and a rule violation all produce `ok: false` and no
 * registry, so nothing translates on a document nobody could check.
 */
export function loadTranslationRouteRegistry(options: LoadOptions = {}): RegistryCreation {
  const source = resolveDocumentSource(options);
  const read = readRouteDocument(source.path);
  if (!read.ok) return { ok: false, problems: read.problems };
  const registryOptions: RegistryOptions =
    options.reviewRequiredLanguages === undefined
      ? {}
      : { reviewRequiredLanguages: options.reviewRequiredLanguages };
  return TranslationRouteRegistry.fromDocument(read.document, registryOptions);
}
