/** @author masterzee001 */
/**
 * The inner provider is NEVER invoked for a refused route — counted, not assumed.
 *
 * "The engine ran but we discarded the result" is still a paid call, a latency
 * cost, and somebody's message sitting in a vendor's logs. So every case below
 * asserts an invocation COUNT, which is the only assertion that can tell the
 * difference between "refused" and "ran and ignored".
 */
import { describe, expect, it } from 'vitest';
import { GatedTranslationProvider } from '../gated-translation-provider.js';
import { createTranslationGate, type RouteGate } from '../translation-gate.js';
import { buildTranslationGate } from '../translation-gate-wiring.js';
import type {
  TimestampedTranslationProvider,
  TranslationProviderInput,
} from '../translation-provider.js';

/** Counts every call, and records what it was actually handed. */
function spyProvider() {
  const calls: TranslationProviderInput[] = [];
  const provider: TimestampedTranslationProvider = {
    name: 'spy',
    async translate(input) {
      calls.push(input);
      return { translatedText: `TRANSLATED(${input.sourceText})`, providerName: 'spy' };
    },
  };
  return { provider, calls };
}

function routeGate(...approved: string[]): RouteGate {
  return {
    mayTranslate: (s, t, scope) =>
      approved.includes(`${s}->${t}:${scope}`)
        ? { allowed: true, route: { provider: 'opus-mt' } }
        : { allowed: false, explanation: 'not approved' },
  };
}

function build(approved: string[], maxCharacters?: number) {
  const spy = spyProvider();
  const outcomes: { action: string; billable: boolean; reason?: string | undefined }[] = [];
  const provider = new GatedTranslationProvider({
    inner: spy.provider,
    gate: createTranslationGate({
      gate: routeGate(...approved),
      scope: 'programme-live',
      ...(maxCharacters === undefined ? {} : { maxCharacters }),
    }),
    onOutcome: (o) => outcomes.push({ action: o.action, billable: o.billable, reason: o.reason }),
  });
  return { provider, calls: spy.calls, outcomes };
}

function input(over: Partial<TranslationProviderInput> = {}): TranslationProviderInput {
  return {
    sessionId: 'ps_1', streamId: 'st_1', segmentId: 'seg_1', sequence: 1,
    sourceLanguage: 'en', targetLanguage: 'fr',
    sourceText: 'Good morning everyone.', startMs: 0, endMs: 1000, ...over,
  };
}

/** A gated provider carrying programme vocabulary. Shared by the blocks below. */
function withTerms(terms: { term: string; canonicalRendering?: string }[]) {
  const spy = spyProvider();
  const outcomes: { action: string; billable: boolean; reason?: string | undefined }[] = [];
  const provider = new GatedTranslationProvider({
    inner: spy.provider,
    gate: createTranslationGate({
      gate: routeGate('en->fr:programme-live'),
      scope: 'programme-live',
      protectedTerms: terms,
    }),
    onOutcome: (o) => outcomes.push({ action: o.action, billable: o.billable, reason: o.reason }),
  });
  return { provider, calls: spy.calls, outcomes };
}

describe('the provider is not invoked for a refused route', () => {
  it('unapproved direction: zero invocations, original preserved, zero charge', async () => {
    const h = build(['en->fr:programme-live']);
    const r = await h.provider.translate(input({ targetLanguage: 'yo' }));
    expect(h.calls).toHaveLength(0);
    expect(r.translatedText).toBe('Good morning everyone.');
    expect(h.outcomes[0]?.billable).toBe(false);
  });

  it('empty input: zero invocations', async () => {
    const h = build(['en->fr:programme-live']);
    const r = await h.provider.translate(input({ sourceText: '   ' }));
    expect(h.calls).toHaveLength(0);
    expect(r.translatedText).toBe('   ');
  });

  it.each(['👍👍', '???!!!', '45000', 'OTP-483920'])(
    'non-linguistic input %s: zero invocations', async (text) => {
      const h = build(['en->fr:programme-live']);
      const r = await h.provider.translate(input({ sourceText: text }));
      expect(h.calls).toHaveLength(0);
      expect(r.translatedText).toBe(text);
    });

  it('too-long input: zero invocations, whole original preserved', async () => {
    const h = build(['en->fr:programme-live'], 40);
    const long = 'x'.repeat(60) + ' and do not send the payment yet.';
    const r = await h.provider.translate(input({ sourceText: long }));
    expect(h.calls).toHaveLength(0);
    expect(r.translatedText).toBe(long);
    expect(r.translatedText).toContain('do not send the payment yet');
  });

  it('same language: zero invocations, zero charge', async () => {
    const h = build(['en->fr:programme-live']);
    const r = await h.provider.translate(input({ targetLanguage: 'en' }));
    expect(h.calls).toHaveLength(0);
    expect(r.translatedText).toBe('Good morning everyone.');
    expect(h.outcomes[0]?.billable).toBe(false);
  });

  it('messaging approval does not authorise a programme', async () => {
    const h = build(['en->fr:messaging']);   // wrong scope for this gate
    await h.provider.translate(input());
    expect(h.calls).toHaveLength(0);
  });
});

describe('a missing or invalid registry refuses, and still does not invoke', () => {
  async function withWiring(loadRegistry: () => never | { ok: false; problems: [] }) {
    const spy = spyProvider();
    const wiring = buildTranslationGate({ scope: 'programme-live', loadRegistry: loadRegistry as never });
    const provider = new GatedTranslationProvider({ inner: spy.provider, gate: wiring.gate });
    const r = await provider.translate(input());
    return { calls: spy.calls, text: r.translatedText, wiring };
  }

  it('missing registry: zero invocations, original preserved', async () => {
    const out = await withWiring(() => { throw new Error('ENOENT'); });
    expect(out.wiring.failedClosed).toBe(true);
    expect(out.calls).toHaveLength(0);
    expect(out.text).toBe('Good morning everyone.');
  });

  it('invalid registry: zero invocations, original preserved', async () => {
    const out = await withWiring(() => ({ ok: false, problems: [] }));
    expect(out.calls).toHaveLength(0);
    expect(out.text).toBe('Good morning everyone.');
  });
});

describe('an approved exact route invokes the provider once', () => {
  it('calls exactly once and returns the translation', async () => {
    const h = build(['en->fr:programme-live']);
    const r = await h.provider.translate(input());
    expect(h.calls).toHaveLength(1);
    expect(r.translatedText).toBe('TRANSLATED(Good morning everyone.)');
    expect(h.outcomes[0]).toMatchObject({ action: 'translate', billable: true });
  });

  it('hands the engine masked text, never a raw identifier', async () => {
    const h = build(['en->fr:programme-live']);
    await h.provider.translate(input({ sourceText: 'Call 08031234567 today.' }));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.sourceText).not.toContain('08031234567');
  });

  it('restores the identifier byte-for-byte in the result', async () => {
    const h = build(['en->fr:programme-live']);
    const r = await h.provider.translate(input({ sourceText: 'Call 08031234567 today.' }));
    expect(r.translatedText).toContain('08031234567');
  });
});

describe('programme vocabulary: do-not-translate is protected like an identifier', () => {
  it('the provider never sees the raw protected term', async () => {
    const h = withTerms([{ term: 'Ọ̀gbẹ́ni Adéyẹmí' }]);
    await h.provider.translate(input({ sourceText: 'Welcome Ọ̀gbẹ́ni Adéyẹmí to the show.' }));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.sourceText).not.toContain('Ọ̀gbẹ́ni Adéyẹmí');
  });

  it('restores the exact configured rendering', async () => {
    const h = withTerms([{ term: 'Ọ̀gbẹ́ni Adéyẹmí' }]);
    const r = await h.provider.translate(
      input({ sourceText: 'Welcome Ọ̀gbẹ́ni Adéyẹmí to the show.' }));
    expect(r.translatedText).toContain('Ọ̀gbẹ́ni Adéyẹmí');
  });

  it('protects the LONGEST configured term, not a fragment of it', async () => {
    const h = withTerms([{ term: 'Lagos' }, { term: 'First Bank of Lagos' }]);
    await h.provider.translate(input({ sourceText: 'Go to First Bank of Lagos today.' }));
    expect(h.calls[0]?.sourceText).not.toContain('First Bank of Lagos');
  });

  it('surfaces a lost marker instead of delivering corrupted output', async () => {
    const outcomes: { reason?: string | undefined; billable: boolean }[] = [];
    const provider = new GatedTranslationProvider({
      inner: {
        name: 'losing',
        // The engine dropped the marker -- the presenter's name is simply gone.
        async translate() { return { translatedText: 'Bienvenue a l emission.' }; },
      },
      gate: createTranslationGate({
        gate: routeGate('en->fr:programme-live'), scope: 'programme-live',
        protectedTerms: [{ term: 'Ọ̀gbẹ́ni Adéyẹmí' }],
      }),
      onOutcome: (o) => outcomes.push({ reason: o.reason, billable: o.billable }),
    });
    const source = 'Welcome Ọ̀gbẹ́ni Adéyẹmí to the show.';
    const r = await provider.translate(input({ sourceText: source }));
    expect(r.translatedText).toBe(source);
    expect(outcomes[0]).toMatchObject({ reason: 'identifier-corrupted', billable: false });
  });

  it("one programme's terms cannot reach another: the gate holds only what it was given", async () => {
    // Programme B's gate is built with no terms. Even with A's name in the
    // text, nothing is protected -- because isolation is enforced by WHAT THE
    // GATE WAS BUILT WITH, not by a filter the caller might forget.
    const h = withTerms([]);
    await h.provider.translate(input({ sourceText: 'Welcome Ọ̀gbẹ́ni Adéyẹmí to the show.' }));
    expect(h.calls[0]?.sourceText).toContain('Ọ̀gbẹ́ni Adéyẹmí');
  });
});

describe('canonical rendering is tied to a matched span, never output-wide', () => {
  it('doNotTranslate + canonicalRendering: engine never sees the raw term, canonical restored', async () => {
    const h = withTerms([{ term: 'Adeyemi', canonicalRendering: 'Ọ̀gbẹ́ni Adéyẹmí' }]);
    const r = await h.provider.translate(input({ sourceText: 'Welcome Adeyemi to the show.' }));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.sourceText).not.toContain('Adeyemi');
    expect(r.translatedText).toContain('Ọ̀gbẹ́ni Adéyẹmí');
    expect(r.translatedText).not.toContain('Adeyemi ');
  });

  it('doNotTranslate + NO canonicalRendering: the exact source rendering comes back', async () => {
    const h = withTerms([{ term: 'Adeyemi' }]);
    const r = await h.provider.translate(input({ sourceText: 'Welcome Adeyemi to the show.' }));
    expect(r.translatedText).toContain('Adeyemi');
  });

  it('an empty canonicalRendering is treated as none, not as an erasure', async () => {
    const h = withTerms([{ term: 'Adeyemi', canonicalRendering: '   ' }]);
    const r = await h.provider.translate(input({ sourceText: 'Welcome Adeyemi to the show.' }));
    expect(r.translatedText).toContain('Adeyemi');
  });

  it('does NOT rewrite provider output that merely resembles a term', async () => {
    // THE RULE. `Lagos` is configured, and the engine independently produced the
    // word `Lagos` somewhere the source never had it. An output-wide search and
    // replace would rewrite that -- corrupting a sentence the translator wrote
    // correctly. Restoration happens only at the marker this span left behind.
    const spy = spyProvider();
    const provider = new GatedTranslationProvider({
      inner: {
        name: 'inventive',
        async translate(i) {
          spy.calls.push(i);
          // Source had no `Lagos`; the engine put one in on its own.
          return { translatedText: 'Bienvenue a Lagos et bonne journee.' };
        },
      },
      gate: createTranslationGate({
        gate: routeGate('en->fr:programme-live'),
        scope: 'programme-live',
        protectedTerms: [{ term: 'Lagos', canonicalRendering: 'Èkó' }],
      }),
    });
    const r = await provider.translate(input({ sourceText: 'Welcome to the show.' }));
    // Untouched: no span matched, so nothing is substituted.
    expect(r.translatedText).toBe('Bienvenue a Lagos et bonne journee.');
    expect(r.translatedText).not.toContain('Èkó');
  });

  it('applies the canonical rendering only where the term actually matched', async () => {
    const spy = spyProvider();
    const provider = new GatedTranslationProvider({
      inner: {
        name: 'echo',
        async translate(i) {
          spy.calls.push(i);
          // The engine keeps the marker and adds a stray `Lagos` of its own.
          return { translatedText: `${i.sourceText} et aussi Lagos.` };
        },
      },
      gate: createTranslationGate({
        gate: routeGate('en->fr:programme-live'),
        scope: 'programme-live',
        protectedTerms: [{ term: 'Lagos', canonicalRendering: 'Èkó' }],
      }),
    });
    const r = await provider.translate(input({ sourceText: 'Broadcasting from Lagos.' }));
    // The matched one became Èkó; the engine's own stray one did not.
    expect(r.translatedText).toContain('Èkó');
    expect(r.translatedText).toContain('et aussi Lagos.');
  });

  it('keeps longest-match and Unicode behaviour with canonical renderings', async () => {
    const h = withTerms([
      { term: 'Lagos', canonicalRendering: 'Èkó' },
      { term: 'First Bank of Lagos', canonicalRendering: 'FBL' },
    ]);
    const r = await h.provider.translate(input({ sourceText: 'Go to First Bank of Lagos.' }));
    expect(r.translatedText).toContain('FBL');
    expect(r.translatedText).not.toContain('Èkó');
  });

  it('an identifier is never rewritten, canonical renderings notwithstanding', async () => {
    // There is no agreed spelling for a phone number; there is only the number.
    const h = withTerms([{ term: 'Lagos', canonicalRendering: 'Èkó' }]);
    const r = await h.provider.translate(
      input({ sourceText: 'Call 08031234567 from Lagos.' }));
    expect(r.translatedText).toContain('08031234567');
    expect(r.translatedText).toContain('Èkó');
  });
});

describe('an engine that loses an identifier has not translated the message', () => {
  it('returns the ORIGINAL and charges nothing', async () => {
    const calls: TranslationProviderInput[] = [];
    const outcomes: { action: string; billable: boolean; reason?: string | undefined }[] = [];
    const provider = new GatedTranslationProvider({
      inner: {
        name: 'losing',
        async translate(i) {
          calls.push(i);
          // What OPUS-MT did: the identifier came back altered.
          return { translatedText: 'Appelle 08031,32367 aujourd hui.' };
        },
      },
      gate: createTranslationGate({
        gate: routeGate('en->fr:programme-live'), scope: 'programme-live',
      }),
      onOutcome: (o) => outcomes.push({ action: o.action, billable: o.billable, reason: o.reason }),
    });
    const r = await provider.translate(input({ sourceText: 'Call 08031234567 today.' }));
    expect(calls).toHaveLength(1);
    expect(r.translatedText).toBe('Call 08031234567 today.');
    expect(outcomes[0]).toMatchObject({ reason: 'identifier-corrupted', billable: false });
  });
});

describe('provider failure', () => {
  it('delivers the original and charges nothing', async () => {
    const outcomes: { billable: boolean; reason?: string | undefined }[] = [];
    const provider = new GatedTranslationProvider({
      inner: { name: 'broken', async translate() { throw new Error('engine 502'); } },
      gate: createTranslationGate({
        gate: routeGate('en->fr:programme-live'), scope: 'programme-live',
      }),
      onOutcome: (o) => outcomes.push({ billable: o.billable, reason: o.reason }),
    });
    const r = await provider.translate(input());
    expect(r.translatedText).toBe('Good morning everyone.');
    expect(outcomes[0]).toMatchObject({ reason: 'provider-failed', billable: false });
  });
});

describe('billing identity: a retry is not a revision', () => {
  async function keyFor(sequence: number) {
    const keys: (string | undefined)[] = [];
    const provider = new GatedTranslationProvider({
      inner: spyProvider().provider,
      gate: createTranslationGate({
        gate: routeGate('en->fr:programme-live'), scope: 'programme-live',
      }),
      onOutcome: (o) => keys.push(o.billingKey),
    });
    await provider.translate(input({ sequence }));
    return keys[0];
  }

  it('an exact retry carries the SAME key, so one sentence is charged once', async () => {
    expect(await keyFor(1)).toBe(await keyFor(1));
  });

  it('a NEWER revision carries a DIFFERENT key', async () => {
    // A corrected final is not a transport retry. Collapsing revision 2 into
    // revision 1 would make every correction free -- and, worse, would hide
    // that a second translation was performed at all.
    expect(await keyFor(2)).not.toBe(await keyFor(1));
  });
});
