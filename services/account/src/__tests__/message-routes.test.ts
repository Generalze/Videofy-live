/**
 * Reaching a contact, over HTTP.
 *
 * The permission model is the contact graph and nothing else, so most of these
 * tests are about who is turned away and what they can learn from it. The one
 * answer to all of them must be an identical 404 -- a messaging surface that
 * distinguishes "not your contact" from "no such account" is an oracle for
 * both the account list and the social graph.
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
import {
  createInMemoryConversationModePort,
  type ConversationModePort,
} from '../conversation-modes.js';
import { PushDispatcher, createRecordingPushProvider } from '../push/push-dispatcher.js';
import { registerMessageRoutes } from '../message-routes.js';
import {
  createTranslationRouteRegistryFromRecords,
  type TranslationRouteRecord,
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

interface Harness {
  rings: RingRegistry;
  url: string;
  contacts: ContactStore;
  provider: ReturnType<typeof createRecordingPushProvider>;
  close: () => Promise<void>;
  as: (accountId: string, path: string, init?: RequestInit) => Promise<Response>;
  conversationModes: ConversationModePort;
  setTranslatorAvailable: (value: boolean) => void;
  /** How many times the voice-note translator was asked; the fake returns a WAV stub. */
  voiceTranslations: () => number;
  /** Every text-translation call the routes made, with the route they named. */
  translatorCalls: () => readonly { sourceLanguage: string; targetLanguage: string; provider: string }[];
  store: AccountStore;
}

/** What the fake voice translator speaks back; recognisable, never real audio. */
const FAKE_TRANSLATED_AUDIO = Buffer.from('RIFF-fake-translated-wav');

/**
 * An APPROVED messaging route, in the registry's own shape. Everything the
 * policy demands is present and true here, so a test that flips ONE field
 * proves that field is what does the refusing.
 */
export function approvedRoute(
  sourceLanguage: string,
  targetLanguage: string,
  overrides: Partial<TranslationRouteRecord> = {},
): TranslationRouteRecord {
  return {
    sourceLanguage,
    targetLanguage,
    provider: 'opus-mt',
    modelId: `Helsinki-NLP/opus-mt-${sourceLanguage}-${targetLanguage}`,
    executionClass: 'local',
    productionApproved: true,
    technicalEvidence: {
      sampleCount: 40,
      successRate: 1,
      latencyMs: { min: 40, median: 90, mean: 95, max: 300 },
      recordedAt: '2026-08-30T00:00:00.000Z',
    },
    humanReviewStatus: 'passed',
    licenceStatus: {
      licence: 'Apache-2.0',
      commercialUse: 'permitted',
      evidence: 'model card, fixture',
    },
    serviceScopes: {
      messaging: 'approved',
      'programme-live': 'unapproved',
      'call-live': 'unapproved',
    },
    ...overrides,
  };
}

async function harness(
  options: { routes?: readonly TranslationRouteRecord[] } = {},
): Promise<Harness> {
  const contacts = new ContactStore();
  const devices = new DeviceStore();
  const provider = createRecordingPushProvider();
  // acct_b owns a phone, so pushes to them are observable.
  await devices.register({
    deviceId: 'dev_b',
    accountId: 'acct_b',
    platform: 'android',
    pushToken: 'tok_b',
  });

  const rings = new RingRegistry();
  const conversationModes = createInMemoryConversationModePort();
  let translatorAvailable = true;
  let voiceTranslations = 0;
  /*
   * The default registry approves the pair these tests speak (en<->es) with
   * OPUS-MT, so the existing expectations exercise the APPROVED path. A test
   * that wants a missing or refused route passes its own records.
   */
  const routes =
    options.routes ?? [approvedRoute('en', 'es'), approvedRoute('es', 'en')];
  const translatorCalls: { sourceLanguage: string; targetLanguage: string; provider: string }[] =
    [];
  const app = express();
  /*
   * Mirrors index.ts: the global identity parser steps aside for the routes
   * that parse their own bodies. The old harness mounted a bare global 16kb
   * parser, which is precisely why the production bug -- every real-sized
   * voice note dying as a 413 before the route's own 6mb parser ran -- never
   * showed here: the tests all sent tiny bodies.
   */
  const identityJson = express.json({ limit: '16kb' });
  app.use((req, res, next) => {
    if (/^\/messages\/with\/[^/]+\/voice$/.test(req.path)) {
      next();
      return;
    }
    identityJson(req, res, next);
  });
  const store = new AccountStore();
  registerMessageRoutes(app, {
    store,
    contacts,
    messages: new MessageStore({ port: createInMemoryMessagePort() }),
    push: new PushDispatcher({ devices, providers: [provider] }),
    rings,
    conversationModes,
    // The fake translator marks its output so a test can tell rendering from original.
    translationRoutes: createTranslationRouteRegistryFromRecords(routes),
    translator: {
      translate: async ({ sourceLanguage, targetLanguage, sourceText, route }) => {
        translatorCalls.push({ sourceLanguage, targetLanguage, provider: route.provider });
        return translatorAvailable ? `[${targetLanguage}] ${sourceText}` : null;
      },
    },
    // Same switch governs the voice-note line; the fake never sees real audio.
    voiceTranslator: {
      translate: async ({ targetLanguage, durationMs }) => {
        voiceTranslations += 1;
        return translatorAvailable
          ? {
              ok: true,
              rendering: {
                translatedText: `[${targetLanguage}] spoken`,
                audio: FAKE_TRANSLATED_AUDIO,
                mime: 'audio/wav',
                durationMs: durationMs + 250,
              },
            }
          : { ok: false, stage: 'synthesize' };
      },
    },
    mediaDir: await mkdtemp(join(tmpdir(), 'msg-media-')),
    callerAccountId: (req) => {
      const id = req.header('x-test-account');
      return id ? caller(id) : null;
    },
  });

  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    contacts,
    provider,
    rings,
    conversationModes,
    setTranslatorAvailable: (value: boolean) => {
      translatorAvailable = value;
    },
    voiceTranslations: () => voiceTranslations,
    translatorCalls: () => translatorCalls,
    store,
    close: () => new Promise<void>((r) => server.close(() => r())),
    as: (accountId, path, init = {}) =>
      fetch(`${url}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-test-account': accountId,
          ...(init.headers ?? {}),
        },
      }),
  };
}

async function befriend(contacts: ContactStore, a: string, b: string): Promise<void> {
  await contacts.request(a, b);
  await contacts.accept(b, a);
}

let app: Harness;
afterEach(async () => {
  await app?.close();
});

describe('who may message whom', () => {
  it('lets accepted contacts exchange messages', async () => {
    app = await harness();
    await befriend(app.contacts, 'acct_a', 'acct_b');

    const sent = await app.as('acct_a', '/messages/with/acct_b', {
      method: 'POST',
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(sent.status).toBe(201);

    const fetched = await app.as('acct_b', '/messages/with/acct_a');
    const body = (await fetched.json()) as { messages: { body: string }[] };
    expect(body.messages[0]?.body).toBe('hello');
  });

  /*
   * THE ORACLE TEST. A stranger, a pending request, a blocked contact and an
   * account that does not exist must all read as the same 404.
   */
  it('answers a stranger, a pending request, a block and a ghost identically', async () => {
    app = await harness();
    await app.contacts.request('acct_a', 'acct_pending');
    await befriend(app.contacts, 'acct_a', 'acct_blocked');
    await app.contacts.block('acct_blocked', 'acct_a');

    const statuses: number[] = [];
    const bodies: string[] = [];
    for (const target of ['acct_stranger', 'acct_pending', 'acct_blocked', 'acct_no_such']) {
      const response = await app.as('acct_a', `/messages/with/${target}`, {
        method: 'POST',
        body: JSON.stringify({ body: 'hi' }),
      });
      statuses.push(response.status);
      bodies.push(await response.text());
    }
    expect(new Set(statuses)).toEqual(new Set([404]));
    expect(new Set(bodies).size).toBe(1);
  });

  it('refuses the unauthenticated with a 401, not a 404', async () => {
    app = await harness();
    const response = await fetch(`${app.url}/messages/conversations`);
    expect(response.status).toBe(401);
  });
});

describe('what a client is told', () => {
  it('never includes the media path', async () => {
    app = await harness();
    await befriend(app.contacts, 'acct_a', 'acct_b');
    const audio = Buffer.from([1, 2, 3, 4]).toString('base64');
    const sent = await app.as('acct_a', '/messages/with/acct_b/voice', {
      method: 'POST',
      body: JSON.stringify({ audioBase64: audio, durationMs: 900 }),
    });
    expect(sent.status).toBe(201);
    expect(await sent.text()).not.toContain('media-');

    const list = await app.as('acct_b', '/messages/with/acct_a');
    expect(await list.text()).not.toContain('mediaPath');
  });

  it('reports unread counts per conversation and clears them on read', async () => {
    app = await harness();
    await befriend(app.contacts, 'acct_a', 'acct_b');
    await app.as('acct_a', '/messages/with/acct_b', {
      method: 'POST',
      body: JSON.stringify({ body: 'one' }),
    });
    await app.as('acct_a', '/messages/with/acct_b', {
      method: 'POST',
      body: JSON.stringify({ body: 'two' }),
    });

    const before = (await (await app.as('acct_b', '/messages/conversations')).json()) as {
      conversations: { unread: number }[];
    };
    expect(before.conversations[0]?.unread).toBe(2);

    await app.as('acct_b', '/messages/with/acct_a/read', { method: 'POST' });
    const after = (await (await app.as('acct_b', '/messages/conversations')).json()) as {
      conversations: { unread: number }[];
    };
    expect(after.conversations[0]?.unread).toBe(0);
  });
});

describe('voice notes', () => {
  it('round-trips audio to a participant and refuses everybody else', async () => {
    app = await harness();
    await befriend(app.contacts, 'acct_a', 'acct_b');
    await befriend(app.contacts, 'acct_a', 'acct_c');

    const bytes = Buffer.from('fake-aac-bytes');
    const sent = await app.as('acct_a', '/messages/with/acct_b/voice', {
      method: 'POST',
      body: JSON.stringify({ audioBase64: bytes.toString('base64'), durationMs: 1500 }),
    });
    const { message } = (await sent.json()) as { message: { messageId: string } };

    const asRecipient = await app.as('acct_b', `/messages/media/${message.messageId}`);
    expect(asRecipient.status).toBe(200);
    expect(Buffer.from(await asRecipient.arrayBuffer()).equals(bytes)).toBe(true);

    /*
     * A forwarded link is not authorisation. acct_c is a real contact of the
     * sender and still not a participant in this conversation.
     */
    expect((await app.as('acct_c', `/messages/media/${message.messageId}`)).status).toBe(404);
    expect((await fetch(`${app.url}/messages/media/${message.messageId}`)).status).toBe(401);
  });

  it('accepts a real-sized recording: the 6mb route limit, not the 16kb identity limit', async () => {
    app = await harness();
    await befriend(app.contacts, 'acct_a', 'acct_b');
    // ~120kb of audio -- an ordinary few-second voice note. Under the old
    // parser ordering this died as a 413 before the route ever ran.
    const audio = Buffer.alloc(120_000, 7).toString('base64');
    const response = await app.as('acct_a', '/messages/with/acct_b/voice', {
      method: 'POST',
      body: JSON.stringify({ audioBase64: audio, durationMs: 4000 }),
    });
    expect(response.status).toBe(201);
  });

  it('refuses a recording over the duration cap', async () => {
    app = await harness();
    await befriend(app.contacts, 'acct_a', 'acct_b');
    const response = await app.as('acct_a', '/messages/with/acct_b/voice', {
      method: 'POST',
      body: JSON.stringify({ audioBase64: 'aGk=', durationMs: 121_000 }),
    });
    expect(response.status).toBe(400);
  });
});

describe('push on new messages', () => {
  /*
   * DISCREET MEANS NO WORDS. The dispatcher strips title and body for message
   * notifications, so a translated preview can never sit on a lock screen that
   * belongs to whoever is holding the phone. The data payload survives so the
   * app knows what to fetch after unlock.
   */
  it('notifies the recipient without putting the message on the wire', async () => {
    app = await harness();
    await befriend(app.contacts, 'acct_a', 'acct_b');
    await app.as('acct_a', '/messages/with/acct_b', {
      method: 'POST',
      body: JSON.stringify({ body: 'the private words' }),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(app.provider.sent).toHaveLength(1);
    const delivered = app.provider.sent[0]?.notification;
    expect(delivered?.title).toBeUndefined();
    expect(delivered?.body).toBeUndefined();
    expect(delivered?.data['kind']).toBe('message');
    expect(JSON.stringify(delivered)).not.toContain('the private words');
  });
});

describe('ringing a contact', () => {
  it('pushes a visible, urgent ring and reports how many phones it reached', async () => {
    app = await harness();
    await befriend(app.contacts, 'acct_a', 'acct_b');

    const response = await app.as('acct_a', '/contacts/acct_b/ring', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const body = (await response.json()) as { callId: string; reachedDevices: number };
    expect(body.callId.length).toBeGreaterThan(0);
    expect(body.reachedDevices).toBe(1);

    const ring = app.provider.sent[0]?.notification;
    expect(ring?.urgency).toBe('high');
    // A call push is a wake-up for the native receiver, never a tray notification.
    expect(ring?.title).toBeUndefined();
    expect(ring?.data['kind']).toBe('call');
    expect(ring?.data['callId']).toBe(body.callId);
  });

  /* A contact with no registered phone will not ring; the caller should know. */
  it('reports zero reached devices rather than pretending', async () => {
    app = await harness();
    await befriend(app.contacts, 'acct_a', 'acct_nophone');
    const response = await app.as('acct_a', '/contacts/acct_nophone/ring', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(((await response.json()) as { reachedDevices: number }).reachedDevices).toBe(0);
  });

  it('refuses to ring a non-contact with the uniform 404', async () => {
    app = await harness();
    const response = await app.as('acct_a', '/contacts/acct_stranger/ring', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
  });
});

describe('translated conversations', () => {
  /*
   * The mode is per pair, flipped by either side, and resolved at SEND time:
   * the rendering targets the recipient's default language, the original is
   * stored regardless, and a dead translator delivers the original rather
   * than losing the message.
   */
  async function pairWithLanguages(harnessRef: Harness) {
    const first = await harnessRef.store.register({
      email: 'a@t.test',
      password: 'long-and-sturdy-passphrase-A7',
    });
    const second = await harnessRef.store.register({
      email: 'b@t.test',
      password: 'long-and-sturdy-passphrase-B7',
    });
    if (!first.ok || !second.ok) throw new Error('test accounts failed to register');
    const a = first.account.accountId;
    const b = second.account.accountId;
    await harnessRef.store.setDefaultLanguage(a, 'en');
    await harnessRef.store.setDefaultLanguage(b, 'es');
    await befriend(harnessRef.contacts, a, b);
    return { a, b };
  }

  it('renders for the recipient language and keeps the original', async () => {
    app = await harness();
    const { a, b } = await pairWithLanguages(app);
    await app.as(a, `/messages/with/${b}/mode`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'translated' }),
    });
    const sent = (await (
      await app.as(a, `/messages/with/${b}`, {
        method: 'POST',
        body: JSON.stringify({ body: 'hello there' }),
      })
    ).json()) as { message: { body: string; translatedBody: string | null; translatedLanguage: string | null } };
    expect(sent.message.body).toBe('hello there');
    expect(sent.message.translatedBody).toBe('[es] hello there');
    expect(sent.message.translatedLanguage).toBe('es');
  });

  it('a dead translator delivers the original, never a lost message', async () => {
    app = await harness();
    const { a, b } = await pairWithLanguages(app);
    await app.as(a, `/messages/with/${b}/mode`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'translated' }),
    });
    app.setTranslatorAvailable(false);
    const sent = (await (
      await app.as(a, `/messages/with/${b}`, {
        method: 'POST',
        body: JSON.stringify({ body: 'still arrives' }),
      })
    ).json()) as { message: { body: string; translatedBody: string | null } };
    expect(sent.message.body).toBe('still arrives');
    expect(sent.message.translatedBody).toBe(null);
  });

  it('normal mode never translates and the mode reads back per pair', async () => {
    app = await harness();
    const { a, b } = await pairWithLanguages(app);
    const before = (await (await app.as(b, `/messages/with/${a}/mode`)).json()) as { mode: string };
    expect(before.mode).toBe('normal');
    const sent = (await (
      await app.as(a, `/messages/with/${b}`, {
        method: 'POST',
        body: JSON.stringify({ body: 'plain' }),
      })
    ).json()) as { message: { translatedBody: string | null } };
    expect(sent.message.translatedBody).toBe(null);
    // Either side may flip it; the other side reads the same answer.
    await app.as(b, `/messages/with/${a}/mode`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'translated' }),
    });
    const after = (await (await app.as(a, `/messages/with/${b}/mode`)).json()) as { mode: string };
    expect(after.mode).toBe('translated');
  });
});

describe('translated voice notes', () => {
  /*
   * The original is stored first and stays authoritative; a rendering in the
   * reader's language is a SECOND file beside it. Normal mode never asks the
   * engine, and an engine that fails leaves the note exactly as recorded.
   */
  async function pairWithLanguages(harnessRef: Harness) {
    const first = await harnessRef.store.register({
      email: 'va@t.test',
      password: 'long-and-sturdy-passphrase-A7',
    });
    const second = await harnessRef.store.register({
      email: 'vb@t.test',
      password: 'long-and-sturdy-passphrase-B7',
    });
    if (!first.ok || !second.ok) throw new Error('test accounts failed to register');
    const a = first.account.accountId;
    const b = second.account.accountId;
    await harnessRef.store.setDefaultLanguage(a, 'en');
    await harnessRef.store.setDefaultLanguage(b, 'es');
    await befriend(harnessRef.contacts, a, b);
    return { a, b };
  }

  interface VoiceWire {
    messageId: string;
    translatedBody: string | null;
    translatedLanguage: string | null;
    translatedDurationMs: number | null;
    translatedAudioAvailable: boolean;
    mediaDurationMs: number;
  }

  async function sendNote(harnessRef: Harness, a: string, b: string, bytes: Buffer) {
    const sent = await harnessRef.as(a, `/messages/with/${b}/voice`, {
      method: 'POST',
      body: JSON.stringify({ audioBase64: bytes.toString('base64'), durationMs: 1500 }),
    });
    expect(sent.status).toBe(201);
    return ((await sent.json()) as { message: VoiceWire }).message;
  }

  it('stores the derived audio beside the original and exposes both', async () => {
    app = await harness();
    const { a, b } = await pairWithLanguages(app);
    await app.as(a, `/messages/with/${b}/mode`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'translated' }),
    });
    const original = Buffer.from('fake-aac-bytes');
    const message = await sendNote(app, a, b, original);
    expect(app.voiceTranslations()).toBe(1);
    expect(message.translatedBody).toBe('[es] spoken');
    expect(message.translatedLanguage).toBe('es');
    expect(message.translatedDurationMs).toBe(1750);
    expect(message.translatedAudioAvailable).toBe(true);
    expect(message.mediaDurationMs).toBe(1500);

    // The original is untouched and still the one behind the media route.
    const asRecipient = await app.as(b, `/messages/media/${message.messageId}`);
    expect(asRecipient.status).toBe(200);
    expect(Buffer.from(await asRecipient.arrayBuffer()).equals(original)).toBe(true);

    const translated = await app.as(b, `/messages/${message.messageId}/voice/translated`);
    expect(translated.status).toBe(200);
    expect(translated.headers.get('content-type')).toContain('audio/wav');
    expect(Buffer.from(await translated.arrayBuffer()).equals(FAKE_TRANSLATED_AUDIO)).toBe(true);

    // Same door as the original: a non-participant and an anonymous caller.
    await befriend(app.contacts, a, 'acct_c');
    expect(
      (await app.as('acct_c', `/messages/${message.messageId}/voice/translated`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${app.url}/messages/${message.messageId}/voice/translated`)).status,
    ).toBe(401);
  });

  it('a normal conversation never asks the engine', async () => {
    app = await harness();
    const { a, b } = await pairWithLanguages(app);
    const message = await sendNote(app, a, b, Buffer.from('fake-aac-bytes'));
    expect(app.voiceTranslations()).toBe(0);
    expect(message.translatedAudioAvailable).toBe(false);
    expect(message.translatedBody).toBe(null);
    expect((await app.as(b, `/messages/${message.messageId}/voice/translated`)).status).toBe(404);
  });

  it('an engine failure keeps the original, playable and untranslated', async () => {
    app = await harness();
    const { a, b } = await pairWithLanguages(app);
    await app.as(a, `/messages/with/${b}/mode`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'translated' }),
    });
    app.setTranslatorAvailable(false);
    const original = Buffer.from('fake-aac-bytes');
    const message = await sendNote(app, a, b, original);
    expect(app.voiceTranslations()).toBe(1);
    expect(message.translatedAudioAvailable).toBe(false);
    expect(message.translatedBody).toBe(null);
    expect(message.translatedDurationMs).toBe(null);
    const asRecipient = await app.as(b, `/messages/media/${message.messageId}`);
    expect(Buffer.from(await asRecipient.arrayBuffer()).equals(original)).toBe(true);
    expect((await app.as(b, `/messages/${message.messageId}/voice/translated`)).status).toBe(404);
  });
});

describe('rings for the browser', () => {
  /* Phones get a push; a laptop polls. The same ring must serve both. */
  it('lists a pending ring for the target and nobody else', async () => {
    app = await harness();
    await befriend(app.contacts, 'acct_a', 'acct_b');
    const rang = (await (
      await app.as('acct_a', '/contacts/acct_b/ring', { method: 'POST', body: JSON.stringify({}) })
    ).json()) as { callId: string };

    const forTarget = (await (await app.as('acct_b', '/rings')).json()) as {
      rings: { callId: string; fromAccountId: string; fromName: string }[];
    };
    expect(forTarget.rings.map((r) => r.callId)).toEqual([rang.callId]);
    expect(forTarget.rings[0]?.fromAccountId).toBe('acct_a');

    // The caller polling their own rings sees nothing: they are not being rung.
    const forCaller = (await (await app.as('acct_a', '/rings')).json()) as { rings: unknown[] };
    expect(forCaller.rings).toEqual([]);
  });

  it('dismiss clears the ring; declining and answering look identical', async () => {
    app = await harness();
    await befriend(app.contacts, 'acct_a', 'acct_b');
    const rang = (await (
      await app.as('acct_a', '/contacts/acct_b/ring', { method: 'POST', body: JSON.stringify({}) })
    ).json()) as { callId: string };
    await app.as('acct_b', `/rings/${rang.callId}/dismiss`, { method: 'POST', body: '{}' });
    const after = (await (await app.as('acct_b', '/rings')).json()) as { rings: unknown[] };
    expect(after.rings).toEqual([]);
  });

  it('expires a stale ring instead of ringing forever', async () => {
    // Registry-level: the TTL is the registry's own rule, tested without clocks.
    const rings = new RingRegistry(1000);
    rings.note('acct_b', { callId: 'ring-x', fromAccountId: 'acct_a', fromName: 'A', atMs: 0 });
    expect(rings.pendingFor('acct_b', 999).length).toBe(1);
    expect(rings.pendingFor('acct_b', 1001).length).toBe(0);
  });

  it('refuses the unauthenticated poll', async () => {
    app = await harness();
    const response = await fetch(`${app.url}/rings`);
    expect(response.status).toBe(401);
  });
});
