/** @author masterzee001 */
/**
 * Messages between contacts.
 *
 * WHY THIS LIVES IN THE ACCOUNT SERVICE. Messaging needs four things that
 * already exist here and nowhere else together: the caller resolver, the
 * contact graph (which is the permission model -- only contacts may message),
 * the device registry, and the push dispatcher. A separate messaging service
 * would begin life by duplicating all four across a network boundary. This is
 * recorded as a deliberate seam: if messaging traffic ever outgrows identity
 * traffic, the store and routes lift out together.
 *
 * NO FULL IN-MEMORY CACHE, unlike contacts. A contact list is small and
 * bounded; a message history is neither, and hydrating it on boot would grow
 * without limit. The store delegates every read to the port, and the in-memory
 * port exists for tests and for a deployment without a database.
 *
 * THE PAIR IS THE CONVERSATION. Messages are keyed by the same sorted
 * (low, high) pair as the contact edge, so a conversation cannot exist apart
 * from the relationship that authorises it. There are no group chats in this
 * model -- contacts are pairwise, so conversations are too.
 *
 * NORMAL MODE ONLY, AND FREE. Text and voice notes carry no charge; the meter
 * belongs at the translation boundary (see account-trust's `isBillable`), and
 * nothing here translates. When message translation ships it arrives as a
 * separate, explicitly billable path -- not as a flag quietly added to this one.
 */
import { randomBytes } from 'node:crypto';

export type MessageKind = 'text' | 'voice';

export interface MessageRecord {
  readonly messageId: string;
  readonly lowAccountId: string;
  readonly highAccountId: string;
  readonly senderId: string;
  readonly kind: MessageKind;
  /** Present for text. */
  readonly body: string | null;
  /** Present for voice: the server-side media file path. Never a URL. */
  readonly mediaPath: string | null;
  readonly mediaDurationMs: number | null;
  readonly createdAtMs: number;
  /** Set when the RECIPIENT marked the conversation read. */
  readonly readAtMs: number | null;
}

export interface ConversationSummary {
  readonly partnerId: string;
  readonly last: MessageRecord;
  /** Messages from the partner this account has not marked read. */
  readonly unread: number;
}

export interface MessageRecordPort {
  append(record: MessageRecord): Promise<void>;
  /** Newest first, strictly before `beforeMs` when given. */
  conversation(
    lowAccountId: string,
    highAccountId: string,
    options: { beforeMs?: number | undefined; limit: number },
  ): Promise<readonly MessageRecord[]>;
  summaries(accountId: string): Promise<readonly ConversationSummary[]>;
  /** Marks partner->reader messages read. Returns how many changed. */
  markRead(
    lowAccountId: string,
    highAccountId: string,
    readerId: string,
    atMs: number,
  ): Promise<number>;
  get(messageId: string): Promise<MessageRecord | null>;
}

/** The fixed pair order, matching the contact store exactly. */
export function messagePair(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

const MAX_TEXT_LENGTH = 4000;
const DEFAULT_PAGE = 50;

export type SendRefusal = 'empty' | 'too-long';

export type SendResult =
  | { readonly ok: true; readonly message: MessageRecord }
  | { readonly ok: false; readonly reason: SendRefusal };

export class MessageStore {
  private readonly port: MessageRecordPort;
  private readonly now: () => number;

  constructor(options: { port: MessageRecordPort; now?: () => number }) {
    this.port = options.port;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Send a text message.
   *
   * PERMISSION IS THE CALLER'S JOB, deliberately. The route checks
   * `contacts.mayReach` before this runs, because the contact store owns that
   * question and answering it here would be a second copy that drifts. This
   * store validates only what a message IS, never who may send one.
   */
  async sendText(senderId: string, recipientId: string, body: string): Promise<SendResult> {
    const trimmed = body.trim();
    if (trimmed.length === 0) return { ok: false, reason: 'empty' };
    if (trimmed.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'too-long' };

    const { low, high } = messagePair(senderId, recipientId);
    const message: MessageRecord = {
      messageId: `msg_${randomBytes(12).toString('hex')}`,
      lowAccountId: low,
      highAccountId: high,
      senderId,
      kind: 'text',
      body: trimmed,
      mediaPath: null,
      mediaDurationMs: null,
      createdAtMs: this.now(),
      readAtMs: null,
    };
    await this.port.append(message);
    return { ok: true, message };
  }

  /** Send a voice note whose audio the route has already written to disk. */
  async sendVoice(
    senderId: string,
    recipientId: string,
    mediaPath: string,
    mediaDurationMs: number,
  ): Promise<MessageRecord> {
    const { low, high } = messagePair(senderId, recipientId);
    const message: MessageRecord = {
      messageId: `msg_${randomBytes(12).toString('hex')}`,
      lowAccountId: low,
      highAccountId: high,
      senderId,
      kind: 'voice',
      body: null,
      mediaPath,
      mediaDurationMs,
      createdAtMs: this.now(),
      readAtMs: null,
    };
    await this.port.append(message);
    return message;
  }

  conversationWith(
    accountId: string,
    partnerId: string,
    options: { beforeMs?: number | undefined; limit?: number | undefined } = {},
  ): Promise<readonly MessageRecord[]> {
    const { low, high } = messagePair(accountId, partnerId);
    return this.port.conversation(low, high, {
      beforeMs: options.beforeMs,
      limit: Math.min(options.limit ?? DEFAULT_PAGE, 200),
    });
  }

  summariesFor(accountId: string): Promise<readonly ConversationSummary[]> {
    return this.port.summaries(accountId);
  }

  markRead(readerId: string, partnerId: string): Promise<number> {
    const { low, high } = messagePair(readerId, partnerId);
    return this.port.markRead(low, high, readerId, this.now());
  }

  get(messageId: string): Promise<MessageRecord | null> {
    return this.port.get(messageId);
  }
}

/** In-memory port, for tests and database-less deployments. */
export function createInMemoryMessagePort(): MessageRecordPort {
  const rows: MessageRecord[] = [];
  const pairKey = (low: string, high: string) => `${low}\u0000${high}`;

  return {
    async append(record) {
      rows.push(record);
    },

    async conversation(low, high, options) {
      return rows
        .filter(
          (row) =>
            row.lowAccountId === low &&
            row.highAccountId === high &&
            (options.beforeMs === undefined || row.createdAtMs < options.beforeMs),
        )
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .slice(0, options.limit);
    },

    async summaries(accountId) {
      const byPair = new Map<string, { last: MessageRecord; unread: number }>();
      for (const row of rows) {
        if (row.lowAccountId !== accountId && row.highAccountId !== accountId) continue;
        const key = pairKey(row.lowAccountId, row.highAccountId);
        const entry = byPair.get(key) ?? { last: row, unread: 0 };
        if (row.createdAtMs >= entry.last.createdAtMs) entry.last = row;
        if (row.senderId !== accountId && row.readAtMs === null) entry.unread += 1;
        byPair.set(key, entry);
      }
      return [...byPair.values()]
        .map((entry) => ({
          partnerId:
            entry.last.lowAccountId === accountId
              ? entry.last.highAccountId
              : entry.last.lowAccountId,
          last: entry.last,
          unread: entry.unread,
        }))
        .sort((a, b) => b.last.createdAtMs - a.last.createdAtMs);
    },

    async markRead(low, high, readerId, atMs) {
      let changed = 0;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (!row) continue;
        if (
          row.lowAccountId === low &&
          row.highAccountId === high &&
          row.senderId !== readerId &&
          row.readAtMs === null
        ) {
          rows[index] = { ...row, readAtMs: atMs };
          changed += 1;
        }
      }
      return changed;
    },

    async get(messageId) {
      return rows.find((row) => row.messageId === messageId) ?? null;
    },
  };
}
