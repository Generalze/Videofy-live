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
 *
 * THAT PATH NOW EXISTS (founder's ruling 2026-08-27: translated
 * conversations). A translated message stores the ORIGINAL in `body` --
 * never discarded, always revealable -- plus one rendering for the
 * recipient in `translatedBody`/`translatedLanguage`, marked as a
 * translation wherever it is shown (COMMUNICATION_ARCHITECTURE.md 4.1).
 * Billing for it is deliberately NOT wired yet: the meter's unit for text
 * is a founder decision that has not been made, and free-while-staging is
 * stated in the product rather than silently assumed.
 *
 * WHAT A PERSON MAY DO TO A MESSAGE (founder rulings 2026-08-29). Reply,
 * forward, edit, retract, hide, react, pin, mute, archive and search. Two of
 * these -- edit and retract -- change the message for BOTH readers and so
 * live on the record itself; the rest are one reader's own facts and live in
 * the action port (message-actions.ts). The store composes them into a
 * READER-SCOPED VIEW: the same message looks different to each participant
 * (my reaction, my pin, my hide), and that difference is computed here, once,
 * rather than in every route that renders a message.
 *
 * A RETRACTION IS A TOMBSTONE, NOT A DELETION. The row stays so the
 * conversation keeps its shape (a reply to it still has something to point
 * at) but its content -- text, rendering, media -- is nulled server-side.
 * Nothing that was unsent can be fetched back by either party.
 */
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_CONVERSATION_SETTINGS,
  createInMemoryMessageActionPort,
  type ConversationSettings,
  type MessageActionPort,
} from './message-actions.js';

export type MessageKind = 'text' | 'voice';

export interface MessageRecord {
  readonly messageId: string;
  readonly lowAccountId: string;
  readonly highAccountId: string;
  readonly senderId: string;
  readonly kind: MessageKind;
  /** Present for text: ALWAYS the original words as typed. */
  readonly body: string | null;
  /** A translated rendering for the recipient, when the conversation is in translated mode. */
  readonly translatedBody?: string | null;
  /** The language `translatedBody` is in. */
  readonly translatedLanguage?: string | null;
  /** Present for voice: the server-side media file path. Never a URL. */
  readonly mediaPath: string | null;
  readonly mediaDurationMs: number | null;
  /**
   * A voice note spoken again in the recipient's language, beside the
   * original. The original stays authoritative and playable; this is a
   * derived file, and its absence means "hear the original".
   */
  readonly translatedMediaPath?: string | null;
  readonly translatedDurationMs?: number | null;
  readonly createdAtMs: number;
  /** Set when the RECIPIENT marked the conversation read. */
  readonly readAtMs: number | null;
  /** The message this one answers; always in the same conversation. */
  readonly replyToMessageId?: string | null;
  /** Provenance of a forward: the original message and who actually wrote it. */
  readonly forwardedFromMessageId?: string | null;
  readonly forwardedFromSenderId?: string | null;
  /** Set when the sender changed the text after sending. */
  readonly editedAtMs?: number | null;
  /** Set when the sender unsent it; content columns are null from then on. */
  readonly retractedAtMs?: number | null;
}

/** What the reader is shown in place of retracted content. */
export const RETRACTED_PLACEHOLDER = 'Message was removed';
/** The sender may fix a typo for this long after sending. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
/** A reply quotes this much of the original, and no more. */
const REPLY_PREVIEW_CHARS = 80;

export interface ReplySummary {
  readonly messageId: string;
  readonly senderId: string;
  readonly kind: MessageKind;
  readonly preview: string;
}

export interface ReactionSummary {
  readonly emoji: string;
  readonly count: number;
  readonly mine: boolean;
}

/** A message as ONE reader sees it: the record plus their own facts about it. */
export interface MessageView {
  readonly record: MessageRecord;
  readonly replyTo: ReplySummary | null;
  readonly reactions: readonly ReactionSummary[];
  readonly pinnedByMe: boolean;
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
  getMany(messageIds: readonly string[]): Promise<readonly MessageRecord[]>;
  /** Replace the text (and its rendering) of a message; both readers see it. */
  edit(
    messageId: string,
    change: {
      readonly body: string;
      readonly translatedBody: string | null;
      readonly translatedLanguage: string | null;
      readonly editedAtMs: number;
    },
  ): Promise<void>;
  /** Null every content column and stamp the tombstone. */
  retract(messageId: string, atMs: number): Promise<void>;
  /**
   * Case-insensitive substring over body and translatedBody of text
   * messages in the pair, newest first, retracted rows excluded.
   */
  search(
    lowAccountId: string,
    highAccountId: string,
    query: string,
    limit: number,
  ): Promise<readonly MessageRecord[]>;
}

/** The fixed pair order, matching the contact store exactly. */
export function messagePair(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

const MAX_TEXT_LENGTH = 4000;
const DEFAULT_PAGE = 50;
const SEARCH_LIMIT = 50;

export type SendRefusal = 'empty' | 'too-long' | 'bad-reply';

export type SendResult =
  | { readonly ok: true; readonly message: MessageRecord }
  | { readonly ok: false; readonly reason: SendRefusal };

export type EditRefusal =
  | 'not-found'
  | 'not-sender'
  | 'not-text'
  | 'retracted'
  | 'window-closed'
  | 'empty'
  | 'too-long';

export type EditResult =
  | { readonly ok: true; readonly message: MessageRecord }
  | { readonly ok: false; readonly reason: EditRefusal };

export type RetractRefusal = 'not-found' | 'not-sender' | 'retracted';

export type RetractResult =
  | {
      readonly ok: true;
      readonly message: MessageRecord;
      /** Every file the tombstone orphaned; the route unlinks them. */
      readonly mediaPaths: readonly string[];
    }
  | { readonly ok: false; readonly reason: RetractRefusal };

/**
 * Why a message may not be edited, or null if it may. Pure, so the route can
 * ask BEFORE paying for a translation and the store can ask again before
 * writing; the two answers cannot drift because they are one function.
 */
export function editRefusal(
  message: MessageRecord | null,
  editorId: string,
  nowMs: number,
): EditRefusal | null {
  if (message === null) return 'not-found';
  if (message.senderId !== editorId) return 'not-sender';
  if (message.kind !== 'text') return 'not-text';
  if (message.retractedAtMs) return 'retracted';
  if (nowMs - message.createdAtMs > EDIT_WINDOW_MS) return 'window-closed';
  return null;
}

/** Text the reader is shown: the tombstone wins over everything. */
export function displayBody(message: MessageRecord): string | null {
  if (message.retractedAtMs) return RETRACTED_PLACEHOLDER;
  return message.body;
}

export function replySummaryOf(original: MessageRecord): ReplySummary {
  const preview = original.retractedAtMs
    ? RETRACTED_PLACEHOLDER
    : original.kind === 'voice'
      ? 'Voice note'
      : (original.body ?? '').slice(0, REPLY_PREVIEW_CHARS);
  return {
    messageId: original.messageId,
    senderId: original.senderId,
    kind: original.kind,
    preview,
  };
}

export class MessageStore {
  private readonly port: MessageRecordPort;
  private readonly actions: MessageActionPort;
  private readonly now: () => number;

  constructor(options: {
    port: MessageRecordPort;
    /** Defaults to in-memory: a Postgres deployment MUST pass its own. */
    actions?: MessageActionPort;
    now?: () => number;
  }) {
    this.port = options.port;
    this.actions = options.actions ?? createInMemoryMessageActionPort();
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
  async sendText(
    senderId: string,
    recipientId: string,
    body: string,
    rendering?: { readonly translatedBody: string; readonly translatedLanguage: string },
    options: SendOptions = {},
  ): Promise<SendResult> {
    const trimmed = body.trim();
    if (trimmed.length === 0) return { ok: false, reason: 'empty' };
    if (trimmed.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'too-long' };

    const { low, high } = messagePair(senderId, recipientId);
    const replyTo = await this.resolveReply(low, high, options.replyToMessageId);
    if (replyTo === false) return { ok: false, reason: 'bad-reply' };
    const message: MessageRecord = {
      messageId: `msg_${randomBytes(12).toString('hex')}`,
      lowAccountId: low,
      highAccountId: high,
      senderId,
      kind: 'text',
      body: trimmed,
      ...(rendering === undefined
        ? {}
        : {
            translatedBody: rendering.translatedBody,
            translatedLanguage: rendering.translatedLanguage,
          }),
      mediaPath: null,
      mediaDurationMs: null,
      createdAtMs: this.now(),
      readAtMs: null,
      replyToMessageId: replyTo,
      ...provenance(options),
    };
    await this.port.append(message);
    return { ok: true, message };
  }

  /**
   * Send a voice note whose audio the route has already written to disk.
   *
   * A reply pointer that is not in this conversation is DROPPED, not
   * refused: the route asks `canReplyTo` before it writes the audio file,
   * so by the time this runs a bad pointer is a race, not a request, and a
   * voice note that arrives without its quote beats one that vanishes.
   */
  async sendVoice(
    senderId: string,
    recipientId: string,
    mediaPath: string,
    mediaDurationMs: number,
    options: SendOptions = {},
    /**
     * A second file the route ALSO wrote: the same note spoken in the
     * recipient's language, with its text. Same rule as text -- the original
     * is what is stored; the rendering sits beside it.
     */
    rendering?: {
      readonly translatedMediaPath: string;
      readonly translatedLanguage: string;
      readonly translatedBody: string;
      readonly translatedDurationMs: number;
    },
  ): Promise<MessageRecord> {
    const { low, high } = messagePair(senderId, recipientId);
    const replyTo = await this.resolveReply(low, high, options.replyToMessageId);
    const message: MessageRecord = {
      messageId: `msg_${randomBytes(12).toString('hex')}`,
      lowAccountId: low,
      highAccountId: high,
      senderId,
      kind: 'voice',
      body: null,
      ...(rendering === undefined
        ? {}
        : {
            translatedBody: rendering.translatedBody,
            translatedLanguage: rendering.translatedLanguage,
            translatedMediaPath: rendering.translatedMediaPath,
            translatedDurationMs: rendering.translatedDurationMs,
          }),
      mediaPath,
      mediaDurationMs,
      createdAtMs: this.now(),
      readAtMs: null,
      replyToMessageId: replyTo === false ? null : replyTo,
      ...provenance(options),
    };
    await this.port.append(message);
    return message;
  }

  /** Whether `messageId` may be quoted by a message between these two. */
  async canReplyTo(senderId: string, recipientId: string, messageId: string): Promise<boolean> {
    const { low, high } = messagePair(senderId, recipientId);
    return (await this.resolveReply(low, high, messageId)) !== false;
  }

  /**
   * A reply must point INTO the same conversation. Pointing at a message
   * from another pair would quote words the recipient was never party to.
   * Returns the id, null for no reply, or false for a refusal.
   */
  private async resolveReply(
    low: string,
    high: string,
    replyToMessageId: string | null | undefined,
  ): Promise<string | null | false> {
    if (replyToMessageId === undefined || replyToMessageId === null) return null;
    const original = await this.port.get(replyToMessageId);
    if (original === null || original.lowAccountId !== low || original.highAccountId !== high) {
      return false;
    }
    return original.messageId;
  }

  /** `editRefusal` on the store's own clock, so route and store agree. */
  mayEdit(message: MessageRecord | null, editorId: string): EditRefusal | null {
    return editRefusal(message, editorId, this.now());
  }

  /**
   * Edit the words of a text message. Sender only, text only, inside the
   * window, never a tombstone. The route supplies the rendering because the
   * translator is its seam, not this store's; passing null clears a stale one.
   */
  async editText(
    messageId: string,
    editorId: string,
    body: string,
    rendering: { readonly translatedBody: string; readonly translatedLanguage: string } | null,
  ): Promise<EditResult> {
    const message = await this.port.get(messageId);
    const refusal = editRefusal(message, editorId, this.now());
    if (refusal !== null || message === null) return { ok: false, reason: refusal ?? 'not-found' };
    const trimmed = body.trim();
    if (trimmed.length === 0) return { ok: false, reason: 'empty' };
    if (trimmed.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'too-long' };
    const change = {
      body: trimmed,
      translatedBody: rendering?.translatedBody ?? null,
      translatedLanguage: rendering?.translatedLanguage ?? null,
      editedAtMs: this.now(),
    };
    await this.port.edit(messageId, change);
    return { ok: true, message: { ...message, ...change } };
  }

  /**
   * Unsend. The caller receives the media path so it can unlink the file;
   * the store never touches the filesystem, and the row is already a
   * tombstone by the time the file goes.
   */
  async retract(messageId: string, senderId: string): Promise<RetractResult> {
    const message = await this.port.get(messageId);
    if (message === null) return { ok: false, reason: 'not-found' };
    if (message.senderId !== senderId) return { ok: false, reason: 'not-sender' };
    if (message.retractedAtMs) return { ok: false, reason: 'retracted' };
    const atMs = this.now();
    await this.port.retract(messageId, atMs);
    return {
      ok: true,
      mediaPaths: [message.mediaPath, message.translatedMediaPath ?? null].filter(
        (path): path is string => typeof path === 'string',
      ),
      message: {
        ...message,
        body: null,
        translatedBody: null,
        translatedLanguage: null,
        mediaPath: null,
        mediaDurationMs: null,
        translatedMediaPath: null,
        translatedDurationMs: null,
        retractedAtMs: atMs,
      },
    };
  }

  /* ---- one reader's own facts ------------------------------------------ */

  hide(messageId: string, accountId: string): Promise<void> {
    return this.actions.hide(messageId, accountId, this.now());
  }

  unhide(messageId: string, accountId: string): Promise<void> {
    return this.actions.unhide(messageId, accountId);
  }

  setReaction(messageId: string, accountId: string, emoji: string | null): Promise<void> {
    return this.actions.setReaction(messageId, accountId, emoji, this.now());
  }

  setPin(messageId: string, accountId: string, pinned: boolean): Promise<void> {
    return this.actions.setPin(messageId, accountId, pinned, this.now());
  }

  /** This account's pins inside one conversation, newest pin first. */
  async pinnedWith(accountId: string, partnerId: string): Promise<readonly MessageView[]> {
    const { low, high } = messagePair(accountId, partnerId);
    const ids = await this.actions.pinnedMessageIds(accountId);
    if (ids.length === 0) return [];
    const records = await this.port.getMany(ids);
    const byId = new Map(records.map((record) => [record.messageId, record]));
    const inPair = ids
      .map((id) => byId.get(id))
      .filter(
        (record): record is MessageRecord =>
          record !== undefined && record.lowAccountId === low && record.highAccountId === high,
      );
    return this.viewFor(accountId, inPair);
  }

  /** How many messages this account has pinned, across every conversation. */
  async savedCount(accountId: string): Promise<number> {
    return (await this.actions.pinnedMessageIds(accountId)).length;
  }

  settingsWith(accountId: string, partnerId: string): Promise<ConversationSettings> {
    return this.actions.settings(accountId, partnerId);
  }

  async setSettingsWith(
    accountId: string,
    partnerId: string,
    change: { readonly muted?: boolean | undefined; readonly archived?: boolean | undefined },
  ): Promise<ConversationSettings> {
    const current = await this.actions.settings(accountId, partnerId);
    const next: ConversationSettings = {
      muted: change.muted ?? current.muted,
      archived: change.archived ?? current.archived,
    };
    await this.actions.setSettings(accountId, partnerId, next, this.now());
    return next;
  }

  settingsFor(accountId: string): Promise<ReadonlyMap<string, ConversationSettings>> {
    return this.actions.settingsFor(accountId);
  }

  /** Text search inside one conversation, as this reader: hidden rows excluded. */
  async searchWith(
    accountId: string,
    partnerId: string,
    query: string,
  ): Promise<readonly MessageView[]> {
    const needle = query.trim();
    if (needle.length === 0) return [];
    const { low, high } = messagePair(accountId, partnerId);
    const hits = await this.port.search(low, high, needle, SEARCH_LIMIT);
    return this.viewFor(accountId, hits);
  }

  /**
   * The reader-scoped view. Drops what this reader hid, then decorates each
   * survivor with the quoted reply, everybody's reactions (with "mine"
   * marked) and whether this reader pinned it. Order is preserved.
   */
  async viewFor(
    readerId: string,
    records: readonly MessageRecord[],
  ): Promise<readonly MessageView[]> {
    if (records.length === 0) return [];
    const ids = records.map((record) => record.messageId);
    const hidden = await this.actions.hiddenFor(readerId, ids);
    const visible = records.filter((record) => !hidden.has(record.messageId));
    if (visible.length === 0) return [];
    const visibleIds = visible.map((record) => record.messageId);

    const replyIds = [
      ...new Set(
        visible
          .map((record) => record.replyToMessageId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const [reactions, pinned, originals] = await Promise.all([
      this.actions.reactionsFor(visibleIds),
      this.actions.pinnedFor(readerId, visibleIds),
      replyIds.length === 0
        ? Promise.resolve([] as readonly MessageRecord[])
        : this.port.getMany(replyIds),
    ]);
    const originalById = new Map(originals.map((record) => [record.messageId, record]));

    return visible.map((record) => {
      const original = record.replyToMessageId
        ? (originalById.get(record.replyToMessageId) ?? null)
        : null;
      return {
        record,
        replyTo: original === null ? null : replySummaryOf(original),
        reactions: summariseReactions(reactions.get(record.messageId) ?? [], readerId),
        pinnedByMe: pinned.has(record.messageId),
      };
    });
  }

  /** One view, for the routes that act on a single message. */
  async viewOne(readerId: string, record: MessageRecord): Promise<MessageView> {
    const [view] = await this.viewFor(readerId, [record]);
    return view ?? { record, replyTo: null, reactions: [], pinnedByMe: false };
  }

  static defaultSettings(): ConversationSettings {
    return DEFAULT_CONVERSATION_SETTINGS;
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

export interface SendOptions {
  readonly replyToMessageId?: string | null | undefined;
  readonly forwardedFrom?: { readonly messageId: string; readonly senderId: string } | undefined;
}

function provenance(
  options: SendOptions,
): Pick<MessageRecord, 'forwardedFromMessageId' | 'forwardedFromSenderId'> {
  return {
    forwardedFromMessageId: options.forwardedFrom?.messageId ?? null,
    forwardedFromSenderId: options.forwardedFrom?.senderId ?? null,
  };
}

function summariseReactions(
  reactions: readonly { readonly accountId: string; readonly emoji: string }[],
  readerId: string,
): readonly ReactionSummary[] {
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const reaction of reactions) {
    const entry = byEmoji.get(reaction.emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    if (reaction.accountId === readerId) entry.mine = true;
    byEmoji.set(reaction.emoji, entry);
  }
  return [...byEmoji.entries()].map(([emoji, entry]) => ({ emoji, ...entry }));
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

    async getMany(messageIds) {
      const wanted = new Set(messageIds);
      return rows.filter((row) => wanted.has(row.messageId));
    },

    async edit(messageId, change) {
      const index = rows.findIndex((row) => row.messageId === messageId);
      const row = rows[index];
      if (row === undefined) return;
      rows[index] = { ...row, ...change };
    },

    async retract(messageId, atMs) {
      const index = rows.findIndex((row) => row.messageId === messageId);
      const row = rows[index];
      if (row === undefined) return;
      rows[index] = {
        ...row,
        body: null,
        translatedBody: null,
        translatedLanguage: null,
        mediaPath: null,
        mediaDurationMs: null,
        translatedMediaPath: null,
        translatedDurationMs: null,
        retractedAtMs: atMs,
      };
    },

    async search(low, high, query, limit) {
      const needle = query.toLowerCase();
      return rows
        .filter(
          (row) =>
            row.lowAccountId === low &&
            row.highAccountId === high &&
            row.kind === 'text' &&
            !row.retractedAtMs &&
            ((row.body ?? '').toLowerCase().includes(needle) ||
              (row.translatedBody ?? '').toLowerCase().includes(needle)),
        )
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .slice(0, limit);
    },
  };
}
