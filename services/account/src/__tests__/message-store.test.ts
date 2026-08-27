/**
 * Messages between contacts: the store's own guarantees.
 *
 * Permission is deliberately NOT tested here -- the store does not own it, and
 * a test asserting it would pin the wrong module. What is tested is what a
 * message is, how a conversation pages, and how unread counts behave when the
 * reader and the sender are the same pair seen from opposite ends.
 */
import { describe, expect, it } from 'vitest';
import { MessageStore, createInMemoryMessagePort, messagePair } from '../message-store.js';

function store(now?: () => number) {
  let tick = 1_000_000;
  return new MessageStore({
    port: createInMemoryMessagePort(),
    now: now ?? (() => (tick += 1000)),
  });
}

describe('sending', () => {
  it('stores a trimmed text message against the sorted pair', async () => {
    const s = store();
    const result = await s.sendText('acct_b', 'acct_a', '  hello  ');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.body).toBe('hello');
      expect(result.message.lowAccountId).toBe('acct_a');
      expect(result.message.highAccountId).toBe('acct_b');
      expect(result.message.senderId).toBe('acct_b');
    }
  });

  it('refuses empty and over-long messages', async () => {
    const s = store();
    expect((await s.sendText('a', 'b', '   ')).ok).toBe(false);
    expect((await s.sendText('a', 'b', 'x'.repeat(4001))).ok).toBe(false);
  });

  it('records a voice note with its media path and duration', async () => {
    const s = store();
    const message = await s.sendVoice('acct_a', 'acct_b', '/media/vn_1.m4a', 4200);
    expect(message.kind).toBe('voice');
    expect(message.mediaPath).toBe('/media/vn_1.m4a');
    expect(message.mediaDurationMs).toBe(4200);
    expect(message.body).toBeNull();
  });
});

describe('conversations', () => {
  it('pages newest first, strictly before the cursor', async () => {
    const s = store();
    for (let i = 0; i < 5; i += 1) await s.sendText('acct_a', 'acct_b', `m${i}`);
    const all = await s.conversationWith('acct_a', 'acct_b');
    expect(all.map((m) => m.body)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0']);

    const first = all[0];
    const older = await s.conversationWith('acct_a', 'acct_b', {
      beforeMs: first?.createdAtMs,
    });
    expect(older.map((m) => m.body)).toEqual(['m3', 'm2', 'm1', 'm0']);
  });

  it('keeps pairs apart', async () => {
    const s = store();
    await s.sendText('acct_a', 'acct_b', 'to b');
    await s.sendText('acct_a', 'acct_c', 'to c');
    expect((await s.conversationWith('acct_a', 'acct_b')).map((m) => m.body)).toEqual(['to b']);
    expect((await s.conversationWith('acct_c', 'acct_a')).map((m) => m.body)).toEqual(['to c']);
  });
});

describe('unread', () => {
  /*
   * The count is PER READER on one shared pair: what B has not read from A is
   * not what A has not read from B, and conflating them shows people their own
   * messages as unread.
   */
  it('counts only the partner side, and only until read', async () => {
    const s = store();
    await s.sendText('acct_a', 'acct_b', 'one');
    await s.sendText('acct_a', 'acct_b', 'two');
    await s.sendText('acct_b', 'acct_a', 'reply');

    const forB = await s.summariesFor('acct_b');
    expect(forB[0]?.unread).toBe(2);
    const forA = await s.summariesFor('acct_a');
    expect(forA[0]?.unread).toBe(1);

    expect(await s.markRead('acct_b', 'acct_a')).toBe(2);
    expect((await s.summariesFor('acct_b'))[0]?.unread).toBe(0);
    // A's unread is untouched by B reading.
    expect((await s.summariesFor('acct_a'))[0]?.unread).toBe(1);
  });

  it('orders summaries by most recent activity', async () => {
    const s = store();
    await s.sendText('acct_a', 'acct_b', 'older');
    await s.sendText('acct_a', 'acct_c', 'newer');
    const summaries = await s.summariesFor('acct_a');
    expect(summaries.map((x) => x.partnerId)).toEqual(['acct_c', 'acct_b']);
  });
});

describe('the pair', () => {
  it('is order-independent', () => {
    expect(messagePair('acct_b', 'acct_a')).toEqual(messagePair('acct_a', 'acct_b'));
  });
});
