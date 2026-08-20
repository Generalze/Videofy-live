/** @author masterzee001 */
/**
 * What the PLATFORM decides about a call that arrived on a given route.
 *
 * Target languages, voices and interpretation mode are product configuration.
 * They belong to the route — a phone number, a meeting link — and never to
 * anything the adapter sends. An adapter that could name a language would be a
 * transport component deciding product behaviour one layer up, which is the
 * boundary P6.9 exists to hold.
 *
 * Route configuration lives in a JSON file rather than in environment
 * variables, because it is a MAP and environment variables are not. Encoding
 * one as the other produces either `ROUTE_17_TARGET_LANGUAGES` sprawl or a
 * single variable holding JSON, which is a file with extra steps and worse
 * diffing.
 *
 * FAIL CLOSED, twice over:
 *
 *   - a route with no entry is REFUSED, not given a default. A default here
 *     would mean a misconfigured number silently translating into whatever
 *     the fallback happened to be, and the caller would never know.
 *   - a configuration file that is absent or unreadable is a startup refusal
 *     in the composing service, not an empty map that refuses every call at
 *     runtime and looks like a routing problem.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type {
  AdapterSessionPolicy,
  AdapterSessionPolicyResolver,
} from './adapter-ingress-binding.js';

export const ADAPTER_ROUTE_POLICY_PATH_VARIABLE = 'ADAPTER_ROUTE_POLICY_PATH';

const languageCode = z.string().trim().min(2).max(16);

const routePolicySchema = z
  .object({
    targetLanguages: z.array(languageCode).min(1),
    textOnlyLanguages: z.array(languageCode).optional(),
    sourceLanguage: languageCode.optional(),
    sourceLanguageMode: z.enum(['manual', 'auto-detect']).optional(),
    voiceIdsByLanguage: z.record(z.string().trim().min(1)).optional(),
  })
  .strict();

/**
 * One provisioned adapter identity.
 *
 * The secret is named, never written here. A configuration file gets committed,
 * copied into a ticket and read over a shoulder; the value it points at comes
 * from the environment, which is where the deployment already keeps secrets.
 */
const adapterSchema = z
  .object({
    /** Public. The handle for rotation and revocation, and safe to log. */
    id: z.string().trim().min(1),
    adapterId: z.string().trim().min(1),
    routes: z.array(z.string().trim().min(1)).min(1),
    /** The NAME of the environment variable holding the secret. Not the secret. */
    secretEnv: z.string().trim().min(1),
  })
  .strict();

const routePolicyFileSchema = z
  .object({
    /** Which adapters may connect, and which routes each may originate on. */
    adapters: z.array(adapterSchema).min(1),
    /** Keyed by `routeRef`, the same identifier the authority grants against. */
    routes: z.record(routePolicySchema),
  })
  .strict();

export type RoutePolicyFile = z.infer<typeof routePolicyFileSchema>;

export class AdapterRoutePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterRoutePolicyError';
  }
}

/**
 * Read and validate the route policy file.
 *
 * Throws rather than returning a partial map: a service that starts with half
 * its routes configured will answer calls on the other half by refusing them,
 * and the operator will look for the fault in the SIP layer.
 */
export function loadRoutePolicyFile(path: string): RoutePolicyFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new AdapterRoutePolicyError(
      `Could not read the adapter route policy at ${path}: ` +
        `${error instanceof Error ? error.message : 'unknown error'}. ` +
        `Set ${ADAPTER_ROUTE_POLICY_PATH_VARIABLE} to a readable JSON file.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AdapterRoutePolicyError(
      `The adapter route policy at ${path} is not valid JSON: ` +
        `${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  const validated = routePolicyFileSchema.safeParse(parsed);
  if (!validated.success) {
    throw new AdapterRoutePolicyError(
      `The adapter route policy at ${path} is not valid: ${validated.error.message}`,
    );
  }
  const declared = new Set(validated.data.adapters.flatMap((adapter) => adapter.routes));
  for (const routeRef of declared) {
    if (validated.data.routes[routeRef] === undefined) {
      // An adapter granted a route with no product configuration would
      // authenticate, originate a call, and then have every stream refused at
      // policy resolution. Caught here, where it is one line to fix.
      throw new AdapterRoutePolicyError(
        `Route ${routeRef} is granted to an adapter but has no policy in ${path}.`,
      );
    }
  }
  if (Object.keys(validated.data.routes).length === 0) {
    throw new AdapterRoutePolicyError(
      `The adapter route policy at ${path} configures no routes, so every call ` +
        `would be refused. Remove the file or configure at least one route.`,
    );
  }
  return validated.data;
}

export interface StaticRoutePolicyResolverDeps {
  readonly file: RoutePolicyFile;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export class StaticAdapterRoutePolicyResolver implements AdapterSessionPolicyResolver {
  constructor(private readonly deps: StaticRoutePolicyResolverDeps) {}

  async resolve(input: { routeRef: string }): Promise<AdapterSessionPolicy> {
    const policy = this.deps.file.routes[input.routeRef];
    if (policy === undefined) {
      // Refused, never defaulted. A number configured on the SIP side but not
      // here would otherwise translate into whatever the fallback happened to
      // be, and nobody would find out until a listener heard the wrong
      // language.
      this.deps.log?.('no adapter route policy is configured for this route', {
        routeRef: input.routeRef,
      });
      throw new AdapterRoutePolicyError(
        `No adapter route policy is configured for route ${input.routeRef}.`,
      );
    }
    // Rebuilt field by field rather than returned wholesale: zod gives every
    // optional key back as `key: T | undefined`, and under
    // `exactOptionalPropertyTypes` a present-but-undefined key is not the same
    // as an absent one. The binding spreads these into a bridge context, where
    // an explicit `sourceLanguage: undefined` would override a default rather
    // than leave it alone.
    return {
      targetLanguages: policy.targetLanguages,
      ...(policy.textOnlyLanguages === undefined
        ? {}
        : { textOnlyLanguages: policy.textOnlyLanguages }),
      ...(policy.sourceLanguage === undefined ? {} : { sourceLanguage: policy.sourceLanguage }),
      ...(policy.sourceLanguageMode === undefined
        ? {}
        : { sourceLanguageMode: policy.sourceLanguageMode }),
      ...(policy.voiceIdsByLanguage === undefined
        ? {}
        : { voiceIdsByLanguage: policy.voiceIdsByLanguage }),
    };
  }

  get routeCount(): number {
    return Object.keys(this.deps.file.routes).length;
  }
}


export interface ProvisionResult {
  readonly provisioned: readonly string[];
}

/**
 * Install the operator's adapter credentials into the authority.
 *
 * Fails loudly and completely. A gateway that started with three of four
 * adapters provisioned would refuse the fourth's calls with `rejected-auth`,
 * which reads as a wrong secret rather than as a missing one — and an operator
 * would go looking in the wrong place.
 */
export function provisionRouteCredentials(
  authority: {
    importRouteCredential(input: {
      id: string;
      secret: string;
      adapterId: string;
      routes: readonly string[];
    }): void;
  },
  file: RoutePolicyFile,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ProvisionResult {
  const provisioned: string[] = [];
  for (const adapter of file.adapters) {
    const secret = env[adapter.secretEnv];
    if (typeof secret !== 'string' || secret.trim() === '') {
      throw new AdapterRoutePolicyError(
        `Adapter ${adapter.id} needs its secret in ${adapter.secretEnv}, which is not set.`,
      );
    }
    try {
      authority.importRouteCredential({
        id: adapter.id,
        secret: secret.trim(),
        adapterId: adapter.adapterId,
        routes: adapter.routes,
      });
    } catch (error) {
      // Re-thrown naming the ADAPTER and its variable, never the value: the
      // authority's own message is about a secret it was handed, and this is
      // the layer that knows where that secret came from.
      throw new AdapterRoutePolicyError(
        `Adapter ${adapter.id} could not be provisioned from ${adapter.secretEnv}: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    provisioned.push(adapter.id);
  }
  return { provisioned };
}
