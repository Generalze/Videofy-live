/** @author masterzee001 */
/**
 * THE SEPARATION OF PERMISSION FROM ALLOWANCE, ENFORCED.
 *
 * The CTO ruled on 2026-08-30 that this registry decides WHETHER a route may
 * run and the credit system separately decides whether the user has allowance.
 * Rulings decay; tests do not. The pressure to merge them is real and will
 * arrive as something reasonable-sounding -- "the route knows its price, put it
 * on the record" -- and the day it lands, a licence review closing starts
 * touching balances and an empty balance starts reading as "this language is
 * not approved".
 *
 * So this is checked three ways: no billing field may exist on the type (the
 * contract), none may enter through a JSON document (the loader), and this
 * package may not depend on the billing package at all (the wiring).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { documentOf, route } from './document.fixtures.js';
import { parseRouteDocument } from './validate.js';
import { SEED_DOCUMENT_PATH } from './document-file.js';
import type { TranslationRouteRecord } from './route-record.js';

const SOURCE_DIR = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

/** The ten fields the CTO's contract names, and nothing else. */
const CONTRACT_FIELDS = [
  'sourceLanguage',
  'targetLanguage',
  'provider',
  'modelId',
  'executionClass',
  'productionApproved',
  'technicalEvidence',
  'humanReviewStatus',
  'licenceStatus',
  'serviceScopes',
].sort();

describe('the registry holds no billing of any kind', () => {
  it('has exactly the contract fields on a loaded record', () => {
    const parsed = parseRouteDocument(documentOf(route()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const record = parsed.document.routes[0] as TranslationRouteRecord;
    expect(Object.keys(record).sort()).toEqual(CONTRACT_FIELDS);
  });

  it('refuses a billing field smuggled in through the document', () => {
    const fields = [
      'pricePerSecond',
      'costMinor',
      'creditsPerMinute',
      'billingGrade',
      'tariffVersion',
      'currency',
      'chargeCode',
      'balanceRequired',
      'quotaSeconds',
    ];

    for (const field of fields) {
      const parsed = parseRouteDocument(documentOf(route({ [field]: 1 })));
      expect(parsed.ok, field).toBe(false);
      if (parsed.ok) continue;
      expect(
        parsed.problems.some((problem) => problem.message.includes('credit system')),
        field,
      ).toBe(true);
    }
  });

  it('refuses a billing field nested inside evidence, licence or scopes', () => {
    const nested: readonly Record<string, unknown>[] = [
      route({ technicalEvidence: { sampleCount: 1, successRate: 1, latencyMs: { min: 1, median: 1, mean: 1, max: 1 }, recordedAt: '2026-08-30T00:00:00.000Z', costMinor: 4 } }),
      route({ licenceStatus: { licence: 'MIT', commercialUse: 'permitted', evidence: 'fixture', pricePerSecond: 2 } }),
      route({ serviceScopes: { messaging: 'unapproved', 'programme-live': 'unapproved', 'call-live': 'unapproved', creditsPerMinute: 3 } }),
    ];

    for (const [index, candidate] of nested.entries()) {
      const parsed = parseRouteDocument(documentOf(candidate));
      expect(parsed.ok, `nested case ${index}`).toBe(false);
      if (parsed.ok) continue;
      // Refused AS BILLING, not merely as an unknown field. The unknown-field
      // rule would refuse these too, which would let the billing rule rot
      // undetected behind it.
      expect(
        parsed.problems.some((problem) => problem.message.includes('credit system')),
        `nested case ${index}`,
      ).toBe(true);
    }
  });

  it('refuses a billing field at document level', () => {
    expect(parseRouteDocument({ ...documentOf(route()), pricePerThousandUnitsMinor: 500 }).ok).toBe(
      false,
    );
  });

  it('carries no billing key in the shipped seed', () => {
    const seed = JSON.parse(readFileSync(SEED_DOCUMENT_PATH, 'utf8')) as {
      routes: Record<string, unknown>[];
    };
    for (const record of seed.routes) {
      expect(Object.keys(record).sort()).toEqual(CONTRACT_FIELDS);
    }
  });

  it('does not depend on the billing package, or any other pricing code', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared.filter((name) => /billing|tariff|credit|payment|price/i.test(name))).toEqual([]);
  });

  it('imports nothing from a billing or pricing module', () => {
    const imports: string[] = [];
    for (const entry of readdirSync(SOURCE_DIR)) {
      if (!entry.endsWith('.ts')) continue;
      const text = readFileSync(`${SOURCE_DIR}${entry}`, 'utf8');
      for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1];
        if (specifier !== undefined) imports.push(specifier);
      }
    }
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((name) => /billing|tariff|credit|payment|price|usage-meter/i.test(name))).toEqual(
      [],
    );
  });
});
