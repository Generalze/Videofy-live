/** @author masterzee001 */
/**
 * Reaching a contact: messages, voice notes, and ringing their phone.
 *
 * ONE PERMISSION QUESTION GATES EVERYTHING HERE: `contacts.mayReach`. Being
 * someone's accepted contact is what grants ring, message and voice note --
 * that is the product rule, and it is asked once per request against the
 * contact store that owns it.
 *
 * REFUSALS ARE UNIFORM 404s. Messaging somebody who is not your contact
 * answers exactly like messaging an account that does not exist. Anything
 * else -- a 403, a different message -- turns this surface into an oracle for
 * which accounts are real and who is contacts with whom, which is precisely
 * what the contact graph exists to protect.
 *
 * MEDIA PATHS NEVER LEAVE THE SERVER. A voice note's audio is reachable only
 * through `/messages/media/:messageId`, which re-checks that the caller is a
 * participant on every request. The stored path is an implementation detail;
 * a response that carried it would be a response that could be replayed
 * against the filesystem.
 *
 * PUSH IS DISCREET FOR MESSAGES AND VISIBLE FOR RINGS, deliberately. A
 * translated message preview on a lock screen is readable by whoever holds
 * the phone; a ring is the one notification whose entire purpose is to be
 * seen immediately. The dispatcher's privacy redaction enforces the first;
 * urgency 'high' carries the second.
 *
 * ACTING ON A MESSAGE (founder rulings 2026-08-29). Reply, forward, edit,
 * retract, hide, react, pin, mute, archive, search. Two authorisation
 * shapes and no third: PARTICIPANT (either of the two people in the
 * conversation -- react, pin, hide, forward-from, read media) and SENDER
 * (only the author -- edit, retract). A non-participant gets the uniform
 * 404; a participant who is not the sender gets a 403, because they already
 * know the message exists. Every message the client sees is rendered
 * through the store's READER-SCOPED VIEW so "my reaction", "my pin" and
 * "hidden for me" are answered once, in one place.
 */
import { randomBytes } from 'node:crypto';
import type { RingRegistry } from './ring-registry.js';
import type { ConversationModePort } from './conversation-modes.js';
import type { TextTranslator } from './translation-client.js';
import type { VoiceNoteTranslator } from './voice-note-translation-client.js';
import { displayBody, messagePair, type MessageView } from './message-store.js';
import { callRecordToWire, type CallRecordPort } from './call-records.js';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import type { AccountStore } from './account-store.js';
import type { ContactStore } from './contact-store.js';
import type {
  EditRefusal,
  MessageRecord,
  MessageStore,
  SendRefusal,
} from './message-store.js';
import type { PushDispatcher } from './push/push-dispatcher.js';
import type { Caller } from './routes.js';

export interface MessageRouteDependencies {
  readonly store: AccountStore;
  readonly contacts: ContactStore;
  readonly messages: MessageStore;
  readonly push: PushDispatcher;
  /** Where voice-note audio lives. Created on first use. */
  readonly mediaDir: string;
  /** Pending rings for browsers, which poll instead of receiving push. */
  readonly rings: RingRegistry;
  /** See AccountRouteDependencies.officialAccounts. */
  readonly officialAccounts?: ReadonlySet<string>;
  /** Which pairs are in translated mode. Absent rows mean normal. */
  readonly conversationModes: ConversationModePort;
  /** The line to the translation engine; null resolves to sending the original. */
  readonly translator: TextTranslator;
  /** Same line, for voice notes: audio in, translated text and audio out. */
  readonly voiceTranslator: VoiceNoteTranslator;
  /** Call history for the pair; rendered in the timeline beside messages. */
  readonly calls?: CallRecordPort;
  readonly callerAccountId: (req: express.Request) => Caller | null;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

/** Voice notes: two minutes, ~3MB of AAC. Enough for a message, not a podcast. */
const MAX_VOICE_DURATION_MS = 120_000;
const MAX_VOICE_BYTES = 3 * 1024 * 1024;

/** What a message looks like to a client. `mediaPath` is deliberately absent. */
function toWire(message: MessageRecord): Record<string, unknown> {
  return {
    messageId: message.messageId,
    senderId: message.senderId,
    kind: message.kind,
    // A retracted message reads as its placeholder to BOTH sides; the
    // original words are gone from the row, not merely masked here.
    body: displayBody(message),
    // Marked as a translation wherever shown; the original stays revealable.
    translatedBody: message.translatedBody ?? null,
    translatedLanguage: message.translatedLanguage ?? null,
    mediaDurationMs: message.mediaDurationMs,
    // A voice note spoken again for the reader. The derived file is reached
    // through /messages/:messageId/voice/translated; its path never leaves.
    translatedDurationMs: message.translatedDurationMs ?? null,
    translatedAudioAvailable:
      typeof message.translatedMediaPath === 'string' && message.translatedMediaPath.length > 0,
    createdAtMs: message.createdAtMs,
    readAtMs: message.readAtMs,
    editedAtMs: message.editedAtMs ?? null,
    retractedAtMs: message.retractedAtMs ?? null,
    replyToMessageId: message.replyToMessageId ?? null,
    // Provenance, never authorship: the forwarder is `senderId`; the person
    // who actually wrote it is named here, on every forward, forever.
    forwardedFrom:
      typeof message.forwardedFromMessageId === 'string' &&
      typeof message.forwardedFromSenderId === 'string'
        ? { messageId: message.forwardedFromMessageId, senderId: message.forwardedFromSenderId }
        : null,
  };
}

/** The record plus this reader's own facts about it. */
function viewToWire(view: MessageView): Record<string, unknown> {
  return {
    ...toWire(view.record),
    replyTo: view.replyTo,
    reactions: view.reactions,
    pinnedByMe: view.pinnedByMe,
  };
}

/** A reaction is one short string; anything longer is not an emoji. */
const MAX_REACTION_CHARS = 16;

function sendRefusalText(reason: SendRefusal): string {
  switch (reason) {
    case 'empty':
      return 'Write a message.';
    case 'too-long':
      return 'That message is too long.';
    case 'bad-reply':
      return 'You can only reply to a message in this conversation.';
    default:
      return 'That message could not be sent.';
  }
}

function sendEditRefusal(res: express.Response, reason: EditRefusal): void {
  switch (reason) {
    case 'not-sender':
      res.status(403).json({ error: 'Only the sender can edit a message.' });
      return;
    case 'not-text':
      res.status(400).json({ error: 'Only text messages can be edited.' });
      return;
    case 'retracted':
      res.status(410).json({ error: 'That message was removed.' });
      return;
    case 'window-closed':
      res.status(409).json({ error: 'Messages can be edited for fifteen minutes.' });
      return;
    case 'empty':
      res.status(400).json({ error: 'Write a message.' });
      return;
    case 'too-long':
      res.status(400).json({ error: 'That message is too long.' });
      return;
    default:
      res.status(404).json({ error: 'Not found.' });
  }
}

export function registerMessageRoutes(
  app: express.Express,
  deps: MessageRouteDependencies,
): void {
  const refuse = (res: express.Response): void => {
    res.status(404).json({ error: 'Not found.' });
  };

  /**
   * Resolve the caller AND their standing with the target, or refuse.
   *
   * Null means the response has been sent. The contact check and the sign-in
   * check share one refusal shape on purpose -- see the module note.
   */
  const reachableTarget = (
    req: express.Request,
    res: express.Response,
  ): { caller: Caller; targetId: string } | null => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return null;
    }
    const targetId = req.params['accountId'] ?? '';
    if (targetId.length === 0 || !deps.contacts.mayReach(caller.accountId, targetId)) {
      refuse(res);
      return null;
    }
    return { caller, targetId };
  };

  const senderName = (accountId: string): string => {
    const account = deps.store.get(accountId);
    return account?.displayName ?? account?.username ?? 'A contact';
  };

  const notifyMessage = (recipientId: string, message: MessageRecord): void => {
    const pair = `${message.lowAccountId}:${message.highAccountId}`;
    /*
     * Fire and forget: delivery is best-effort by design, and a sender must
     * never wait on -- or learn about -- the state of the recipient's devices.
     *
     * MUTE IS DECIDED HERE AND ONLY HERE. The message is already stored and
     * already unread; a muted partner changes nothing but the push. The
     * sender is never told -- a mute the other side could detect is a mute
     * nobody would dare use.
     */
    void (async () => {
      const settings = await deps.messages.settingsWith(recipientId, message.senderId);
      if (settings.muted) {
        deps.onEvent?.('message.push.muted', { kind: message.kind });
        return;
      }
      // The recipient's own switch, gated in the same place as a mute and
      // for the same reason: the message is delivered, only the push is not.
      if (deps.store.get(recipientId)?.notificationsEnabled === false) {
        deps.onEvent?.('message.push.disabled', { kind: message.kind });
        return;
      }
      await deps.push.notify(recipientId, {
        kind: 'message',
        privacy: 'discreet',
        urgency: 'normal',
        title: 'New message',
        body: `${senderName(message.senderId)} sent you a message`,
        data: { kind: 'message', fromAccountId: message.senderId, messageId: message.messageId },
        collapseId: `msg-${pair}`,
      });
    })().catch(() => undefined);
  };

  /**
   * Resolve the caller and a message they are PARTY TO, or refuse.
   *
   * Null means the response has been sent. Not signed in is a 401; a
   * message that does not exist and a message between two other people are
   * the same 404 -- the id is unguessable, but unguessable is not
   * authorisation.
   */
  const participantMessage = async (
    req: express.Request,
    res: express.Response,
  ): Promise<{ caller: Caller; message: MessageRecord } | null> => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return null;
    }
    const message = await deps.messages.get(req.params['messageId'] ?? '');
    if (
      message === null ||
      (message.lowAccountId !== caller.accountId && message.highAccountId !== caller.accountId)
    ) {
      refuse(res);
      return null;
    }
    return { caller, message };
  };

  /**
   * The rendering of `text` for `recipientId`, if the pair is in translated
   * mode and the two languages differ. ONE seam for send, forward and edit:
   * the mode is resolved at the moment of the action, the recipient's
   * preference names the target, and a failed translation yields undefined
   * so the original goes out -- a message is never lost to a vendor outage.
   * The original is stored regardless. Events carry languages, never words.
   */
  const renderFor = async (
    senderId: string,
    recipientId: string,
    text: string,
  ): Promise<{ translatedBody: string; translatedLanguage: string } | undefined> => {
    const pair = messagePair(senderId, recipientId);
    const conversationMode = await deps.conversationModes.get(pair.low, pair.high);
    if (conversationMode?.mode !== 'translated') return undefined;
    const sender = deps.store.get(senderId);
    const recipient = deps.store.get(recipientId);
    // The finer facts, with primary as the fallback: source is what the
    // sender SPEAKS (writes), target is what the reader PREFERS TO HEAR.
    const sourceLanguage = sender?.spokenLanguage ?? sender?.defaultLanguage ?? 'en';
    const targetLanguage = recipient?.listeningLanguage ?? recipient?.defaultLanguage ?? null;
    if (targetLanguage === null || targetLanguage === sourceLanguage) {
      deps.onEvent?.('message.translate', {
        source: sourceLanguage,
        target: targetLanguage ?? 'unset',
        ok: -1,
      });
      return undefined;
    }
    const translated = await deps.translator.translate({
      sourceLanguage,
      targetLanguage,
      sourceText: text.trim().slice(0, 4000),
    });
    // The failure mode is DELIVER THE ORIGINAL, never a lost message --
    // but a translator that quietly nulls is undiagnosable in the field,
    // so the outcome is an event either way. Languages only; never text.
    deps.onEvent?.('message.translate', {
      source: sourceLanguage,
      target: targetLanguage,
      ok: translated === null ? 0 : 1,
    });
    return translated === null
      ? undefined
      : { translatedBody: translated, translatedLanguage: targetLanguage };
  };

  /** The optional reply pointer on a send; anything but a string is "no reply". */
  const replyPointer = (body: unknown): string | undefined => {
    const value = (body as { replyToMessageId?: unknown } | undefined)?.replyToMessageId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  /** The conversation list: who, what was last said, and how much is unread. */
  app.get('/messages/conversations', async (req, res) => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const summaries = await deps.messages.summariesFor(caller.accountId);
    const settings = await deps.messages.settingsFor(caller.accountId);
    res.json({
      conversations: summaries.map((summary) => {
        const partner = deps.store.get(summary.partnerId);
        const mine = settings.get(summary.partnerId);
        return {
          muted: mine?.muted ?? false,
          archived: mine?.archived ?? false,
          partner: {
            accountId: summary.partnerId,
            username: partner?.username ?? null,
            displayName: partner?.displayName ?? null,
            official: deps.officialAccounts?.has(summary.partnerId) ?? false,
          },
          last: toWire(summary.last),
          unread: summary.unread,
        };
      }),
    });
  });

  app.get('/messages/with/:accountId', async (req, res) => {
    const resolved = reachableTarget(req, res);
    if (resolved === null) return;
    const before = Number(req.query['before']);
    const messages = await deps.messages.conversationWith(
      resolved.caller.accountId,
      resolved.targetId,
      { beforeMs: Number.isFinite(before) ? before : undefined },
    );
    /*
     * CALLS ARE PART OF THE CONVERSATION (founder ruling 2026-08-29): finished
     * direct calls between these two people ride the same timeline as system
     * events, newest first like the messages, direction relative to the reader.
     * The client tells them apart by `kind: 'call'`.
     */
    const pair = messagePair(resolved.caller.accountId, resolved.targetId);
    const calls = deps.calls ? await deps.calls.forPair(pair.low, pair.high, 50) : [];
    // What THIS reader hid is gone from their page and nobody else's.
    const views = await deps.messages.viewFor(resolved.caller.accountId, messages);
    const timeline = [
      ...views.map((view) => ({ atMs: view.record.createdAtMs, item: viewToWire(view) })),
      ...calls
        .filter((record) => !Number.isFinite(before) || record.endedAtMs < before)
        .map((record) => ({
          atMs: record.endedAtMs,
          item: callRecordToWire(record, resolved.caller.accountId),
        })),
    ]
      .sort((a, b) => b.atMs - a.atMs)
      .map((entry) => entry.item);
    res.json({ messages: timeline });
  });

  app.post('/messages/with/:accountId', async (req, res) => {
    const resolved = reachableTarget(req, res);
    if (resolved === null) return;
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string') {
      res.status(400).json({ error: 'Write a message.' });
      return;
    }

    // Translated mode is resolved at SEND time; see renderFor.
    const rendering = await renderFor(resolved.caller.accountId, resolved.targetId, body);

    const result = await deps.messages.sendText(
      resolved.caller.accountId,
      resolved.targetId,
      body,
      rendering,
      { replyToMessageId: replyPointer(req.body) },
    );
    if (!result.ok) {
      res.status(400).json({ error: sendRefusalText(result.reason) });
      return;
    }
    notifyMessage(resolved.targetId, result.message);
    deps.onEvent?.('message.sent', {
      kind: 'text',
      translated: rendering === undefined ? 0 : 1,
      reply: result.message.replyToMessageId ? 1 : 0,
    });
    res
      .status(201)
      .json({
        message: viewToWire(await deps.messages.viewOne(resolved.caller.accountId, result.message)),
      });
  });

  /**
   * Forward: a NEW message from the forwarder, carrying provenance.
   *
   * The forwarder must be party to the original and reachable to the
   * target; the content is copied -- a voice note's file too, so a later
   * retraction of either side unlinks only its own file. A tombstone cannot
   * be forwarded: there is nothing left to carry.
   */
  app.post('/messages/with/:accountId/forward', async (req, res) => {
    const resolved = reachableTarget(req, res);
    if (resolved === null) return;
    const messageId = (req.body as { messageId?: unknown } | undefined)?.messageId;
    const original = typeof messageId === 'string' ? await deps.messages.get(messageId) : null;
    if (
      original === null ||
      (original.lowAccountId !== resolved.caller.accountId &&
        original.highAccountId !== resolved.caller.accountId)
    ) {
      refuse(res);
      return;
    }
    if (original.retractedAtMs) {
      res.status(410).json({ error: 'That message was removed.' });
      return;
    }
    const forwardedFrom = { messageId: original.messageId, senderId: original.senderId };

    if (original.kind === 'text' && original.body !== null) {
      const rendering = await renderFor(
        resolved.caller.accountId,
        resolved.targetId,
        original.body,
      );
      const result = await deps.messages.sendText(
        resolved.caller.accountId,
        resolved.targetId,
        original.body,
        rendering,
        { forwardedFrom },
      );
      if (!result.ok) {
        res.status(400).json({ error: sendRefusalText(result.reason) });
        return;
      }
      notifyMessage(resolved.targetId, result.message);
      deps.onEvent?.('message.sent', { kind: 'text', forwarded: 1 });
      res.status(201).json({
        message: viewToWire(await deps.messages.viewOne(resolved.caller.accountId, result.message)),
      });
      return;
    }

    if (original.kind === 'voice' && original.mediaPath !== null) {
      await mkdir(deps.mediaDir, { recursive: true });
      const mediaPath = join(deps.mediaDir, `vn_${randomBytes(12).toString('hex')}.m4a`);
      try {
        await copyFile(original.mediaPath, mediaPath);
      } catch {
        // Recorded but the file is gone -- a pruned disk or a moved deployment.
        refuse(res);
        return;
      }
      const message = await deps.messages.sendVoice(
        resolved.caller.accountId,
        resolved.targetId,
        mediaPath,
        original.mediaDurationMs ?? 0,
        { forwardedFrom },
      );
      notifyMessage(resolved.targetId, message);
      deps.onEvent?.('message.sent', { kind: 'voice', forwarded: 1 });
      res.status(201).json({
        message: viewToWire(await deps.messages.viewOne(resolved.caller.accountId, message)),
      });
      return;
    }
    refuse(res);
  });

  /**
   * Edit: the sender fixes their words. Text only, fifteen minutes, never
   * a tombstone. The refusal is asked BEFORE translating so a stranger's
   * PATCH costs nothing, and asked again inside the store before writing.
   * A translated conversation re-renders so the reader's copy never lags
   * the original; a dead translator clears the stale rendering rather than
   * leave an old translation beside new words.
   */
  app.patch('/messages/:messageId', async (req, res) => {
    const resolved = await participantMessage(req, res);
    if (resolved === null) return;
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string') {
      res.status(400).json({ error: 'Write a message.' });
      return;
    }
    const refusal = deps.messages.mayEdit(resolved.message, resolved.caller.accountId);
    if (refusal !== null) {
      sendEditRefusal(res, refusal);
      return;
    }
    const recipientId =
      resolved.message.lowAccountId === resolved.caller.accountId
        ? resolved.message.highAccountId
        : resolved.message.lowAccountId;
    const rendering = await renderFor(resolved.caller.accountId, recipientId, body);
    const result = await deps.messages.editText(
      resolved.message.messageId,
      resolved.caller.accountId,
      body,
      rendering ?? null,
    );
    if (!result.ok) {
      sendEditRefusal(res, result.reason);
      return;
    }
    deps.onEvent?.('message.edited', { translated: rendering === undefined ? 0 : 1 });
    res.json({
      message: viewToWire(await deps.messages.viewOne(resolved.caller.accountId, result.message)),
    });
  });

  /**
   * Retract (unsend): the sender's tombstone, seen by both. The row stays
   * so replies still have something to point at; the content is nulled in
   * the store and the audio unlinked here -- the file goes AFTER the row
   * stops naming it, so a crash between the two orphans a file, never
   * resurrects a message.
   */
  app.post('/messages/:messageId/retract', async (req, res) => {
    const resolved = await participantMessage(req, res);
    if (resolved === null) return;
    const result = await deps.messages.retract(
      resolved.message.messageId,
      resolved.caller.accountId,
    );
    if (!result.ok) {
      if (result.reason === 'not-sender') {
        res.status(403).json({ error: 'Only the sender can remove a message.' });
      } else if (result.reason === 'retracted') {
        res.status(410).json({ error: 'That message was already removed.' });
      } else {
        refuse(res);
      }
      return;
    }
    for (const path of result.mediaPaths) await unlink(path).catch(() => undefined);
    deps.onEvent?.('message.retracted', { kind: resolved.message.kind });
    res.json({
      message: viewToWire(await deps.messages.viewOne(resolved.caller.accountId, result.message)),
    });
  });

  /** Delete for me. The other side's timeline is untouched. */
  app.post('/messages/:messageId/hide', async (req, res) => {
    const resolved = await participantMessage(req, res);
    if (resolved === null) return;
    await deps.messages.hide(resolved.message.messageId, resolved.caller.accountId);
    res.json({ hidden: true });
  });

  /** The undo of delete-for-me. */
  app.delete('/messages/:messageId/hide', async (req, res) => {
    const resolved = await participantMessage(req, res);
    if (resolved === null) return;
    await deps.messages.unhide(resolved.message.messageId, resolved.caller.accountId);
    res.json({ hidden: false });
  });

  /** One reaction per person per message; null takes it back. */
  app.put('/messages/:messageId/reaction', async (req, res) => {
    const resolved = await participantMessage(req, res);
    if (resolved === null) return;
    const emoji = (req.body as { emoji?: unknown } | undefined)?.emoji;
    const chosen = emoji === null || emoji === undefined ? null : emoji;
    if (
      chosen !== null &&
      (typeof chosen !== 'string' ||
        chosen.trim().length === 0 ||
        [...chosen].length > MAX_REACTION_CHARS)
    ) {
      res.status(400).json({ error: 'Pick one emoji.' });
      return;
    }
    if (resolved.message.retractedAtMs) {
      res.status(410).json({ error: 'That message was removed.' });
      return;
    }
    await deps.messages.setReaction(
      resolved.message.messageId,
      resolved.caller.accountId,
      chosen === null ? null : chosen.trim(),
    );
    const view = await deps.messages.viewOne(resolved.caller.accountId, resolved.message);
    res.json({ reactions: view.reactions });
  });

  /** Pin (save) for me. The other side never learns what I pinned. */
  app.put('/messages/:messageId/pin', async (req, res) => {
    const resolved = await participantMessage(req, res);
    if (resolved === null) return;
    const pinned = (req.body as { pinned?: unknown } | undefined)?.pinned;
    if (typeof pinned !== 'boolean') {
      res.status(400).json({ error: 'Say whether it is pinned.' });
      return;
    }
    await deps.messages.setPin(resolved.message.messageId, resolved.caller.accountId, pinned);
    res.json({ pinnedByMe: pinned });
  });

  app.get('/messages/with/:accountId/pinned', async (req, res) => {
    const resolved = reachableTarget(req, res);
    if (resolved === null) return;
    const views = await deps.messages.pinnedWith(resolved.caller.accountId, resolved.targetId);
    res.json({ messages: views.map(viewToWire) });
  });

  /** Mute and archive, per account per partner. The partner is never told. */
  app.put('/messages/with/:accountId/settings', async (req, res) => {
    const resolved = reachableTarget(req, res);
    if (resolved === null) return;
    const payload = req.body as { muted?: unknown; archived?: unknown } | undefined;
    const muted = payload?.muted;
    const archived = payload?.archived;
    if (
      (muted !== undefined && typeof muted !== 'boolean') ||
      (archived !== undefined && typeof archived !== 'boolean')
    ) {
      res.status(400).json({ error: 'muted and archived are true or false.' });
      return;
    }
    const settings = await deps.messages.setSettingsWith(
      resolved.caller.accountId,
      resolved.targetId,
      { muted, archived },
    );
    deps.onEvent?.('message.settings', {
      muted: settings.muted ? 1 : 0,
      archived: settings.archived ? 1 : 0,
    });
    res.json(settings);
  });

  /**
   * Search inside one conversation. Substring, case-insensitive, over the
   * original AND the rendering so a reader finds a word in whichever
   * language they read it. Retracted rows never match; hidden-for-me rows
   * are dropped by the reader view.
   */
  app.get('/messages/with/:accountId/search', async (req, res) => {
    const resolved = reachableTarget(req, res);
    if (resolved === null) return;
    const q = req.query['q'];
    if (typeof q !== 'string' || q.trim().length === 0) {
      res.status(400).json({ error: 'Type something to search for.' });
      return;
    }
    const views = await deps.messages.searchWith(
      resolved.caller.accountId,
      resolved.targetId,
      q.slice(0, 200),
    );
    res.json({ messages: views.map(viewToWire) });
  });

  /**
   * The conversation's translation mode. One flag per pair; either
   * participant may read or flip it, and the flip changes what happens to
   * the NEXT message -- nothing retroactive. Billing for translated mode is
   * deliberately unwired while the text unit is undecided; the response
   * says so rather than letting silence read as "free forever".
   */
  app.get('/messages/with/:accountId/mode', async (req, res) => {
    const resolved = reachableTarget(req, res);
    if (resolved === null) return;
    const pair = messagePair(resolved.caller.accountId, resolved.targetId);
    const record = await deps.conversationModes.get(pair.low, pair.high);
    res.json({ mode: record?.mode ?? 'normal', billing: 'free-during-staging' });
  });

  app.post('/messages/with/:accountId/mode', async (req, res) => {
    const resolved = reachableTarget(req, res);
    if (resolved === null) return;
    const requested = (req.body as { mode?: unknown } | undefined)?.mode;
    if (requested !== 'normal' && requested !== 'translated') {
      res.status(400).json({ error: 'Mode is normal or translated.' });
      return;
    }
    const pair = messagePair(resolved.caller.accountId, resolved.targetId);
    await deps.conversationModes.set({
      lowAccountId: pair.low,
      highAccountId: pair.high,
      mode: requested,
      setByAccountId: resolved.caller.accountId,
      updatedAtMs: Date.now(),
    });
    deps.onEvent?.('message.mode', { mode: requested });
    res.json({ mode: requested, billing: 'free-during-staging' });
  });

  /*
   * Voice notes arrive as base64 JSON rather than multipart, so no new
   * dependency and no second body-parsing regime -- at the price of ~33%
   * transfer overhead on a capped payload, which is a fine trade at 3MB.
   * The larger parser is SCOPED TO THIS ROUTE: the global 16kb limit is a
   * deliberate DoS boundary and raising it everywhere to serve one endpoint
   * would quietly remove it.
   */
  app.post(
    '/messages/with/:accountId/voice',
    express.json({ limit: '6mb' }),
    async (req, res) => {
      const resolved = reachableTarget(req, res);
      if (resolved === null) return;

      const payload = req.body as
        | { audioBase64?: unknown; durationMs?: unknown; replyToMessageId?: unknown }
        | undefined;
      const audioBase64 = typeof payload?.audioBase64 === 'string' ? payload.audioBase64 : '';
      const durationMs = typeof payload?.durationMs === 'number' ? payload.durationMs : 0;

      if (audioBase64.length === 0 || durationMs <= 0 || durationMs > MAX_VOICE_DURATION_MS) {
        res.status(400).json({ error: 'Voice notes can be up to two minutes.' });
        return;
      }

      // A bad quote is refused BEFORE any audio touches the disk.
      const replyToMessageId = replyPointer(payload);
      if (
        replyToMessageId !== undefined &&
        !(await deps.messages.canReplyTo(
          resolved.caller.accountId,
          resolved.targetId,
          replyToMessageId,
        ))
      ) {
        res.status(400).json({ error: sendRefusalText('bad-reply') });
        return;
      }

      let audio: Buffer;
      try {
        audio = Buffer.from(audioBase64, 'base64');
      } catch {
        res.status(400).json({ error: 'That recording could not be read.' });
        return;
      }
      if (audio.length === 0 || audio.length > MAX_VOICE_BYTES) {
        res.status(400).json({ error: 'That recording is too large.' });
        return;
      }

      await mkdir(deps.mediaDir, { recursive: true });
      const mediaName = `vn_${randomBytes(12).toString('hex')}`;
      const mediaPath = join(deps.mediaDir, `${mediaName}.m4a`);
      await writeFile(mediaPath, audio);

      /*
       * TRANSLATED MODE, SAME RULE AS TEXT: resolved at send time, source is
       * what the sender speaks, target is what the reader prefers to hear,
       * and nothing to translate when they match. The ORIGINAL is already on
       * disk above and stays authoritative; the rendering is a second file
       * beside it, and any failure leaves the note exactly as recorded.
       * Events carry stage and languages only -- never audio or words.
       */
      let rendering:
        | {
            translatedMediaPath: string;
            translatedLanguage: string;
            translatedBody: string;
            translatedDurationMs: number;
          }
        | undefined;
      const pair = messagePair(resolved.caller.accountId, resolved.targetId);
      const conversationMode = await deps.conversationModes.get(pair.low, pair.high);
      if (conversationMode?.mode === 'translated') {
        const sender = deps.store.get(resolved.caller.accountId);
        const recipient = deps.store.get(resolved.targetId);
        const sourceLanguage = sender?.spokenLanguage ?? sender?.defaultLanguage ?? 'en';
        const targetLanguage =
          recipient?.listeningLanguage ?? recipient?.defaultLanguage ?? null;
        if (targetLanguage !== null && targetLanguage !== sourceLanguage) {
          const outcome = await deps.voiceTranslator.translate({
            audio,
            mime: 'audio/mp4',
            sourceLanguage,
            targetLanguage,
            durationMs: Math.round(durationMs),
          });
          if (outcome.ok) {
            const extension = outcome.rendering.mime.includes('wav') ? 'wav' : 'm4a';
            const translatedMediaPath = join(
              deps.mediaDir,
              `${mediaName}-translated-${targetLanguage}.${extension}`,
            );
            try {
              await writeFile(translatedMediaPath, outcome.rendering.audio);
              rendering = {
                translatedMediaPath,
                translatedLanguage: targetLanguage,
                translatedBody: outcome.rendering.translatedText,
                translatedDurationMs: outcome.rendering.durationMs,
              };
            } catch {
              // Disk refused the derived file; the original is untouched.
            }
          }
          deps.onEvent?.('message.voice.translate', {
            source: sourceLanguage,
            target: targetLanguage,
            ok: rendering === undefined ? 0 : 1,
            stage: outcome.ok ? (rendering === undefined ? 'store' : 'ok') : outcome.stage,
          });
        } else {
          deps.onEvent?.('message.voice.translate', {
            source: sourceLanguage,
            target: targetLanguage ?? 'unset',
            ok: -1,
            stage: 'skip',
          });
        }
      }

      const message = await deps.messages.sendVoice(
        resolved.caller.accountId,
        resolved.targetId,
        mediaPath,
        Math.round(durationMs),
        { replyToMessageId },
        rendering,
      );
      notifyMessage(resolved.targetId, message);
      deps.onEvent?.('message.sent', { kind: 'voice' });
      res.status(201).json({
        message: viewToWire(await deps.messages.viewOne(resolved.caller.accountId, message)),
      });
    },
  );

  app.post('/messages/with/:accountId/read', async (req, res) => {
    const resolved = reachableTarget(req, res);
    if (resolved === null) return;
    const marked = await deps.messages.markRead(resolved.caller.accountId, resolved.targetId);
    res.json({ marked });
  });

  /**
   * The audio behind a voice note.
   *
   * PARTICIPANT-CHECKED ON EVERY REQUEST. The message id is unguessable, but
   * unguessable is not authorisation: a forwarded link must still answer 404
   * to anybody who is not one of the two people in the conversation.
   */
  app.get('/messages/media/:messageId', async (req, res) => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const message = await deps.messages.get(req.params['messageId'] ?? '');
    if (
      message === null ||
      message.mediaPath === null ||
      (message.lowAccountId !== caller.accountId && message.highAccountId !== caller.accountId)
    ) {
      refuse(res);
      return;
    }
    try {
      const info = await stat(message.mediaPath);
      res.setHeader('content-type', 'audio/mp4');
      res.setHeader('content-length', String(info.size));
      createReadStream(message.mediaPath).pipe(res);
    } catch {
      // Recorded but the file is gone -- a pruned disk or a moved deployment.
      refuse(res);
    }
  });

  /**
   * The same note, spoken in the reader's language.
   *
   * IDENTICAL AUTHORISATION to the original: participants only, one 404 for
   * every other answer. A note that was never translated answers 404 too --
   * the client already knows from `translatedAudioAvailable`, and the
   * original route is always there.
   */
  app.get('/messages/:messageId/voice/translated', async (req, res) => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const message = await deps.messages.get(req.params['messageId'] ?? '');
    const translatedPath = message?.translatedMediaPath ?? null;
    if (
      message === null ||
      translatedPath === null ||
      translatedPath.length === 0 ||
      (message.lowAccountId !== caller.accountId && message.highAccountId !== caller.accountId)
    ) {
      refuse(res);
      return;
    }
    try {
      const info = await stat(translatedPath);
      res.setHeader('content-type', translatedPath.endsWith('.wav') ? 'audio/wav' : 'audio/mp4');
      res.setHeader('content-length', String(info.size));
      createReadStream(translatedPath).pipe(res);
    } catch {
      refuse(res);
    }
  });

  /**
   * Ring a contact's phones.
   *
   * THE CALLER SHOULD ALREADY BE IN THE CALL. The gateway only lets a verified
   * account CREATE a call, so the client joins first (becoming the host) and
   * rings second; the contact then joins an existing call, which requires no
   * verification. Ring-then-join would race the callee into being the creator.
   */
  app.post('/contacts/:accountId/ring', async (req, res) => {
    const resolved = reachableTarget(req, res);
    if (resolved === null) return;

    const provided = (req.body as { callId?: unknown } | undefined)?.callId;
    const callId =
      typeof provided === 'string' && provided.trim().length > 0
        ? provided.trim()
        : `ring-${randomBytes(5).toString('hex')}`;

    /*
     * THE CALL PUSH CLASS (founder ruling 2026-08-28). A push is only the
     * wake-up: HIGH priority so Doze does not batch it, a 30s lifetime so a
     * late delivery cannot ring a phone for a call that is already over, and
     * the pair's mode + expiry as DATA so the device can show "Normal call"
     * or "Translated call" and refuse to ring past expiry. No body content.
     * The timing chain starts here: T2 (sent to FCM) -> T3 (FCM answered).
     */
    const pair = messagePair(resolved.caller.accountId, resolved.targetId);
    const pairMode = (await deps.conversationModes.get(pair.low, pair.high))?.mode ?? 'normal';
    const issuedAtMs = Date.now();
    const RING_WINDOW_SECONDS = 30;
    const summary = await deps.push.notify(resolved.targetId, {
      kind: 'call',
      privacy: 'visible',
      urgency: 'high',
      // No title/body: a call push is a WAKE-UP for the native receiver, never
      // a tray notification (the provider drops them for kind 'call' anyway).
      data: {
        kind: 'call',
        callId,
        fromAccountId: resolved.caller.accountId,
        fromName: senderName(resolved.caller.accountId),
        mode: pairMode,
        issuedAt: String(issuedAtMs),
        expiresAt: String(issuedAtMs + RING_WINDOW_SECONDS * 1000),
      },
      collapseId: callId,
      ttlSeconds: RING_WINDOW_SECONDS,
    });
    deps.onEvent?.('direct_call.push', {
      attempted: summary.attempted,
      delivered: summary.delivered,
      fcmMs: Date.now() - issuedAtMs,
      mode: pairMode,
    });

    // The browser half of the ring: phones got a push above, laptops poll.
    deps.rings.note(resolved.targetId, {
      callId,
      fromAccountId: resolved.caller.accountId,
      fromName: senderName(resolved.caller.accountId),
      atMs: Date.now(),
    });

    deps.onEvent?.('contact.ring', { delivered: summary.delivered, attempted: summary.attempted });
    /*
     * `reachedDevices: 0` is a real answer the caller should see: it means the
     * contact has no registered phone and will not ring, and the caller can
     * stop waiting rather than sit in an empty call.
     */
    res.json({ callId, reachedDevices: summary.delivered });
  });

  /**
   * Who is calling me right now. Polled by the web dashboard; a phone never
   * needs this because its ring arrives as a push. Contact authority was
   * enforced when the ring was sent -- only reachable contacts could note one
   * -- so possession of the session is the whole check here.
   */
  app.get('/rings', (req, res) => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const rings = deps.rings.pendingFor(caller.accountId, Date.now());
    res.json({
      rings: rings.map((ring) => ({
        callId: ring.callId,
        fromAccountId: ring.fromAccountId,
        fromName: ring.fromName,
        atMs: ring.atMs,
      })),
    });
  });

  /** Joining and declining both dismiss; either way the banner must go. */
  app.post('/rings/:callId/dismiss', (req, res) => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    deps.rings.dismiss(caller.accountId, String(req.params['callId'] ?? ''));
    res.json({ dismissed: true });
  });
}
