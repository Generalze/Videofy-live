/** @author masterzee001 */
/**
 * The join between media-ingest and the route registry — asserted, because the
 * absence of this join is what the whole gate exists to fix.
 *
 * `@videofy-live/translation-routes` was written, tested and declared in this
 * service's package.json while NO source file imported it. Its own tests passed
 * throughout. That is the difference between "the registry works" and "the
 * service asks it", and only the second one protects anybody.
 */
import { describe, expect, it } from 'vitest';
import { buildTranslationGate, type RegistryLoad } from '../translation-gate-wiring.js';

const IDENTITY = { sessionId: 'ps_1', segmentId: 'seg_1', revision: 1 };

function loaderApproving(...directions: string[]): () => RegistryLoad {
  return () => ({
    ok: true,
    registry: {
      mayTranslate(source: string, target: string, scope: string) {
        return directions.includes(`${source}->${target}:${scope}`)
          ? { allowed: true as const, route: { provider: 'opus-mt' } }
          : { allowed: false as const, explanation: 'not approved' };
      },
      approvedDirections: () => directions,
    },
  });
}

describe('the gate is built from the route document', () => {
  it('approves a direction the document approves', () => {
    const wiring = buildTranslationGate({
      scope: 'programme-live',
      loadRegistry: loaderApproving('en->fr:programme-live'),
    });
    expect(wiring.failedClosed).toBe(false);
    const d = wiring.gate.decide({
      sourceLanguage: 'en', targetLanguage: 'fr',
      text: 'Good morning everyone.', identity: IDENTITY,
    });
    expect(d.action).toBe('translate');
  });

  it('refuses a direction the document does not approve, and keeps the original', () => {
    const wiring = buildTranslationGate({
      scope: 'programme-live',
      loadRegistry: loaderApproving('en->fr:programme-live'),
    });
    const d = wiring.gate.decide({
      sourceLanguage: 'en', targetLanguage: 'yo',
      text: 'Good morning everyone.', identity: IDENTITY,
    });
    expect(d.action).toBe('unavailable');
    if (d.action === 'unavailable') {
      expect(d.deliver).toBe('Good morning everyone.');
      expect(d.billable).toBe(false);
    }
  });
});

describe('it fails CLOSED, never open', () => {
  it('refuses everything when the document is missing', () => {
    const wiring = buildTranslationGate({
      scope: 'messaging',
      loadRegistry: () => { throw new Error('ENOENT: no such file'); },
    });
    expect(wiring.failedClosed).toBe(true);
    expect(wiring.approvedDirections).toEqual([]);
    const d = wiring.gate.decide({
      sourceLanguage: 'en', targetLanguage: 'fr',
      text: 'Good morning everyone.', identity: IDENTITY,
    });
    // The failure that must NOT happen: a missing document letting everything
    // through. Route control evaporating on a typo is indistinguishable from
    // working, right up until somebody reads the output.
    expect(d.action).toBe('unavailable');
    if (d.action === 'unavailable') expect(d.deliver).toBe('Good morning everyone.');
  });

  it('refuses everything when the document is invalid', () => {
    const wiring = buildTranslationGate({
      scope: 'messaging',
      loadRegistry: () => ({ ok: false, problems: [{ message: 'route 3 has no provider' }] }),
    });
    expect(wiring.failedClosed).toBe(true);
    expect(wiring.description).toContain('FAILED CLOSED');
    expect(wiring.description).toContain('route 3 has no provider');
  });

  it('still delivers the original when it has failed closed', () => {
    const wiring = buildTranslationGate({
      scope: 'messaging',
      loadRegistry: () => ({ ok: false, problems: [] }),
    });
    const d = wiring.gate.decide({
      sourceLanguage: 'en', targetLanguage: 'fr',
      text: 'Please wait at the gate.', identity: IDENTITY,
    });
    expect(d.action === 'unavailable' && d.deliver).toBe('Please wait at the gate.');
  });
});

describe('scope is not a formality', () => {
  it('a messaging approval does not authorise a programme', () => {
    const wiring = buildTranslationGate({
      scope: 'programme-live',
      loadRegistry: loaderApproving('en->fr:messaging'),
    });
    const d = wiring.gate.decide({
      sourceLanguage: 'en', targetLanguage: 'fr',
      text: 'Good morning everyone.', identity: IDENTITY,
    });
    expect(d.action).toBe('unavailable');
  });
});
