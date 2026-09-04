/** @author masterzee001 */
/**
 * The translation gate: every rule the CTO directive of 31 Aug 2026 made
 * mandatory, and every one of them is a defect this project actually shipped or
 * measured.
 *
 *   A empty/whitespace bypass          never reaches a model
 *   B non-linguistic bypass            emoji, punctuation, bare numbers, codes
 *   C identifier protection            phone/OTP/account/URL/email survive
 *   D long input                       REFUSES, never truncates
 *   E timeout / provider failure       original still delivered
 *     directional registry             consulted for the exact direction
 *     billing                          nothing charged unless it translated
 *     retries                          one sentence, one charge
 */
import { describe, expect, it } from 'vitest';
import {
  createTranslationGate,
  isNonLinguistic,
  protectIdentifiers,
  restoreIdentifiers,
  type RouteGate,
} from '../translation-gate.js';

/** A registry that approves exactly what it is told to, and nothing else. */
function gateAllowing(...directions: string[]): RouteGate {
  return {
    mayTranslate(source, target, scope) {
      const key = `${source}->${target}:${scope}`;
      if (directions.includes(key)) {
        return { allowed: true, route: { provider: 'opus-mt' } };
      }
      return {
        allowed: false,
        reason: 'no-approved-route',
        explanation: `No approved ${scope} route for ${source} to ${target}.`,
      };
    },
  };
}

const IDENTITY = { sessionId: 'ps_1', segmentId: 'seg_1', revision: 1 };

function gate(directions: string[] = ['en->fr:messaging'], maxCharacters?: number) {
  return createTranslationGate({
    gate: gateAllowing(...directions),
    scope: 'messaging',
    ...(maxCharacters === undefined ? {} : { maxCharacters }),
  });
}

function decide(g: ReturnType<typeof gate>, text: string, source = 'en', target = 'fr') {
  return g.decide({ sourceLanguage: source, targetLanguage: target, text, identity: IDENTITY });
}

describe('A. empty and whitespace', () => {
  it('bypasses empty input without reaching a model', () => {
    const d = decide(gate(), '');
    expect(d.action).toBe('bypass');
    if (d.action === 'bypass') expect(d.reason).toBe('empty');
  });

  it('bypasses whitespace-only input and delivers it unchanged', () => {
    const d = decide(gate(), '   \n  ');
    expect(d.action).toBe('bypass');
    if (d.action === 'bypass') expect(d.deliver).toBe('   \n  ');
  });

  it('never bills for a bypass', () => {
    expect(decide(gate(), '').billable).toBe(false);
  });
});

describe('B. non-linguistic input', () => {
  it.each(['👍👍', '???!!!', '45000', 'OTP-483920', '...', '#'])(
    'bypasses %s rather than asking a model to translate it',
    (text) => {
      const d = decide(gate(), text);
      expect(d.action).toBe('bypass');
      expect(d.billable).toBe(false);
    },
  );

  it('does not mistake a real sentence for non-linguistic input', () => {
    expect(isNonLinguistic('Send 45000 now')).toBe(false);
    expect(decide(gate(), 'Send 45000 now').action).toBe('translate');
  });

  it('treats unchanged output as a BYPASS, not a translation success', () => {
    // The distinction the screen exposed: a model returning `45000` unchanged
    // is behaving correctly, and counting it as a successful translation would
    // inflate quality and charge for nothing.
    const d = decide(gate(), '45000');
    expect(d.action).toBe('bypass');
    expect(d.action === 'bypass' && d.reason).toBe('identifier-only');
  });
});

describe('C. identifier protection', () => {
  it.each([
    ['a phone number', 'Call me on 08031234567 when you arrive.', '08031234567'],
    ['an account number', 'Transfer to account 0123456789 today.', '0123456789'],
    ['an OTP', 'Your code is 483920. Do not share it.', '483920'],
    ['a URL', 'Read https://consummate7.com/help first.', 'https://consummate7.com/help'],
    ['an email', 'Write to hello@consummate7.com today.', 'hello@consummate7.com'],
  ])('masks and restores %s byte-for-byte', (_label, text, identifier) => {
    const { masked, identifiers } = protectIdentifiers(text);
    expect(masked).not.toContain(identifier);
    expect(identifiers.map((s) => s.matched)).toContain(identifier);

    // The engine translates the words around the marker and leaves it alone.
    const restored = restoreIdentifiers(masked, identifiers);
    expect(restored.text).toContain(identifier);
    expect(restored.corrupted).toEqual([]);
  });

  it('reports an identifier the engine dropped rather than hiding it', () => {
    // OPUS-MT turned 08031234567 into 08031,32367 in the Phase-1 screen. An
    // engine that loses the marker must not produce a quietly wrong message.
    const { masked, identifiers } = protectIdentifiers('Call 08031234567 now.');
    const mangled = masked.replace(/⟦ID\d+⟧/u, 'quelque chose');
    const restored = restoreIdentifiers(mangled, identifiers);
    expect(restored.corrupted).toEqual(['08031234567']);
  });

  it('does not let the phone pattern eat the digits inside a URL', () => {
    const { identifiers } = protectIdentifiers('See https://example.com/2026/08/31 today.');
    expect(identifiers.map((s) => s.matched)).toEqual(['https://example.com/2026/08/31']);
  });

  it('hands the engine text with no raw identifier in it', () => {
    const d = decide(gate(), 'Send 45,000 to 0123456789 before 5pm.');
    expect(d.action).toBe('translate');
    if (d.action === 'translate') expect(d.textForEngine).not.toContain('0123456789');
  });
});

describe('D. long input', () => {
  it('REFUSES rather than truncating, and delivers the original whole', () => {
    const long = 'x'.repeat(60) + ' and do not send the payment yet.';
    const d = decide(gate(['en->fr:messaging'], 40), long);
    expect(d.action).toBe('unavailable');
    if (d.action === 'unavailable') {
      expect(d.reason).toBe('too-long');
      // The whole message, including the half a truncation would have removed.
      expect(d.deliver).toBe(long);
      expect(d.deliver).toContain('do not send the payment yet');
      expect(d.billable).toBe(false);
    }
  });
});

describe('E. failure and timeout', () => {
  it('delivers the original on a provider failure, and charges nothing', () => {
    const g = gate();
    const out = g.failed('Please wait at the gate.', 'provider-failed', 'engine returned 502');
    expect(out.deliver).toBe('Please wait at the gate.');
    expect(out.billable).toBe(false);
  });

  it('delivers the original on a timeout', () => {
    const out = gate().failed('I am on my way.', 'timeout', 'exceeded 8000 ms');
    expect(out.action).toBe('unavailable');
    expect(out.deliver).toBe('I am on my way.');
    expect(out.billable).toBe(false);
  });
});

describe('the directional registry is the authority', () => {
  it('translates only the exact approved direction', () => {
    const g = gate(['en->fr:messaging']);
    expect(decide(g, 'Good morning.', 'en', 'fr').action).toBe('translate');
    // The reverse of an approved direction is NOT approved. C7 routes are
    // directional, and a registry that answered for the pair would promote a
    // direction nobody reviewed.
    expect(decide(g, 'Bonjour.', 'fr', 'en').action).toBe('unavailable');
  });

  it('refuses an unapproved direction and still delivers the original', () => {
    const d = decide(gate(['en->fr:messaging']), 'Good morning.', 'en', 'yo');
    expect(d.action).toBe('unavailable');
    if (d.action === 'unavailable') {
      expect(d.reason).toBe('route-not-approved');
      expect(d.deliver).toBe('Good morning.');
      expect(d.billable).toBe(false);
    }
  });

  it('is scope-specific: messaging approval is not programme approval', () => {
    const programme = createTranslationGate({
      gate: gateAllowing('en->fr:messaging'),
      scope: 'programme-live',
    });
    const d = programme.decide({
      sourceLanguage: 'en', targetLanguage: 'fr',
      text: 'Good morning.', identity: IDENTITY,
    });
    expect(d.action).toBe('unavailable');
  });
});

describe('billing', () => {
  it('bills only a real translation', () => {
    expect(decide(gate(), 'Good morning everyone.').billable).toBe(true);
    expect(decide(gate(), '').billable).toBe(false);
    expect(decide(gate(), '👍').billable).toBe(false);
    expect(decide(gate(), 'Good morning.', 'en', 'en').billable).toBe(false);
    expect(decide(gate(), 'Good morning.', 'en', 'yo').billable).toBe(false);
  });

  it('never bills the same-language bypass', () => {
    const d = decide(gate(), 'Good morning everyone.', 'en', 'en');
    expect(d.action).toBe('bypass');
    if (d.action === 'bypass') expect(d.reason).toBe('same-language');
  });

  it('gives a retry the SAME billing key, so one sentence is charged once', () => {
    const g = gate();
    const first = decide(g, 'Good morning everyone.');
    const retry = decide(g, 'Good morning everyone.');
    expect(first.action).toBe('translate');
    if (first.action === 'translate' && retry.action === 'translate') {
      expect(retry.billingKey).toBe(first.billingKey);
    }
  });

  it('does not collide when ids concatenate to the same string', () => {
    // The bug this pins: joining the key fields with an EMPTY string lets
    // ("ab","c") and ("a","bc") hash identically. For a billing key that is two
    // different segments sharing one charge -- one silently free, the other
    // silently double-counted. An edit did exactly that, and only this shape of
    // test catches it, because every other assertion still passes.
    const g = gate();
    const a = g.decide({
      sourceLanguage: 'en', targetLanguage: 'fr', text: 'One.',
      identity: { sessionId: 'ab', segmentId: 'c', revision: 1 },
    });
    const b = g.decide({
      sourceLanguage: 'en', targetLanguage: 'fr', text: 'One.',
      identity: { sessionId: 'a', segmentId: 'bc', revision: 1 },
    });
    if (a.action === 'translate' && b.action === 'translate') {
      expect(a.billingKey).not.toBe(b.billingKey);
    } else {
      throw new Error('both should have been translatable');
    }
  });

  it('gives a different segment a different key', () => {
    const g = gate();
    const a = g.decide({
      sourceLanguage: 'en', targetLanguage: 'fr', text: 'One.',
      identity: { sessionId: 'ps_1', segmentId: 'seg_1', revision: 1 },
    });
    const b = g.decide({
      sourceLanguage: 'en', targetLanguage: 'fr', text: 'Two.',
      identity: { sessionId: 'ps_1', segmentId: 'seg_2', revision: 1 },
    });
    if (a.action === 'translate' && b.action === 'translate') {
      expect(a.billingKey).not.toBe(b.billingKey);
    }
  });
});

describe('the original is never lost', () => {
  it.each([
    ['empty', ''],
    ['emoji', '👍👍'],
    ['unapproved route', 'Good morning.'],
    ['too long', 'x'.repeat(500)],
  ])('%s still yields deliverable text', (_label, text) => {
    const d = decide(gate(['en->fr:messaging'], 100), text, 'en', 'yo');
    const deliverable = d.action === 'translate' ? text : d.deliver;
    expect(deliverable).toBe(text);
  });
});
