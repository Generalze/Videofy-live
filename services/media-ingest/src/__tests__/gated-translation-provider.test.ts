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
