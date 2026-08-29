/**
 * Acting on a message, over HTTP.
 *
 * Two authorisation shapes and the wire contract the clients build on:
 * PARTICIPANT for react/pin/hide/forward, SENDER for edit/retract, one
 * uniform 404 for everybody else. The push gate for a muted partner is
 * tested through the recording provider, because "muted" that still buzzes
 * a phone is the bug that matters.
 */
import express from 'express';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountTrust } from '@videofy-live/account-trust';
import { AccountStore } from '../account-store.js';
import { ContactStore } from '../contact-store.js';
import { DeviceStore } from '../device-store.js';
import { EDIT_WINDOW_MS, MessageStore, createInMemoryMessagePort } from '../message-store.js';
import { RingRegistry } from '../ring-registry.js';
import { createInMemoryConversationModePort } from '../conversation-modes.js';
import { PushDispatcher, createRecordingPushProvider } from '../push/push-dispatcher.js';
import { registerMessageRoutes } from '../message-routes.js';
import { createInMemoryCallRecordPort } from '../call-records.js';
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

interface Wire {
  messageId: string;
  senderId: string;
  kind: string;
  body: string | null;
  translatedBody: string | null;
  editedAtMs: number | null;
  retractedAtMs: number | null;
  replyTo: { messageId: string; senderId: string; kind: string; preview: string } | null;
  forwardedFrom: { messageId: string; senderId: string } | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
  pinnedByMe: boolean;
}

async function harness() {
  const contacts = new ContactStore();
  const devices = new DeviceStore();
  const provider = createRecordingPushProvider();
  await devices.register({
    deviceId: 'dev_b',
    accountId: 'acct_b',
    platform: 'android',
    pushToken: 'tok_b',
  });
  let now = 1_000_000;
  const messages = new MessageStore({
    port: createInMemoryMessagePort(),
    now: () => (now += 1000),
  });
  const calls = createInMemoryCallRecordPort();
  const conversationModes = createInMemoryConversationModePort();
  const store = new AccountStore();
  const app = express();
  const identityJson = express.json({ limit: '16kb' });
  app.use((req, res, next) => {
    if (/^\/messages\/with\/[^/]+\/voice$/.test(req.path)) {
      next();
      return;
    }
    identityJson(req, res, next);
  });
  const mediaDir = await mkdtemp(join(tmpdir(), 'msg-actions-'));
  registerMessageRoutes(app, {
    store,
    contacts,
    messages,
    calls,
    push: new PushDispatcher({ devices, providers: [provider] }),
    rings: new RingRegistry(),
    conversationModes,
    translator: {
      translate: async ({ targetLanguage, sourceText }) => `[${targetLanguage}] ${sourceText}`,
    },
    voiceTranslator: { translate: async () => ({ ok: false, stage: 'unconfigured' }) },
    mediaDir,
    callerAccountId: (req) => {
      const id = req.header('x-test-account');
      return id ? caller(id) : null;
    },
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const as = (accountId: string, path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-test-account': accountId,
        ...(init.headers ?? {}),
      },
    });
  const json = async <T,>(response: Response): Promise<T> => (await response.json()) as T;
  const send = async (from: string, to: string, body: string, extra: object = {}) =>
    (await json<{ message: Wire }>(
      await as(from, `/messages/with/${to}`, {
        method: 'POST',
        body: JSON.stringify({ body, ...extra }),
      }),
    )).message;
  const timeline = async (reader: string, partner: string) =>
    (await json<{ messages: Wire[] }>(await as(reader, `/messages/with/${partner}`))).messages;

  await contacts.request('acct_a', 'acct_b');
  await contacts.accept('acct_b', 'acct_a');
  await contacts.request('acct_a', 'acct_c');
  await contacts.accept('acct_c', 'acct_a');

  return {
    url,
    as,
    json,
    send,
    timeline,
    contacts,
    devices,
    provider,
    messages,
    calls,
    store,
    conversationModes,
    mediaDir,
    advance: (ms: number) => (now += ms),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;
let app: Harness;
afterEach(async () => {
  await app?.close();
});

describe('reply', () => {
  it('carries a quoted summary of the original on the wire', async () => {
    app = await harness();
    const original = await app.send('acct_a', 'acct_b', 'where shall we meet?');
    const reply = await app.send('acct_b', 'acct_a', 'the usual', {
      replyToMessageId: original.messageId,
    });
    expect(reply.replyTo).toEqual({
      messageId: original.messageId,
      senderId: 'acct_a',
      kind: 'text',
      preview: 'where shall we meet?',
    });
    const seen = await app.timeline('acct_a', 'acct_b');
    expect(seen[0]?.replyTo?.messageId).toBe(original.messageId);
  });

  it('refuses a quote from another conversation, for text and for voice', async () => {
    app = await harness();
    const elsewhere = await app.send('acct_a', 'acct_c', 'not for b');
    const text = await app.as('acct_a', '/messages/with/acct_b', {
      method: 'POST',
      body: JSON.stringify({ body: 'look', replyToMessageId: elsewhere.messageId }),
    });
    expect(text.status).toBe(400);
    const voice = await app.as('acct_a', '/messages/with/acct_b/voice', {
      method: 'POST',
      body: JSON.stringify({
        audioBase64: 'aGk=',
        durationMs: 500,
        replyToMessageId: elsewhere.messageId,
      }),
    });
    expect(voice.status).toBe(400);
  });
});

describe('forward', () => {
  it('is a new message by the forwarder with the original author named', async () => {
    app = await harness();
    const original = await app.send('acct_b', 'acct_a', 'pass this on');
    const forwarded = await app.json<{ message: Wire }>(
      await app.as('acct_a', '/messages/with/acct_c/forward', {
        method: 'POST',
        body: JSON.stringify({ messageId: original.messageId }),
      }),
    );
    expect(forwarded.message.senderId).toBe('acct_a');
    expect(forwarded.message.body).toBe('pass this on');
    expect(forwarded.message.forwardedFrom).toEqual({
      messageId: original.messageId,
      senderId: 'acct_b',
    });
    expect(forwarded.message.messageId).not.toBe(original.messageId);
    // Provenance survives a read of the timeline, not only the send reply.
    const seen = await app.timeline('acct_c', 'acct_a');
    expect(seen[0]?.forwardedFrom?.senderId).toBe('acct_b');
  });

  it('copies a voice note so each copy owns its own file', async () => {
    app = await harness();
    const bytes = Buffer.from('fake-aac');
    const sent = await app.json<{ message: Wire }>(
      await app.as('acct_b', '/messages/with/acct_a/voice', {
        method: 'POST',
        body: JSON.stringify({ audioBase64: bytes.toString('base64'), durationMs: 700 }),
      }),
    );
    const forwarded = await app.json<{ message: Wire }>(
      await app.as('acct_a', '/messages/with/acct_c/forward', {
        method: 'POST',
        body: JSON.stringify({ messageId: sent.message.messageId }),
      }),
    );
    expect(forwarded.message.kind).toBe('voice');
    const copy = await app.messages.get(forwarded.message.messageId);
    const source = await app.messages.get(sent.message.messageId);
    expect(copy?.mediaPath).not.toBe(source?.mediaPath);
    const media = await app.as('acct_c', `/messages/media/${forwarded.message.messageId}`);
    expect(Buffer.from(await media.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('refuses a non-participant with the uniform 404 and a tombstone with 410', async () => {
    app = await harness();
    const original = await app.send('acct_a', 'acct_b', 'mine');
    const stranger = await app.as('acct_c', '/messages/with/acct_a/forward', {
      method: 'POST',
      body: JSON.stringify({ messageId: original.messageId }),
    });
    expect(stranger.status).toBe(404);
    await app.as('acct_a', `/messages/${original.messageId}/retract`, { method: 'POST' });
    const gone = await app.as('acct_a', '/messages/with/acct_c/forward', {
      method: 'POST',
      body: JSON.stringify({ messageId: original.messageId }),
    });
    expect(gone.status).toBe(410);
  });
});

describe('edit', () => {
  it('is the sender only, and re-renders a translated conversation', async () => {
    app = await harness();
    const first = await app.store.register({ email: 'a@t.test', password: 'long-and-sturdy-A7' });
    const second = await app.store.register({ email: 'b@t.test', password: 'long-and-sturdy-B7' });
    if (!first.ok || !second.ok) throw new Error('registration failed');
    const a = first.account.accountId;
    const b = second.account.accountId;
    await app.store.setDefaultLanguage(a, 'en');
    await app.store.setDefaultLanguage(b, 'es');
    await app.contacts.request(a, b);
    await app.contacts.accept(b, a);
    await app.as(a, `/messages/with/${b}/mode`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'translated' }),
    });
    const sent = await app.json<{ message: Wire }>(
      await app.as(a, `/messages/with/${b}`, {
        method: 'POST',
        body: JSON.stringify({ body: 'hello' }),
      }),
    );
    expect(sent.message.translatedBody).toBe('[es] hello');

    const byOther = await app.as(b, `/messages/${sent.message.messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: 'hijack' }),
    });
    expect(byOther.status).toBe(403);

    const edited = await app.json<{ message: Wire }>(
      await app.as(a, `/messages/${sent.message.messageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: 'goodbye' }),
      }),
    );
    expect(edited.message.body).toBe('goodbye');
    expect(edited.message.translatedBody).toBe('[es] goodbye');
    expect(edited.message.editedAtMs).toBeTypeOf('number');
  });

  it('closes after fifteen minutes and never applies to voice or a stranger', async () => {
    app = await harness();
    const message = await app.send('acct_a', 'acct_b', 'typo');
    const inTime = await app.as('acct_a', `/messages/${message.messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: 'fixed' }),
    });
    expect(inTime.status).toBe(200);
    app.advance(EDIT_WINDOW_MS + 1);
    const late = await app.as('acct_a', `/messages/${message.messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: 'again' }),
    });
    expect(late.status).toBe(409);
    expect((await app.messages.get(message.messageId))?.body).toBe('fixed');

    const voice = await app.json<{ message: Wire }>(
      await app.as('acct_a', '/messages/with/acct_b/voice', {
        method: 'POST',
        body: JSON.stringify({ audioBase64: 'aGk=', durationMs: 500 }),
      }),
    );
    const notText = await app.as('acct_a', `/messages/${voice.message.messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: 'words' }),
    });
    expect(notText.status).toBe(400);
    const stranger = await app.as('acct_c', `/messages/${message.messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: 'x' }),
    });
    expect(stranger.status).toBe(404);
  });
});

describe('retract', () => {
  it('tombstones for both sides and unlinks the audio', async () => {
    app = await harness();
    const sent = await app.json<{ message: Wire }>(
      await app.as('acct_a', '/messages/with/acct_b/voice', {
        method: 'POST',
        body: JSON.stringify({ audioBase64: Buffer.from('aac').toString('base64'), durationMs: 500 }),
      }),
    );
    const path = (await app.messages.get(sent.message.messageId))?.mediaPath ?? '';
    expect((await stat(path)).size).toBeGreaterThan(0);

    const byOther = await app.as('acct_b', `/messages/${sent.message.messageId}/retract`, {
      method: 'POST',
    });
    expect(byOther.status).toBe(403);

    const retracted = await app.json<{ message: Wire }>(
      await app.as('acct_a', `/messages/${sent.message.messageId}/retract`, { method: 'POST' }),
    );
    expect(retracted.message.kind).toBe('voice');
    expect(retracted.message.body).toBe('Message was removed');
    expect(retracted.message.retractedAtMs).toBeTypeOf('number');
    await expect(stat(path)).rejects.toThrow();

    for (const reader of ['acct_a', 'acct_b']) {
      const partner = reader === 'acct_a' ? 'acct_b' : 'acct_a';
      const seen = await app.timeline(reader, partner);
      expect(seen[0]?.body).toBe('Message was removed');
      expect(seen[0]?.translatedBody).toBeNull();
    }
    expect((await app.as('acct_b', `/messages/media/${sent.message.messageId}`)).status).toBe(404);
  });
});

describe('hide (delete for me)', () => {
  it('drops the message from one reader only, and DELETE undoes it', async () => {
    app = await harness();
    const message = await app.send('acct_a', 'acct_b', 'awkward');
    expect(
      (await app.as('acct_b', `/messages/${message.messageId}/hide`, { method: 'POST' })).status,
    ).toBe(200);
    expect((await app.timeline('acct_b', 'acct_a')).map((m) => m.messageId)).toEqual([]);
    expect((await app.timeline('acct_a', 'acct_b')).map((m) => m.messageId)).toEqual([
      message.messageId,
    ]);
    await app.as('acct_b', `/messages/${message.messageId}/hide`, { method: 'DELETE' });
    expect((await app.timeline('acct_b', 'acct_a')).map((m) => m.messageId)).toEqual([
      message.messageId,
    ]);
    expect(
      (await app.as('acct_c', `/messages/${message.messageId}/hide`, { method: 'POST' })).status,
    ).toBe(404);
  });

  it('keeps calls in the merged timeline while messages are hidden', async () => {
    app = await harness();
    const message = await app.send('acct_a', 'acct_b', 'before the call');
    await app.calls.upsert({
      callId: 'call-1',
      lowAccountId: 'acct_a',
      highAccountId: 'acct_b',
      callerAccountId: 'acct_a',
      peerAccountId: 'acct_b',
      mode: 'normal',
      createdAtMs: 5_000_000,
      answeredAtMs: 5_001_000,
      connectedAtMs: 5_001_000,
      endedAtMs: 5_010_000,
      outcome: 'completed',
      endedByAccountId: 'acct_a',
      durationSeconds: 9,
    });
    await app.as('acct_b', `/messages/${message.messageId}/hide`, { method: 'POST' });
    const seen = await app.timeline('acct_b', 'acct_a');
    expect(seen.map((item) => item.kind)).toEqual(['call']);
  });
});

describe('reactions', () => {
  it('are one per person, summarised with mine, visible to both', async () => {
    app = await harness();
    const message = await app.send('acct_a', 'acct_b', 'nice');
    const react = (who: string, emoji: string | null) =>
      app.as(who, `/messages/${message.messageId}/reaction`, {
        method: 'PUT',
        body: JSON.stringify({ emoji }),
      });
    await react('acct_a', '👍');
    await react('acct_b', '👍');
    await react('acct_b', '❤️');
    const forA = await app.timeline('acct_a', 'acct_b');
    expect(forA[0]?.reactions).toEqual([
      { emoji: '👍', count: 1, mine: true },
      { emoji: '❤️', count: 1, mine: false },
    ]);
    await react('acct_b', null);
    const forB = await app.timeline('acct_b', 'acct_a');
    expect(forB[0]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    expect((await react('acct_c', '👍')).status).toBe(404);
    expect(
      (
        await app.as('acct_a', `/messages/${message.messageId}/reaction`, {
          method: 'PUT',
          body: JSON.stringify({ emoji: 'a very long string that is not an emoji' }),
        })
      ).status,
    ).toBe(400);
  });
});

describe('pins', () => {
  it('mark pinnedByMe for me only and list per conversation', async () => {
    app = await harness();
    const message = await app.send('acct_a', 'acct_b', 'keep this');
    await app.as('acct_b', `/messages/${message.messageId}/pin`, {
      method: 'PUT',
      body: JSON.stringify({ pinned: true }),
    });
    expect((await app.timeline('acct_b', 'acct_a'))[0]?.pinnedByMe).toBe(true);
    expect((await app.timeline('acct_a', 'acct_b'))[0]?.pinnedByMe).toBe(false);
    const pinned = await app.json<{ messages: Wire[] }>(
      await app.as('acct_b', '/messages/with/acct_a/pinned'),
    );
    expect(pinned.messages.map((m) => m.messageId)).toEqual([message.messageId]);
    const none = await app.json<{ messages: Wire[] }>(
      await app.as('acct_a', '/messages/with/acct_b/pinned'),
    );
    expect(none.messages).toEqual([]);
  });
});

describe('mute and archive', () => {
  it('shows on the conversation list and a muted partner gets no push', async () => {
    app = await harness();
    await app.send('acct_a', 'acct_b', 'first');
    await new Promise((r) => setTimeout(r, 10));
    expect(app.provider.sent).toHaveLength(1);

    const settings = await app.json<{ muted: boolean; archived: boolean }>(
      await app.as('acct_b', '/messages/with/acct_a/settings', {
        method: 'PUT',
        body: JSON.stringify({ muted: true }),
      }),
    );
    expect(settings).toEqual({ muted: true, archived: false });

    await app.send('acct_a', 'acct_b', 'second');
    await new Promise((r) => setTimeout(r, 10));
    expect(app.provider.sent).toHaveLength(1);
    // Muted is not lost: the message is there and still unread.
    const list = await app.json<{ conversations: { muted: boolean; archived: boolean; unread: number }[] }>(
      await app.as('acct_b', '/messages/conversations'),
    );
    expect(list.conversations[0]).toMatchObject({ muted: true, archived: false, unread: 2 });

    // The setting is B's alone; A's list of the same pair is untouched.
    const forA = await app.json<{ conversations: { muted: boolean }[] }>(
      await app.as('acct_a', '/messages/conversations'),
    );
    expect(forA.conversations[0]?.muted).toBe(false);

    await app.as('acct_b', '/messages/with/acct_a/settings', {
      method: 'PUT',
      body: JSON.stringify({ muted: false, archived: true }),
    });
    await app.send('acct_a', 'acct_b', 'third');
    await new Promise((r) => setTimeout(r, 10));
    expect(app.provider.sent).toHaveLength(2);
  });

  /*
   * The recipient's own notification switch is gated in the SAME place as a
   * mute, and for the same reason: the message still arrives, only the
   * push is withheld. The recipient must be a real account here, because
   * the switch is read off its record.
   */
  it('a recipient who switched notifications off gets the message and no push', async () => {
    app = await harness();
    const registered = await app.store.register({
      email: 'quiet@example.com',
      password: 'correct horse battery staple',
    });
    if (!registered.ok) throw new Error('registration failed');
    const quiet = registered.account.accountId;
    await app.devices.register({ deviceId: 'dev_q', accountId: quiet, platform: 'android', pushToken: 'tok_q' });
    await app.contacts.request('acct_a', quiet);
    await app.contacts.accept(quiet, 'acct_a');

    await app.send('acct_a', quiet, 'first');
    await new Promise((r) => setTimeout(r, 10));
    expect(app.provider.sent).toHaveLength(1);

    await app.store.setProfileExtras(quiet, { notificationsEnabled: false });
    await app.send('acct_a', quiet, 'second');
    await new Promise((r) => setTimeout(r, 10));
    expect(app.provider.sent).toHaveLength(1);
    expect(await app.timeline(quiet, 'acct_a')).toHaveLength(2);

    await app.store.setProfileExtras(quiet, { notificationsEnabled: true });
    await app.send('acct_a', quiet, 'third');
    await new Promise((r) => setTimeout(r, 10));
    expect(app.provider.sent).toHaveLength(2);
  });
});

describe('search', () => {
  it('finds text newest first and excludes retracted and hidden-for-me', async () => {
    app = await harness();
    const gone = await app.send('acct_a', 'acct_b', 'secret one');
    const hidden = await app.send('acct_a', 'acct_b', 'secret two');
    const kept = await app.send('acct_a', 'acct_b', 'SECRET three');
    await app.send('acct_a', 'acct_b', 'nothing here');
    await app.as('acct_a', `/messages/${gone.messageId}/retract`, { method: 'POST' });
    await app.as('acct_b', `/messages/${hidden.messageId}/hide`, { method: 'POST' });

    const forB = await app.json<{ messages: Wire[] }>(
      await app.as('acct_b', '/messages/with/acct_a/search?q=secret'),
    );
    expect(forB.messages.map((m) => m.messageId)).toEqual([kept.messageId]);
    const forA = await app.json<{ messages: Wire[] }>(
      await app.as('acct_a', '/messages/with/acct_b/search?q=secret'),
    );
    expect(forA.messages.map((m) => m.messageId)).toEqual([kept.messageId, hidden.messageId]);
    expect((await app.as('acct_a', '/messages/with/acct_b/search')).status).toBe(400);
    expect((await app.as('acct_c', '/messages/with/acct_b/search?q=x')).status).toBe(404);
  });
});
