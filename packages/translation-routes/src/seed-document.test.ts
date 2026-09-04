/** @author masterzee001 */
/**
 * The shipped document, checked as a document.
 *
 * Its whole job is to be a list of directions that grants NOTHING. If it ever
 * ships with an approval in it, the package's default posture flips from
 * "refuse until somebody proves it" to "allow because a file said so", which is
 * the failure this registry exists to prevent -- and it would flip silently,
 * because a JSON edit reads as data rather than as a change of policy.
 *
 * RECONCILED 2026-08-31. The document used to grant nothing the easy way: every
 * record had `technicalEvidence: null`, so there was nothing to weigh. Twelve of
 * the fourteen now carry real measurements, which makes this the harder and far
 * more useful case -- EVIDENCE EXISTS AND STILL NOTHING IS APPROVED. That is the
 * state the registry has to survive, because it is the state somebody is
 * tempted to shortcut: the numbers are green, the harness is happy, and the only
 * things standing between a measurement and a permission are a human who has not
 * read the output yet and three defects that live on every route.
 */
import { describe, expect, it } from 'vitest';

import { SERVICE_SCOPES } from './route-record.js';
import { SEED_DOCUMENT_PATH, loadTranslationRouteRegistry } from './document-file.js';
import { TranslationRouteRegistry } from './registry.js';

const DIRECTIONS = [
  'en->yo',
  'yo->en',
  'en->ha',
  'ha->en',
  'en->ig',
  'ig->en',
  'en->pcm',
  'pcm->en',
  'en->es',
  'es->en',
  'en->fr',
  'fr->en',
  'en->pt',
  'pt->en',
];

/** The six on the review-required list that have a model. Pidgin has none. */
const NIGERIAN_DIRECTIONS = [
  ['en', 'ha'],
  ['ha', 'en'],
  ['en', 'ig'],
  ['ig', 'en'],
  ['en', 'yo'],
  ['yo', 'en'],
] as const;

function seedRegistry(): TranslationRouteRegistry {
  const loaded = loadTranslationRouteRegistry({ path: SEED_DOCUMENT_PATH });
  if (!loaded.ok) {
    throw new Error(
      `the shipped seed document does not validate: ${loaded.problems
        .map((problem) => `${problem.path}: ${problem.message}`)
        .join('; ')}`,
    );
  }
  return loaded.registry;
}

describe('the shipped document', () => {
  it('validates against its own rules', () => {
    expect(loadTranslationRouteRegistry({ path: SEED_DOCUMENT_PATH }).ok).toBe(true);
  });

  it('names exactly the fourteen directions, each one only once', () => {
    const registry = seedRegistry();
    const directions = registry
      .directions()
      .map((direction) => `${direction.sourceLanguage}->${direction.targetLanguage}`);

    expect(directions).toHaveLength(14);
    expect([...directions].sort()).toEqual([...DIRECTIONS].sort());
  });

  it('carries both directions of every pair as separate records', () => {
    const registry = seedRegistry();
    for (const language of ['yo', 'ha', 'ig', 'pcm', 'es', 'fr', 'pt']) {
      const forward = registry.lookup('en', language);
      const reverse = registry.lookup(language, 'en');
      expect(forward, `en->${language}`).toBeDefined();
      expect(reverse, `${language}->en`).toBeDefined();
      expect(forward).not.toBe(reverse);
    }
  });

  it('approves nothing at all, measured or not', () => {
    const registry = seedRegistry();
    for (const record of registry.routes()) {
      const where = `${record.sourceLanguage}->${record.targetLanguage}`;
      expect(record.productionApproved, where).toBe(false);
      for (const scope of SERVICE_SCOPES) {
        expect(record.serviceScopes[scope], `${where} ${scope}`).not.toBe('approved');
      }
    }
  });

  it('refuses every direction in every scope', () => {
    const registry = seedRegistry();
    for (const direction of registry.directions()) {
      for (const scope of SERVICE_SCOPES) {
        const decision = registry.mayTranslate(
          direction.sourceLanguage,
          direction.targetLanguage,
          scope,
        );
        expect(
          decision.allowed,
          `${direction.sourceLanguage}->${direction.targetLanguage} ${scope}`,
        ).toBe(false);
      }
    }
  });

  it('MEASUREMENT DID NOT BECOME PERMISSION: twelve routes carry evidence and none is approved', () => {
    // The point of the whole wave, pinned. A route with a sample count, a
    // success rate and a latency profile is a route somebody measured -- not a
    // route anybody approved. Deleting the evidence would satisfy the previous
    // version of this test; it cannot satisfy this one.
    const registry = seedRegistry();
    const measured = registry.routes().filter((record) => record.technicalEvidence !== null);
    expect(measured).toHaveLength(12);
    for (const record of measured) {
      const where = `${record.sourceLanguage}->${record.targetLanguage}`;
      expect(record.technicalEvidence?.sampleCount, where).toBeGreaterThan(0);
      expect(record.technicalEvidence?.successRate, where).toBeGreaterThan(0);
      expect(record.productionApproved, where).toBe(false);
    }
  });

  it('every measurement says where it came from and when', () => {
    for (const record of seedRegistry().routes()) {
      const evidence = record.technicalEvidence;
      if (evidence === null) continue;
      const where = `${record.sourceLanguage}->${record.targetLanguage}`;
      expect(evidence.recordedAt, where).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(evidence.notes ?? '', where).toContain('docs/certification/');
    }
  });

  it('leaves every direction awaiting a human, Romance included', () => {
    // The benchmark lane proposed `not-required` for the six Romance
    // directions. This document declines: the same lane's own reading of fr->en
    // found "On se voit demain matin." returned as "I'll see you in the
    // morning." A dropped "tomorrow" is the wrong day, not a matter of style,
    // and a language nobody has checked is not a language known to be fine.
    const registry = seedRegistry();
    expect(registry.reviewRequiredLanguages()).toEqual(['ha', 'ig', 'pcm', 'yo']);
    for (const record of registry.routes()) {
      expect(
        record.humanReviewStatus,
        `${record.sourceLanguage}->${record.targetLanguage}`,
      ).toBe('required-not-done');
    }
  });

  it('REFUSES call-live for the six Nigerian directions, rather than merely not approving it', () => {
    // `unapproved` is "not yet" and `refused` is "decided against". This is
    // decided against: reading the X->en output found 3-4 materially wrong
    // meanings in 8 for each of ha, ig and yo, in fluent English with no signal
    // a caller can detect, and en->ha produced an 18x runaway of unrelated
    // prose. Those routes are fast and always return something, so a
    // success-rate-and-latency harness scores them well -- which is exactly why
    // the cell must not be movable by one.
    const registry = seedRegistry();
    for (const [source, target] of NIGERIAN_DIRECTIONS) {
      const record = registry.lookup(source, target);
      expect(record?.serviceScopes['call-live'], `${source}->${target}`).toBe('refused');
    }
  });

  it('names the model that would ACTUALLY serve each Nigerian direction', () => {
    // The seed named m2m100. Nothing measured m2m100 on these directions and
    // the deployed service does not use it: TRANSLATION_PROVIDER is opus-mt and
    // DEFAULT_OPUS_MT_LANGUAGE_MODELS names a Helsinki-NLP model per pair. A
    // registry naming a model that would never serve the route is the
    // unwired-seam defect in registry form.
    const registry = seedRegistry();
    for (const [source, target] of NIGERIAN_DIRECTIONS) {
      const record = registry.lookup(source, target);
      expect(record?.provider, `${source}->${target}`).toBe('opus-mt');
      expect(record?.modelId, `${source}->${target}`).toMatch(/^Helsinki-NLP\/opus-mt-/);
    }
  });

  it('records en<->pcm as a declared gap rather than inventing a model for it', () => {
    const registry = seedRegistry();
    for (const [source, target] of [
      ['en', 'pcm'],
      ['pcm', 'en'],
    ]) {
      const record = registry.lookup(source as string, target as string);
      expect(record?.provider).toBe('unassigned');
      expect(record?.technicalEvidence).toBeNull();
      const decision = registry.mayTranslate(source as string, target as string, 'messaging');
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).toBe('no-approved-route');
      expect(decision.allowed === false && decision.explanation).toContain('declared gap');
    }
  });

  it('cites a source for every licence cell', () => {
    for (const record of seedRegistry().routes()) {
      expect(
        record.licenceStatus.evidence.length,
        `${record.sourceLanguage}->${record.targetLanguage}`,
      ).toBeGreaterThan(20);
    }
  });

  it('keeps commercial use UNKNOWN even where the licence identifier is permissive', () => {
    // Apache-2.0 was read twice per model id, so the IDENTIFIER is established.
    // Its OBLIGATIONS were not read by anyone, and ai-registry still records
    // commercialUseState 'review-required' for the same assets. Under this
    // document `unknown` blocks production approval, so the gap between "the
    // licence probably permits this" and "somebody checked" is load-bearing.
    for (const record of seedRegistry().routes()) {
      expect(
        record.licenceStatus.commercialUse,
        `${record.sourceLanguage}->${record.targetLanguage}`,
      ).toBe('unknown');
    }
  });
});
