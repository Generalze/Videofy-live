/**
 * What a person may do to a message: the store's own rules.
 *
 * Each founder ruling is one describe. The clock is injected so the
 * fifteen-minute edit window is tested by moving time, never by waiting.
 * Everything here runs against the in-memory ports; the Postgres port is
 * held to the same interface and the column-parity test keeps its SQL
 * honest.
 */
import { describe, expect, it } from 'vitest';
import {
  EDIT_WINDOW_MS,
  MessageStore,
  RETRACTED_PLACEHOLDER,
  createInMemoryMessagePort,
  displayBody,
  editRefusal,
  replySummaryOf,
} from '../message-store.js';
import { createInMemoryMessageActionPort } from '../message-actions.js';

function harness() {
  let now = 1_000_000;
  const store = new MessageStore({
    port: createInMemoryMessagePort(),
    actions: createInMemoryMessageActionPort(),
    now: () => (now += 1000),
  });
  return { store, advance: (ms: number) => (now += ms) };
}

async function text(store: MessageStore, from: string, to: string, body: string) {
  const result = await store.sendText(from, to, body);
  if (!result.ok) throw new Error(`send refused: ${result.reason}`);
  return result.message;
}

describe('reply', () => {
  it('quotes the first 80 characters of the ORIGINAL, or "Voice note"', async () => {
    const { store } = harness();
    const long = 'x'.repeat(200);
    const original = await text(store, 'acct_a', 'acct_b', long);
    const reply = await store.sendText('acct_b', 'acct_a', 'ok', undefined, {
      replyToMessageId: original.messageId,
    });
    expect(reply.ok).toBe(true);
    const [view] = await store.viewFor('acct_a', reply.ok ? [reply.message] : []);
    expect(view?.replyTo?.messageId).toBe(original.messageId);
    expect(view?.replyTo?.senderId).toBe('acct_a');
    expect(view?.replyTo?.preview).toBe('x'.repeat(80));

    const voice = await store.sendVoice('acct_a', 'acct_b', '/m/v.m4a', 900);
    expect(replySummaryOf(voice).preview).toBe('Voice note');
  });

  it('refuses a reply that points outside the conversation', async () => {
    const { store } = harness();
    const elsewhere = await text(store, 'acct_a', 'acct_c', 'private');
    const reply = await store.sendText('acct_a', 'acct_b', 'look', undefined, {
      replyToMessageId: elsewhere.messageId,
    });
    expect(reply).toEqual({ ok: false, reason: 'bad-reply' });
    expect(await store.canReplyTo('acct_a', 'acct_b', elsewhere.messageId)).toBe(false);
    expect(await store.canReplyTo('acct_a', 'acct_c', elsewhere.messageId)).toBe(true);
  });
});

describe('edit', () => {
  it('is for the sender only, text only, and inside fifteen minutes', async () => {
    const { store, advance } = harness();
    const message = await text(store, 'acct_a', 'acct_b', 'teh words');
    expect((await store.editText(message.messageId, 'acct_b', 'mine now', null)).ok).toBe(false);
    expect(editRefusal(message, 'acct_b', message.createdAtMs)).toBe('not-sender');

    const voice = await store.sendVoice('acct_a', 'acct_b', '/m/v.m4a', 900);
    expect(editRefusal(voice, 'acct_a', voice.createdAtMs)).toBe('not-text');

    const edited = await store.editText(message.messageId, 'acct_a', 'the words', null);
    expect(edited.ok).toBe(true);
    const stored = await store.get(message.messageId);
    expect(stored?.body).toBe('the words');
    expect(stored?.editedAtMs).toBeTypeOf('number');

    advance(EDIT_WINDOW_MS + 1);
    const late = await store.editText(message.messageId, 'acct_a', 'too late', null);
    expect(late).toEqual({ ok: false, reason: 'window-closed' });
    expect((await store.get(message.messageId))?.body).toBe('the words');
  });

  it('keeps the rendering in sync: a new one replaces, none clears', async () => {
    const { store } = harness();
    const sent = await store.sendText('acct_a', 'acct_b', 'hello', {
      translatedBody: 'hola',
      translatedLanguage: 'es',
    });
    if (!sent.ok) throw new Error('unreachable');
    await store.editText(sent.message.messageId, 'acct_a', 'goodbye', {
      translatedBody: 'adios',
      translatedLanguage: 'es',
    });
    expect((await store.get(sent.message.messageId))?.translatedBody).toBe('adios');
    await store.editText(sent.message.messageId, 'acct_a', 'bye', null);
    expect((await store.get(sent.message.messageId))?.translatedBody).toBeNull();
  });
});

describe('retract', () => {
  it('tombstones for both readers and hands back every file to unlink', async () => {
    const { store } = harness();
    const message = await store.sendVoice('acct_a', 'acct_b', '/m/orig.m4a', 900, {}, {
      translatedMediaPath: '/m/orig-es.m4a',
      translatedLanguage: 'es',
      translatedBody: 'hola',
      translatedDurationMs: 950,
    });
    expect((await store.retract(message.messageId, 'acct_b')).ok).toBe(false);

    const result = await store.retract(message.messageId, 'acct_a');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mediaPaths).toEqual(['/m/orig.m4a', '/m/orig-es.m4a']);

    const stored = await store.get(message.messageId);
    expect(stored?.kind).toBe('voice');
    expect(stored?.body).toBeNull();
    expect(stored?.translatedBody).toBeNull();
    expect(stored?.mediaPath).toBeNull();
    expect(stored?.translatedMediaPath).toBeNull();
    expect(stored?.retractedAtMs).toBeTypeOf('number');
    expect(displayBody(stored!)).toBe(RETRACTED_PLACEHOLDER);
    // Twice is a refusal, not a second tombstone.
    expect(await store.retract(message.messageId, 'acct_a')).toEqual({
      ok: false,
      reason: 'retracted',
    });
    // A reply that quoted it now quotes the placeholder.
    expect(replySummaryOf(stored!).preview).toBe(RETRACTED_PLACEHOLDER);
  });

  it('cannot be edited afterwards', async () => {
    const { store } = harness();
    const message = await text(store, 'acct_a', 'acct_b', 'gone');
    await store.retract(message.messageId, 'acct_a');
    expect(await store.editText(message.messageId, 'acct_a', 'back', null)).toEqual({
      ok: false,
      reason: 'retracted',
    });
  });
});

describe('hide (delete for me)', () => {
  it('is scoped to one reader and undone by unhide', async () => {
    const { store } = harness();
    const message = await text(store, 'acct_a', 'acct_b', 'awkward');
    await store.hide(message.messageId, 'acct_b');

    const forB = await store.viewFor('acct_b', [message]);
    const forA = await store.viewFor('acct_a', [message]);
    expect(forB).toEqual([]);
    expect(forA.map((v) => v.record.messageId)).toEqual([message.messageId]);

    await store.unhide(message.messageId, 'acct_b');
    expect((await store.viewFor('acct_b', [message])).length).toBe(1);
  });
});

describe('reactions', () => {
  it('is one per account per message, summarised with "mine"', async () => {
    const { store } = harness();
    const message = await text(store, 'acct_a', 'acct_b', 'nice');
    await store.setReaction(message.messageId, 'acct_a', '👍');
    await store.setReaction(message.messageId, 'acct_b', '👍');
    await store.setReaction(message.messageId, 'acct_b', '❤️');

    const [forB] = await store.viewFor('acct_b', [message]);
    expect(forB?.reactions).toEqual([
      { emoji: '👍', count: 1, mine: false },
      { emoji: '❤️', count: 1, mine: true },
    ]);
    await store.setReaction(message.messageId, 'acct_b', null);
    const [after] = await store.viewFor('acct_b', [message]);
    expect(after?.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
  });
});

describe('pins', () => {
  it('lists my pins in this conversation only, and only mine', async () => {
    const { store } = harness();
    const here = await text(store, 'acct_a', 'acct_b', 'address');
    const there = await text(store, 'acct_a', 'acct_c', 'other');
    await store.setPin(here.messageId, 'acct_a', true);
    await store.setPin(there.messageId, 'acct_a', true);
    await store.setPin(here.messageId, 'acct_b', true);

    const mine = await store.pinnedWith('acct_a', 'acct_b');
    expect(mine.map((v) => v.record.messageId)).toEqual([here.messageId]);
    expect(mine[0]?.pinnedByMe).toBe(true);
    await store.setPin(here.messageId, 'acct_a', false);
    expect(await store.pinnedWith('acct_a', 'acct_b')).toEqual([]);
    // B's pin was never A's to remove.
    expect((await store.pinnedWith('acct_b', 'acct_a')).length).toBe(1);
  });
});

describe('conversation settings', () => {
  it('are per account per partner, merged field by field', async () => {
    const { store } = harness();
    expect(await store.settingsWith('acct_a', 'acct_b')).toEqual({ muted: false, archived: false });
    await store.setSettingsWith('acct_a', 'acct_b', { muted: true });
    await store.setSettingsWith('acct_a', 'acct_b', { archived: true });
    expect(await store.settingsWith('acct_a', 'acct_b')).toEqual({ muted: true, archived: true });
    // The partner's own view of the same pair is untouched.
    expect(await store.settingsWith('acct_b', 'acct_a')).toEqual({ muted: false, archived: false });
    expect([...(await store.settingsFor('acct_a')).keys()]).toEqual(['acct_b']);
  });
});

describe('search', () => {
  it('is a case-insensitive substring over body and rendering, newest first', async () => {
    const { store } = harness();
    await text(store, 'acct_a', 'acct_b', 'The Address is 12 Elm');
    await store.sendText('acct_b', 'acct_a', 'thanks', {
      translatedBody: 'gracias por la ADDRESS',
      translatedLanguage: 'es',
    });
    await text(store, 'acct_a', 'acct_b', 'unrelated');
    const hits = await store.searchWith('acct_a', 'acct_b', 'address');
    expect(hits.map((v) => v.record.body)).toEqual(['thanks', 'The Address is 12 Elm']);
  });

  it('excludes retracted and hidden-for-me rows', async () => {
    const { store } = harness();
    const gone = await text(store, 'acct_a', 'acct_b', 'secret one');
    const hidden = await text(store, 'acct_a', 'acct_b', 'secret two');
    const kept = await text(store, 'acct_a', 'acct_b', 'secret three');
    await store.retract(gone.messageId, 'acct_a');
    await store.hide(hidden.messageId, 'acct_b');

    const forB = await store.searchWith('acct_b', 'acct_a', 'secret');
    expect(forB.map((v) => v.record.messageId)).toEqual([kept.messageId]);
    // The hide was B's; A still finds two.
    const forA = await store.searchWith('acct_a', 'acct_b', 'secret');
    expect(forA.map((v) => v.record.messageId)).toEqual([kept.messageId, hidden.messageId]);
    expect(await store.searchWith('acct_a', 'acct_b', '   ')).toEqual([]);
  });
});
