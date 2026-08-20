/** @author masterzee001 */
/**
 * Route configuration is where a misconfiguration is silent rather than loud.
 *
 * A number that fails to route is reported by the caller within seconds. A
 * number that routes but translates into the wrong language sounds like it is
 * working, and the only person who finds out is a listener who cannot
 * understand what they are hearing. So the refusals matter more than the happy
 * path here.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdapterAuthority } from '@videofy-live/adapter-authority';
import {
  AdapterRoutePolicyError,
  StaticAdapterRoutePolicyResolver,
  loadRoutePolicyFile,
  provisionRouteCredentials,
} from '../adapter-route-policy.js';

const dir = mkdtempSync(join(tmpdir(), 'videofy-route-policy-'));

function fileWith(contents: string): string {
  const path = join(dir, `policy-${Math.abs(hash(contents))}.json`);
  writeFileSync(path, contents, 'utf8');
  return path;
}

function hash(value: string): number {
  let out = 0;
  for (const character of value) out = (out * 31 + character.charCodeAt(0)) | 0;
  return out;
}

const ADAPTERS = [
  { id: 'r_sip_primary', adapterId: 'sip-1', routes: ['route_17'], secretEnv: 'SIP_SECRET' },
];

const VALID = JSON.stringify({
  adapters: ADAPTERS,
  routes: {
    route_17: { targetLanguages: ['es', 'fr'], sourceLanguage: 'en' },
    route_18: { targetLanguages: ['de'], sourceLanguageMode: 'auto-detect' },
  },
});

const withRoutes = (routes: unknown) => JSON.stringify({ adapters: ADAPTERS, routes });

describe('loading route policy', () => {
  it('reads a valid file', () => {
    const file = loadRoutePolicyFile(fileWith(VALID));
    expect(Object.keys(file.routes)).toEqual(['route_17', 'route_18']);
    expect(file.routes['route_17']!.targetLanguages).toEqual(['es', 'fr']);
  });

  it('PIN: an absent file is an error, not an empty map', () => {
    // An empty map would refuse every call at runtime, and the operator would
    // go looking for the fault in the SIP layer.
    expect(() => loadRoutePolicyFile(join(dir, 'does-not-exist.json'))).toThrow(
      AdapterRoutePolicyError,
    );
  });

  it('PIN: an unusable file is refused rather than partially applied', () => {
    for (const contents of [
      'not json at all',
      JSON.stringify({}),
      withRoutes({}),
      // A route with no target language would produce a call that transcribes
      // and translates into nothing.
      withRoutes({ route_17: { targetLanguages: [] } }),
      // `.strict()`: an unrecognised key is a typo, and a typo in a language
      // list is exactly the silent misconfiguration this guards.
      withRoutes({ route_17: { targetLanguage: 'es' } }),
      JSON.stringify({ adapters: ADAPTERS, routes: { route_17: { targetLanguages: ['es'] } }, extra: 1 }),
      // No adapters at all: nothing could ever connect.
      JSON.stringify({ adapters: [], routes: { route_17: { targetLanguages: ['es'] } } }),
      // A secret written INTO the file rather than named. `.strict()` refuses
      // it, which is the point of naming the variable instead.
      JSON.stringify({
        adapters: [{ id: 'r1', adapterId: 'sip-1', routes: ['route_17'], secret: 'hunter2' }],
        routes: { route_17: { targetLanguages: ['es'] } },
      }),
      // An adapter granted a route that has no policy would authenticate,
      // originate, and then have every stream refused.
      JSON.stringify({
        adapters: [{ id: 'r1', adapterId: 'sip-1', routes: ['route_99'], secretEnv: 'S' }],
        routes: { route_17: { targetLanguages: ['es'] } },
      }),
    ]) {
      expect(() => loadRoutePolicyFile(fileWith(contents)), contents).toThrow(
        AdapterRoutePolicyError,
      );
    }
  });

  it('PIN: the error names the path so an operator can act on it', () => {
    const path = join(dir, 'missing-here.json');
    try {
      loadRoutePolicyFile(path);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toContain(path);
      expect((error as Error).message).toContain('ADAPTER_ROUTE_POLICY_PATH');
    }
  });
});

describe('resolving a route', () => {
  const resolver = new StaticAdapterRoutePolicyResolver({
    file: loadRoutePolicyFile(fileWith(VALID)),
  });

  it('returns the configured policy', async () => {
    expect(await resolver.resolve({ routeRef: 'route_17' })).toEqual({
      targetLanguages: ['es', 'fr'],
      sourceLanguage: 'en',
    });
  });

  it('PIN: an unconfigured route is REFUSED, never defaulted', async () => {
    // The whole point. A default here means a misconfigured number quietly
    // translating into whatever the fallback happened to be.
    await expect(resolver.resolve({ routeRef: 'route_UNKNOWN' })).rejects.toThrow(
      AdapterRoutePolicyError,
    );
  });

  it('PIN: routes do not leak into each other', async () => {
    const seventeen = await resolver.resolve({ routeRef: 'route_17' });
    const eighteen = await resolver.resolve({ routeRef: 'route_18' });
    expect(seventeen.targetLanguages).toEqual(['es', 'fr']);
    expect(eighteen.targetLanguages).toEqual(['de']);
    expect(eighteen.sourceLanguage).toBeUndefined();
  });
});


describe('provisioning adapter credentials', () => {
  const SECRET = 'operator-chosen-secret-0123456789abcdef';

  it('installs every configured adapter', () => {
    const authority = new AdapterAuthority();
    const file = loadRoutePolicyFile(fileWith(VALID));
    const result = provisionRouteCredentials(authority, file, { SIP_SECRET: SECRET });
    expect(result.provisioned).toEqual(['r_sip_primary']);

    // And the credential actually works, which is the only proof that matters.
    const grant = authority.createSession({
      credential: `vfr_r_sip_primary.${SECRET}`,
      adapterSessionRef: 'sc_1',
      routeRef: 'route_17',
      idempotencyKey: 'k1',
    });
    expect(typeof grant).not.toBe('string');
  });

  it('PIN: a missing secret is a startup refusal naming its variable', () => {
    const authority = new AdapterAuthority();
    const file = loadRoutePolicyFile(fileWith(VALID));
    try {
      provisionRouteCredentials(authority, file, {});
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterRoutePolicyError);
      // Names the variable to set, and the adapter it belongs to. Without both,
      // an operator with several adapters is guessing.
      expect((error as Error).message).toContain('SIP_SECRET');
      expect((error as Error).message).toContain('r_sip_primary');
    }
  });

  it('PIN: a weak secret is refused, and never echoed', () => {
    const authority = new AdapterAuthority();
    const file = loadRoutePolicyFile(fileWith(VALID));
    const weak = 'short';
    try {
      provisionRouteCredentials(authority, file, { SIP_SECRET: weak });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterRoutePolicyError);
      // The value reaches a log the moment it appears in an error message.
      expect((error as Error).message).not.toContain(weak);
    }
  });

  it('PIN: provisioning is all or nothing', () => {
    // Three of four adapters provisioned would refuse the fourth's calls with
    // `rejected-auth`, which reads as a WRONG secret rather than a missing one.
    const authority = new AdapterAuthority();
    const file = loadRoutePolicyFile(
      fileWith(
        JSON.stringify({
          adapters: [
            { id: 'r_a', adapterId: 'sip-1', routes: ['route_17'], secretEnv: 'A_SECRET' },
            { id: 'r_b', adapterId: 'sip-2', routes: ['route_18'], secretEnv: 'B_SECRET' },
          ],
          routes: {
            route_17: { targetLanguages: ['es'] },
            route_18: { targetLanguages: ['de'] },
          },
        }),
      ),
    );
    expect(() => provisionRouteCredentials(authority, file, { A_SECRET: SECRET })).toThrow(
      AdapterRoutePolicyError,
    );
  });
});
