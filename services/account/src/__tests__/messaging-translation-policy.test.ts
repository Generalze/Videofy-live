/**
 * THE MESSAGING TRANSLATION RULING, OVER HTTP.
 *
 * The policy is pinned as a pure function next door; these tests pin the part
 * that actually ships a message: that DELIVERY IS AUTHORITATIVE. Whatever the
 * translation engine does -- refuse, die, hang, echo, return nothing -- the
 * recipient receives what was written, the response says honestly that
 * translation was unavailable, and nothing invented is ever stored.
 *
 * Every failure mode here is driven through the real route, with the real
 * store, and asserted on the RECIPIENT's copy rather than the sender's
 * response, because "the message went out" is the claim under test.
 */
import express from 'express';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountTrust } from '@videofy-live/account-trust';
import { AccountStore } from '../account-store.js';
import { ContactStore } from '../contact-store.js';
import { DeviceStore } from '../device-store.js';
import { MessageStore, createInMemoryMessagePort } from '../message-store.js';
import { RingRegistry } from '../ring-registry.js';
import { createInMemoryConversationModePort } from '../conversation-modes.js';
import { PushDispatcher, createRecordingPushProvider } from '../push/push-dispatcher.js';
import { registerMessageRoutes } from '../message-routes.js';
import {
  createTranslationRouteRegistryFromRecords,
  type TranslationRouteRecord,
  type TranslationRouteRegistry,
} from '../translation-route-policy.js';
import type { Caller } from '../routes.js';

const TRUST: AccountTrust = {
  email: 'verified',
  phone: 'unverified',
  identity: 'unverified',
  risk: 'normal',
  restriction: 'none',
};

function caller(accountId: string): Caller {
  return { accountId, trust: TRUST, record: {} as Caller['record'] };
}

/** A fully approved en->yo messaging route; spoil one field to refuse it. */
function route(overrides: Partial<TranslationRouteRecord> = {}): TranslationRouteRecord {
  return {
    sourceLanguage: 'en',
    targetLanguage: 'yo',
    provider: 'opus-mt',
    modelId: 'Helsinki-NLP/opus-mt-en-yo',
    executionClass: 'local',
    productionApproved: true,
    technicalEvidence: {
      sampleCount: 50,
      successRate: 0.98,
      latencyMs: { min: 30, median: 80, mean: 90, max: 400 },
      recordedAt: '2026-08-30T00:00:00.000Z',
    },
    humanReviewStatus: 'passed',
    licenceStatus: { licence: 'Apache-2.0', commercialUse: 'permitted', evidence: 'model card' },
    serviceScopes: {
      messaging: 'approved',
      'programme-live': 'unapproved',
      'call-live': 'unapproved',
    },
    ...overrides,
  };
}

interface TranslatorCall {
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
  modelId: string;
}

type TextBehaviour =
  | { kind: 'renders' }
  | { kind: 'throws' }
  | { kind: 'hangs' }
  | { kind: 'empty' }
  | { kind: 'echoes' };

interface Wire {
  messageId: string;
  body: string | null;
  translatedBody: string | null;
  translatedLanguage: string | null;
  translatedAudioAvailable: boolean;
}

interface Disposition {
  status: string;
  reason: string | null;
  provider: string | null;
}

async function harness(options: {
  routes?: readonly TranslationRouteRecord[];
  registry?: TranslationRouteRegistry;
  text?: TextBehaviour;
  voice?: 'renders' | 'fails' | 'hangs';
}) {
  const contacts = new ContactStore();
  const store = new AccountStore();
  const conversationModes = createInMemoryConversationModePort();
  const textCalls: TranslatorCall[] = [];
  const voiceCalls: TranslatorCall[] = [];
  const events: { event: string; detail: Record<string, string | number> }[] = [];
  const behaviour = options.text ?? { kind: 'renders' };

  const app = express();
  const identityJson = express.json({ limit: '16kb' });
  app.use((req, res, next) => {
    if (/^\/messages\/with\/[^/]+\/voice$/.test(req.path)) {
      next();
      return;
    }
    identityJson(req, res, next);
  });

  registerMessageRoutes(app, {
    store,
    contacts,
    messages: new MessageStore({ port: createInMemoryMessagePort() }),
    push: new PushDispatcher({
      devices: new DeviceStore(),
      providers: [createRecordingPushProvider()],
    }),
    rings: new RingRegistry(),
    conversationModes,
    translationRoutes:
      options.registry ?? createTranslationRouteRegistryFromRecords(options.routes ?? []),
    // Short enough that a hung engine is a fast test, long enough that a
    // healthy one is never raced by accident.
    translationBudgetMs: 120,
    translator: {
      translate: async ({ sourceLanguage, targetLanguage, sourceText, route: chosen }) => {
        textCalls.push({
          sourceLanguage,
          targetLanguage,
          provider: chosen.provider,
          modelId: chosen.modelId,
        });
        if (behaviour.kind === 'throws') throw new Error('engine is down');
        if (behaviour.kind === 'hangs') return await new Promise<string>(() => {});
        if (behaviour.kind === 'empty') return '   ';
        // An engine that hands the source text back rather than translating.
        if (behaviour.kind === 'echoes') return sourceText;
        return `[${targetLanguage}] ${sourceText}`;
      },
    },
    voiceTranslator: {
      translate: async ({ sourceLanguage, targetLanguage, durationMs, route: chosen }) => {
        voiceCalls.push({
          sourceLanguage,
          targetLanguage,
          provider: chosen.provider,
          modelId: chosen.modelId,
        });
        if (options.voice === 'hangs') {
          return await new Promise<never>(() => {});
        }
        if (options.voice === 'fails') return { ok: false, stage: 'synthesize' };
        return {
          ok: true,
          rendering: {
            translatedText: `[${targetLanguage}] spoken`,
            audio: Buffer.from('RIFF-fake-translated-wav'),
            mime: 'audio/wav',
            durationMs: durationMs + 250,
          },
        };
      },
    },
    mediaDir: await mkdtemp(join(tmpdir(), 'msg-policy-')),
    callerAccountId: (req) => {
      const id = req.header('x-test-account');
      return id ? caller(id) : null;
    },
    onEvent: (event, detail) => events.push({ event, detail }),
  });

  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const as = (accountId: string, path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-test-account': accountId, ...(init.headers ?? {}) },
    });

  return {
    store,
    contacts,
    as,
    textCalls: () => textCalls,
    voiceCalls: () => voiceCalls,
    events: () => events,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/**
 * Two contacts, in translated mode, writing `sender` and reading `reader`.
 * The account languages are what the policy resolves the pair from.
 */
async function pair(app: Harness, sender: string, reader: string) {
  const first = await app.store.register({ email: 'a@t.test', password: 'long-and-sturdy-A7' });
  const second = await app.store.register({ email: 'b@t.test', password: 'long-and-sturdy-B7' });
  if (!first.ok || !second.ok) throw new Error('registration failed');
  const a = first.account.accountId;
  const b = second.account.accountId;
  await app.store.setDefaultLanguage(a, sender);
  await app.store.setDefaultLanguage(b, reader);
  await app.contacts.request(a, b);
  await app.contacts.accept(b, a);
  await app.as(a, `/messages/with/${b}/mode`, {
    method: 'POST',
    body: JSON.stringify({ mode: 'translated' }),
  });
  return { a, b };
}

async function send(app: Harness, from: string, to: string, body: string) {
  const response = await app.as(from, `/messages/with/${to}`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { message: Wire; translation: Disposition };
}

/** What the RECIPIENT actually has -- the only proof that delivery happened. */
async function received(app: Harness, reader: string, partner: string): Promise<Wire[]> {
  const body = (await (await app.as(reader, `/messages/with/${partner}`)).json()) as {
    messages: Wire[];
  };
  return body.messages;
}

let app: Harness | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('rule 1: the same language bypasses translation entirely', () => {
  it('makes no translation call and reports the bypass', async () => {
    app = await harness({ routes: [route({ sourceLanguage: 'en', targetLanguage: 'en' })] });
    const { a, b } = await pair(app, 'en', 'en');
    const sent = await send(app, a, b, 'no translation needed');

    expect(app.textCalls()).toHaveLength(0);
    expect(sent.message.body).toBe('no translation needed');
    expect(sent.message.translatedBody).toBe(null);
    expect(sent.translation.status).toBe('same-language');
  });

  it('raises no chargeable translation event', async () => {
    app = await harness({});
    const { a, b } = await pair(app, 'en', 'en');
    await send(app, a, b, 'still free');
    const translationEvents = app.events().filter((entry) => entry.event === 'message.translate');
    expect(translationEvents).toHaveLength(1);
    expect(translationEvents[0]?.detail['chargeable']).toBe(0);
    expect(translationEvents[0]?.detail['reason']).toBe('same-language');
  });
});

describe('rule 2: an approved route translates locally', () => {
  it('renders for the reader and names the approved route to the engine', async () => {
    app = await harness({ routes: [route()] });
    const { a, b } = await pair(app, 'en', 'yo');
    const sent = await send(app, a, b, 'good morning');

    expect(sent.message.body).toBe('good morning');
    expect(sent.message.translatedBody).toBe('[yo] good morning');
    expect(sent.message.translatedLanguage).toBe('yo');
    expect(sent.translation).toEqual({ status: 'translated', reason: null, provider: 'opus-mt' });
    expect(app.textCalls()).toEqual([
      {
        sourceLanguage: 'en',
        targetLanguage: 'yo',
        provider: 'opus-mt',
        modelId: 'Helsinki-NLP/opus-mt-en-yo',
      },
    ]);
  });

  it('prefers OPUS-MT over another approved local provider', async () => {
    app = await harness({
      routes: [route({ provider: 'nllb-200', modelId: 'facebook/nllb-200' }), route()],
    });
    const { a, b } = await pair(app, 'en', 'yo');
    await send(app, a, b, 'good morning');
    expect(app.textCalls()[0]?.provider).toBe('opus-mt');
  });
});

describe('rule 3: a missing, refused or failing route delivers the original', () => {
  const cases: {
    name: string;
    reason: string;
    setup: () => Promise<Harness>;
    callsEngine: boolean;
  }[] = [
    {
      name: 'no record for the direction',
      reason: 'no-route',
      callsEngine: false,
      setup: () => harness({ routes: [] }),
    },
    {
      name: 'the reverse direction only',
      reason: 'no-route',
      callsEngine: false,
      setup: () => harness({ routes: [route({ sourceLanguage: 'yo', targetLanguage: 'en' })] }),
    },
    {
      name: 'messaging refused on the record',
      reason: 'refused',
      callsEngine: false,
      setup: () =>
        harness({
          routes: [
            route({
              serviceScopes: {
                messaging: 'refused',
                'programme-live': 'approved',
                'call-live': 'approved',
              },
            }),
          ],
        }),
    },
    {
      name: 'approved for the live paths but not messaging',
      reason: 'unapproved',
      callsEngine: false,
      setup: () =>
        harness({
          routes: [
            route({
              serviceScopes: {
                messaging: 'unapproved',
                'programme-live': 'approved',
                'call-live': 'approved',
              },
            }),
          ],
        }),
    },
    {
      name: 'a cloud route, however approved',
      reason: 'cloud-only',
      callsEngine: false,
      setup: () =>
        harness({ routes: [route({ executionClass: 'cloud', provider: 'a-paid-vendor' })] }),
    },
    {
      name: 'a registry that throws',
      reason: 'no-route',
      callsEngine: false,
      setup: () =>
        harness({
          registry: {
            routesFor: () => {
              throw new Error('registry unavailable');
            },
          },
        }),
    },
    {
      name: 'a translator that throws',
      reason: 'translator-failed',
      callsEngine: true,
      setup: () => harness({ routes: [route()], text: { kind: 'throws' } }),
    },
    {
      name: 'a translator that never answers',
      reason: 'translation-timeout',
      callsEngine: true,
      setup: () => harness({ routes: [route()], text: { kind: 'hangs' } }),
    },
    {
      name: 'a translator that returns nothing',
      reason: 'translator-failed',
      callsEngine: true,
      setup: () => harness({ routes: [route()], text: { kind: 'empty' } }),
    },
    {
      name: 'a translator that echoes the original back',
      reason: 'echoed-source',
      callsEngine: true,
      setup: () => harness({ routes: [route()], text: { kind: 'echoes' } }),
    },
  ];

  for (const entry of cases) {
    it(`delivers the original and says why: ${entry.name}`, async () => {
      app = await entry.setup();
      const { a, b } = await pair(app, 'en', 'yo');
      const sent = await send(app, a, b, 'the message still arrives');

      // DELIVERY IS AUTHORITATIVE: the recipient has it, in the sender's words.
      const inbox = await received(app, b, a);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.body).toBe('the message still arrives');
      // NOTHING FABRICATED: no translation is stored, in either copy.
      expect(inbox[0]?.translatedBody).toBe(null);
      expect(inbox[0]?.translatedLanguage).toBe(null);
      expect(sent.message.translatedBody).toBe(null);
      // HONEST: unavailable, with the reason, never silence.
      expect(sent.translation.status).toBe('unavailable');
      expect(sent.translation.reason).toBe(entry.reason);
      // NO SPECULATIVE CALLS: an unapproved pair never reaches the engine.
      expect(app.textCalls().length > 0).toBe(entry.callsEngine);
    });
  }

  it('bounds the wait: a hung engine does not hold the send open', async () => {
    app = await harness({ routes: [route()], text: { kind: 'hangs' } });
    const { a, b } = await pair(app, 'en', 'yo');
    const startedAt = Date.now();
    const sent = await send(app, a, b, 'do not wait for the engine');
    // The budget is 120ms; anything near it proves the bound, and a generous
    // ceiling keeps this from flaking on a loaded machine.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(sent.translation.reason).toBe('translation-timeout');
  });

  it('an unapproved route raises no chargeable translation event', async () => {
    app = await harness({ routes: [] });
    const { a, b } = await pair(app, 'en', 'yo');
    await send(app, a, b, 'free because nothing was translated');
    const translationEvents = app.events().filter((entry) => entry.event === 'message.translate');
    expect(translationEvents).toHaveLength(1);
    expect(translationEvents[0]?.detail['chargeable']).toBe(0);
    expect(translationEvents[0]?.detail['ok']).toBe(0);
  });
});

describe('rule 4: no automatic paid cloud fallback', () => {
  it('never reaches a cloud provider when the local route fails', async () => {
    // Both an approved local route and an approved cloud one exist; the local
    // engine dies. The message goes out untranslated -- it does NOT quietly
    // become a paid cloud call.
    app = await harness({
      routes: [route(), route({ executionClass: 'cloud', provider: 'a-paid-vendor' })],
      text: { kind: 'throws' },
    });
    const { a, b } = await pair(app, 'en', 'yo');
    const sent = await send(app, a, b, 'no vendor rescue');

    expect(app.textCalls()).toHaveLength(1);
    expect(app.textCalls()[0]?.provider).toBe('opus-mt');
    expect(sent.translation.status).toBe('unavailable');
    expect(sent.message.translatedBody).toBe(null);
  });
});

describe('the voice-note translation stage obeys the same ruling', () => {
  const NOTE = Buffer.from('fake-recorded-audio').toString('base64');

  async function sendNote(harnessRef: Harness, from: string, to: string) {
    const response = await harnessRef.as(from, `/messages/with/${to}/voice`, {
      method: 'POST',
      body: JSON.stringify({ audioBase64: NOTE, durationMs: 1500 }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { message: Wire; translation: Disposition };
  }

  it('an approved route speaks the note again and names the route', async () => {
    app = await harness({ routes: [route()] });
    const { a, b } = await pair(app, 'en', 'yo');
    const sent = await sendNote(app, a, b);
    expect(sent.message.translatedAudioAvailable).toBe(true);
    expect(sent.translation).toEqual({ status: 'translated', reason: null, provider: 'opus-mt' });
    expect(app.voiceCalls()[0]?.modelId).toBe('Helsinki-NLP/opus-mt-en-yo');
  });

  it('a refused route delivers the ORIGINAL audio and invents no speech', async () => {
    app = await harness({
      routes: [
        route({
          serviceScopes: {
            messaging: 'refused',
            'programme-live': 'approved',
            'call-live': 'approved',
          },
        }),
      ],
    });
    const { a, b } = await pair(app, 'en', 'yo');
    const sent = await sendNote(app, a, b);

    expect(app.voiceCalls()).toHaveLength(0);
    expect(sent.translation).toEqual({ status: 'unavailable', reason: 'refused', provider: null });
    expect(sent.message.translatedAudioAvailable).toBe(false);
    expect(sent.message.translatedBody).toBe(null);
    // The original recording is still there for the recipient to play.
    const media = await app.as(b, `/messages/media/${sent.message.messageId}`);
    expect(media.status).toBe(200);
    // And there is no derived audio to serve.
    const derived = await app.as(b, `/messages/${sent.message.messageId}/voice/translated`);
    expect(derived.status).toBe(404);
  });

  it('the same language never asks the voice engine', async () => {
    app = await harness({ routes: [route({ targetLanguage: 'en' })] });
    const { a, b } = await pair(app, 'en', 'en');
    const sent = await sendNote(app, a, b);
    expect(app.voiceCalls()).toHaveLength(0);
    expect(sent.translation.status).toBe('same-language');
  });

  it('a failing engine leaves the note exactly as recorded', async () => {
    app = await harness({ routes: [route()], voice: 'fails' });
    const { a, b } = await pair(app, 'en', 'yo');
    const sent = await sendNote(app, a, b);
    expect(sent.message.translatedAudioAvailable).toBe(false);
    expect(sent.translation.status).toBe('unavailable');
    expect(sent.translation.reason).toBe('synthesize');
    const media = await app.as(b, `/messages/media/${sent.message.messageId}`);
    expect(media.status).toBe(200);
  });

  it('a hung engine does not hold the note open', async () => {
    app = await harness({ routes: [route()], voice: 'hangs' });
    const { a, b } = await pair(app, 'en', 'yo');
    const sent = await sendNote(app, a, b);
    expect(sent.translation.reason).toBe('translation-timeout');
    expect(sent.message.translatedAudioAvailable).toBe(false);
  });
});

describe('the conversation is told before it sends', () => {
  it('reports availability per DIRECTION, because directions are separate', async () => {
    app = await harness({ routes: [route()] });
    const { a, b } = await pair(app, 'en', 'yo');
    const mode = (await (await app.as(a, `/messages/with/${b}/mode`)).json()) as {
      mode: string;
      translation: { outgoing: Disposition; incoming: Disposition };
    };
    expect(mode.mode).toBe('translated');
    // en->yo is approved; yo->en has no record of its own.
    expect(mode.translation.outgoing).toEqual({
      status: 'available',
      reason: null,
      provider: 'opus-mt',
    });
    expect(mode.translation.incoming).toEqual({
      status: 'unavailable',
      reason: 'no-route',
      provider: null,
    });
  });

  it('turning the mode on says immediately that it cannot be honoured', async () => {
    app = await harness({ routes: [] });
    const first = await app.store.register({ email: 'c@t.test', password: 'long-and-sturdy-C7' });
    const second = await app.store.register({ email: 'd@t.test', password: 'long-and-sturdy-D7' });
    if (!first.ok || !second.ok) throw new Error('registration failed');
    const a = first.account.accountId;
    const b = second.account.accountId;
    await app.store.setDefaultLanguage(a, 'en');
    await app.store.setDefaultLanguage(b, 'ha');
    await app.contacts.request(a, b);
    await app.contacts.accept(b, a);
    const response = (await (
      await app.as(a, `/messages/with/${b}/mode`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'translated' }),
      })
    ).json()) as { mode: string; translation: { outgoing: Disposition } };
    expect(response.mode).toBe('translated');
    expect(response.translation.outgoing).toEqual({
      status: 'unavailable',
      reason: 'no-route',
      provider: null,
    });
  });
});

describe('normal mode is untouched by any of this', () => {
  it('asks no registry and no engine, and delivers as always', async () => {
    app = await harness({ routes: [route()] });
    const first = await app.store.register({ email: 'e@t.test', password: 'long-and-sturdy-E7' });
    const second = await app.store.register({ email: 'f@t.test', password: 'long-and-sturdy-F7' });
    if (!first.ok || !second.ok) throw new Error('registration failed');
    const a = first.account.accountId;
    const b = second.account.accountId;
    await app.store.setDefaultLanguage(a, 'en');
    await app.store.setDefaultLanguage(b, 'yo');
    await app.contacts.request(a, b);
    await app.contacts.accept(b, a);

    const sent = await send(app, a, b, 'plain and free');
    expect(sent.translation.status).toBe('not-requested');
    expect(app.textCalls()).toHaveLength(0);
    expect(app.events().filter((entry) => entry.event === 'message.translate')).toHaveLength(0);
    expect((await received(app, b, a))[0]?.body).toBe('plain and free');
  });
});
