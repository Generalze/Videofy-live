/** @author masterzee001 */
/**
 * What a person does TO a message, as opposed to what a message is.
 *
 * WHY A SECOND PORT beside the message records. Hides, reactions, pins and
 * per-partner settings are all facts about ONE ACCOUNT's relationship to a
 * message or a conversation -- they are never part of the message itself,
 * and the other participant must not see most of them. Folding them into the
 * `messages` row would have meant either a JSONB column that two people race
 * to update, or per-account columns that grow with every founder ruling.
 * Side tables keyed by (message_id, account_id) make "user-scoped" a property
 * of the schema rather than of every query remembering to filter.
 *
 * WHAT IS DELIBERATELY NOT HERE. Edit and retract change the message for BOTH
 * readers, so they live on the message record port. Forward creates a new
 * message, so it is a send. This port holds only the things one reader owns.
 *
 * MUTE IS A PUSH DECISION, NOT A DELIVERY DECISION. A muted partner's
 * messages still arrive and still count as unread; only the notification is
 * withheld. The gate is applied where the push is dispatched, and nowhere
 * else, so a muted conversation is never a lost one.
 */

export interface MessageReaction {
  readonly accountId: string;
  readonly emoji: string;
}

export interface ConversationSettings {
  readonly muted: boolean;
  readonly archived: boolean;
}

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  muted: false,
  archived: false,
};

export interface MessageActionPort {
  /** Delete-for-me: hidden from this reader's timeline only. Idempotent. */
  hide(messageId: string, accountId: string, atMs: number): Promise<void>;
  /** The undo of `hide`. Idempotent. */
  unhide(messageId: string, accountId: string): Promise<void>;
  /** Which of `messageIds` this reader has hidden. */
  hiddenFor(accountId: string, messageIds: readonly string[]): Promise<ReadonlySet<string>>;

  /** One reaction per account per message; null removes it. */
  setReaction(
    messageId: string,
    accountId: string,
    emoji: string | null,
    atMs: number,
  ): Promise<void>;
  /** Every reaction on each of `messageIds`, keyed by message id. */
  reactionsFor(
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly MessageReaction[]>>;

  setPin(messageId: string, accountId: string, pinned: boolean, atMs: number): Promise<void>;
  /** Which of `messageIds` this account has pinned. */
  pinnedFor(accountId: string, messageIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** Every message id this account has pinned, newest pin first. */
  pinnedMessageIds(accountId: string): Promise<readonly string[]>;

  setSettings(
    accountId: string,
    partnerId: string,
    settings: ConversationSettings,
    atMs: number,
  ): Promise<void>;
  settings(accountId: string, partnerId: string): Promise<ConversationSettings>;
  /** Every partner this account has settings for. Absent partners are defaults. */
  settingsFor(accountId: string): Promise<ReadonlyMap<string, ConversationSettings>>;
}

/** In-memory port, for tests and database-less deployments. */
export function createInMemoryMessageActionPort(): MessageActionPort {
  const key = (a: string, b: string): string => `${a}\u0000${b}`;
  const hides = new Map<string, number>();
  const reactions = new Map<string, { emoji: string; atMs: number }>();
  const pins = new Map<string, number>();
  const settings = new Map<string, ConversationSettings>();

  return {
    async hide(messageId, accountId, atMs) {
      hides.set(key(messageId, accountId), atMs);
    },
    async unhide(messageId, accountId) {
      hides.delete(key(messageId, accountId));
    },
    async hiddenFor(accountId, messageIds) {
      return new Set(messageIds.filter((id) => hides.has(key(id, accountId))));
    },

    async setReaction(messageId, accountId, emoji, atMs) {
      if (emoji === null) reactions.delete(key(messageId, accountId));
      else reactions.set(key(messageId, accountId), { emoji, atMs });
    },
    async reactionsFor(messageIds) {
      const wanted = new Set(messageIds);
      const byMessage = new Map<string, MessageReaction[]>();
      for (const [composite, reaction] of reactions) {
        const [messageId, accountId] = composite.split('\u0000');
        if (messageId === undefined || accountId === undefined || !wanted.has(messageId)) continue;
        const list = byMessage.get(messageId) ?? [];
        list.push({ accountId, emoji: reaction.emoji });
        byMessage.set(messageId, list);
      }
      return byMessage;
    },

    async setPin(messageId, accountId, pinned, atMs) {
      if (pinned) pins.set(key(messageId, accountId), atMs);
      else pins.delete(key(messageId, accountId));
    },
    async pinnedFor(accountId, messageIds) {
      return new Set(messageIds.filter((id) => pins.has(key(id, accountId))));
    },
    async pinnedMessageIds(accountId) {
      return [...pins.entries()]
        .map(([composite, atMs]) => {
          const [messageId, owner] = composite.split('\u0000');
          return { messageId: messageId ?? '', owner: owner ?? '', atMs };
        })
        .filter((entry) => entry.owner === accountId)
        .sort((a, b) => b.atMs - a.atMs)
        .map((entry) => entry.messageId);
    },

    async setSettings(accountId, partnerId, value) {
      settings.set(key(accountId, partnerId), value);
    },
    async settings(accountId, partnerId) {
      return settings.get(key(accountId, partnerId)) ?? DEFAULT_CONVERSATION_SETTINGS;
    },
    async settingsFor(accountId) {
      const out = new Map<string, ConversationSettings>();
      for (const [composite, value] of settings) {
        const [owner, partnerId] = composite.split('\u0000');
        if (owner === accountId && partnerId !== undefined) out.set(partnerId, value);
      }
      return out;
    },
  };
}
