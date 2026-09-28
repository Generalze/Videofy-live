/** @author masterzee001 */
/**
 * The join between media-ingest and the route registry — asserted, because the
 * absence of this join is what the whole gate exists to fix.
 *
 * `@videofy-live/translation-routes` was written, tested and declared in this
 * service's package.json while NO source file imported it. Its own tests passed
 * throughout. That is the difference between "the registry works" and "the
 * service asks it", and only the second one protects anybody.
 *
 * 28 SEP 2026: the join existed and asked ONE question for the whole service.
 * The wiring took a scope at construction and this service built exactly one,
 * `programme-live`, so a native call and a chat message both asked whether
 * their language pair was approved for BROADCAST. Scope now lives at the point
 * of use, and the cases below hold that: one loaded document, different
 * answers per scope, and no way to get a gate without naming one.
 */
import { describe, expect, it } from 'vitest';
import { buildTranslationGate, type RegistryLoad } from '../translation-gate-wiring.js';

const IDENTITY = { sessionId: 'ps_1', segmentId: 'seg_1', revision: 1 };
const TEXT = 'Good morning everyone.';

/**
 * A document double keyed `src->tgt:scope`, which is exactly the granularity
 * the real registry answers at. `directions()` reports every direction the
 * document NAMES, approved or not — the real registry's contract, and the one
 * the boot line has to enumerate from.
 */
function loaderApproving(...approved: string[]): () => RegistryLoad {
  const named = [...new Set(approved.map((entry) => entry.split(':')[0] ?? ''))];
  return () => ({
    ok: true,
    registry: {
      mayTranslate(source: string, target: string, scope: string) {
        return approved.includes(`${source}->${target}:${scope}`)
          ? { allowed: true as const, route: { provider: 'opus-mt' } }
          : { allowed: false as const, explanation: 'not approved' };
      },
      directions: () =>
        named.map((pair) => {
          const [sourceLanguage = '', targetLanguage = ''] = pair.split('->');
          return { sourceLanguage, targetLanguage };
        }),
    },
  });
}

describe('the gate is built from the route document', () => {
  it('approves a direction the document approves', () => {
    const wiring = buildTranslationGate({
      loadRegistry: loaderApproving('en->fr:programme-live'),
    });
    expect(wiring.failedClosed).toBe(false);
    const d = wiring.gateFor('programme-live').decide({
      sourceLanguage: 'en', targetLanguage: 'fr', text: TEXT, identity: IDENTITY,
    });
    expect(d.action).toBe('translate');
  });

  it('refuses a direction the document does not approve, and keeps the original', () => {
    const wiring = buildTranslationGate({
      loadRegistry: loaderApproving('en->fr:programme-live'),
    });
    const d = wiring.gateFor('programme-live').decide({
      sourceLanguage: 'en', targetLanguage: 'yo', text: TEXT, identity: IDENTITY,
    });
    expect(d.action).toBe('unavailable');
    if (d.action === 'unavailable') {
      expect(d.deliver).toBe(TEXT);
      expect(d.billable).toBe(false);
    }
  });
});

describe('it fails CLOSED, never open', () => {
  it('refuses everything when the document is missing', () => {
    const wiring = buildTranslationGate({
      loadRegistry: () => { throw new Error('ENOENT: no such file'); },
    });
    expect(wiring.failedClosed).toBe(true);
    expect(wiring.approvedDirectionsFor('messaging')).toEqual([]);
    const d = wiring.gateFor('messaging').decide({
      sourceLanguage: 'en', targetLanguage: 'fr', text: TEXT, identity: IDENTITY,
    });
    // The failure that must NOT happen: a missing document letting everything
    // through. Route control evaporating on a typo is indistinguishable from
    // working, right up until somebody reads the output.
    expect(d.action).toBe('unavailable');
    if (d.action === 'unavailable') expect(d.deliver).toBe(TEXT);
  });

  it('refuses EVERY scope when it has failed closed, not just the one asked first', () => {
    // The wiring hands out a gate per scope now. A failure that only covered
    // the first scope requested would be a hole shaped exactly like the defect
    // this change fixes.
    const wiring = buildTranslationGate({
      loadRegistry: () => ({ ok: false, problems: [{ message: 'route 3 has no provider' }] }),
    });
    for (const scope of ['messaging', 'programme-live', 'call-live'] as const) {
      const d = wiring.gateFor(scope).decide({
        sourceLanguage: 'en', targetLanguage: 'fr', text: TEXT, identity: IDENTITY,
      });
      expect(d.action, scope).toBe('unavailable');
      expect(wiring.approvedDirectionsFor(scope), scope).toEqual([]);
    }
  });

  it('refuses everything when the document is invalid', () => {
    const wiring = buildTranslationGate({
      loadRegistry: () => ({ ok: false, problems: [{ message: 'route 3 has no provider' }] }),
    });
    expect(wiring.failedClosed).toBe(true);
    expect(wiring.description).toContain('FAILED CLOSED');
    expect(wiring.description).toContain('route 3 has no provider');
  });

  it('still delivers the original when it has failed closed', () => {
    const wiring = buildTranslationGate({
      loadRegistry: () => ({ ok: false, problems: [] }),
    });
    const d = wiring.gateFor('messaging').decide({
      sourceLanguage: 'en', targetLanguage: 'fr',
      text: 'Please wait at the gate.', identity: IDENTITY,
    });
    expect(d.action === 'unavailable' && d.deliver).toBe('Please wait at the gate.');
  });
});

describe('scope is not a formality', () => {
  it('a messaging approval does not authorise a programme', () => {
    const wiring = buildTranslationGate({
      loadRegistry: loaderApproving('en->fr:messaging'),
    });
    const d = wiring.gateFor('programme-live').decide({
      sourceLanguage: 'en', targetLanguage: 'fr', text: TEXT, identity: IDENTITY,
    });
    expect(d.action).toBe('unavailable');
  });

  /**
   * THE PRODUCTION DEFECT, AS A UNIT TEST.
   *
   * This is the exact shape of the deployed route document on 28 Sep 2026:
   * `en->fr` reviewed and approved for calls and messages, deliberately NOT
   * approved for broadcast, because nobody has reviewed it for broadcast. One
   * document, three different correct answers. A wiring that can only hold one
   * scope cannot express this, and the one that was deployed answered the
   * broadcast question to a telephone call.
   */
  it('gives each scope its own answer from ONE loaded document', () => {
    const wiring = buildTranslationGate({
      loadRegistry: loaderApproving('en->fr:messaging', 'en->fr:call-live'),
    });
    const ask = (scope: 'messaging' | 'programme-live' | 'call-live') =>
      wiring.gateFor(scope).decide({
        sourceLanguage: 'en', targetLanguage: 'fr', text: TEXT, identity: IDENTITY,
      }).action;

    expect(ask('call-live')).toBe('translate');
    expect(ask('messaging')).toBe('translate');
    expect(ask('programme-live')).toBe('unavailable');
  });

  it('hands the same scope the same gate, so nothing can drift between callers', () => {
    const wiring = buildTranslationGate({
      loadRegistry: loaderApproving('en->fr:call-live'),
    });
    expect(wiring.gateFor('call-live')).toBe(wiring.gateFor('call-live'));
    expect(wiring.gateFor('call-live')).not.toBe(wiring.gateFor('messaging'));
  });
});

/**
 * The boot line is the instrument this defect hid from.
 *
 * It printed `approvedDirections: 0` on every deployment that ever ran,
 * because it read an `approvedDirections()` method the registry has never
 * had. A zero meaning "I did not ask" looked exactly like a zero meaning
 * "nothing is approved" — and on the deployment where the second would have
 * been alarming, the first was what was printed.
 */
describe('what the boot line may claim', () => {
  it('counts per scope, from the registry', () => {
    const wiring = buildTranslationGate({
      loadRegistry: loaderApproving('en->fr:call-live', 'fr->en:call-live', 'en->fr:messaging'),
    });
    expect(wiring.approvedDirectionsFor('call-live')).toEqual(['en->fr', 'fr->en']);
    expect(wiring.approvedDirectionsFor('messaging')).toEqual(['en->fr']);
    expect(wiring.approvedDirectionsFor('programme-live')).toEqual([]);
  });

  it('says it CANNOT enumerate rather than reporting zero', () => {
    // A loaded object with no `directions()`: the real registry's shape before
    // anybody checked, and the state that produced years of silent zeroes.
    const wiring = buildTranslationGate({
      loadRegistry: () => ({
        ok: true,
        registry: {
          mayTranslate: () => ({ allowed: true as const, route: { provider: 'opus-mt' } }),
        },
      }),
    });
    expect(wiring.failedClosed).toBe(false);
    expect(wiring.approvedDirectionsFor('call-live')).toBeNull();
    // And it must not become a refusal either: the gate still works.
    expect(
      wiring.gateFor('call-live').decide({
        sourceLanguage: 'en', targetLanguage: 'fr', text: TEXT, identity: IDENTITY,
      }).action,
    ).toBe('translate');
  });
});
