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
 */
import { randomBytes } from 'node:crypto';
import type { RingRegistry } from './ring-registry.js';
import type { ConversationModePort } from './conversation-modes.js';
import type { TextTranslator } from './translation-client.js';
import { messagePair } from './message-store.js';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import type { AccountStore } from './account-store.js';
import type { ContactStore } from './contact-store.js';
import type { MessageRecord, MessageStore } from './message-store.js';
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
    body: message.body,
    // Marked as a translation wherever shown; the original stays revealable.
    translatedBody: message.translatedBody ?? null,
    translatedLanguage: message.translatedLanguage ?? null,
    mediaDurationMs: message.mediaDurationMs,
    createdAtMs: message.createdAtMs,
    readAtMs: message.readAtMs,
  };
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
     */
    void deps.push
      .notify(recipientId, {
        kind: 'message',
        privacy: 'discreet',
        urgency: 'normal',
        title: 'New message',
        body: `${senderName(message.senderId)} sent you a message`,
        data: { kind: 'message', fromAccountId: message.senderId, messageId: message.messageId },
        collapseId: `msg-${pair}`,
      })
      .catch(() => undefined);
  };

  /** The conversation list: who, what was last said, and how much is unread. */
  app.get('/messages/conversations', async (req, res) => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const summaries = await deps.messages.summariesFor(caller.accountId);
    res.json({
      conversations: summaries.map((summary) => {
        const partner = deps.store.get(summary.partnerId);
        return {
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
    res.json({ messages: messages.map(toWire) });
  });

  app.post('/messages/with/:accountId', async (req, res) => {
    const resolved = reachableTarget(req, res);
    if (resolved === null) return;
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string') {
      res.status(400).json({ error: 'Write a message.' });
      return;
    }

    /*
     * TRANSLATED MODE, RESOLVED AT SEND TIME. The rendering targets the
     * RECIPIENT's default language; the sender's default names the source.
     * Missing preferences or matching languages mean nothing to translate,
     * and a failed translation delivers the original -- a message is never
     * lost to a vendor outage. The original is stored regardless.
     */
    const pair = messagePair(resolved.caller.accountId, resolved.targetId);
    const conversationMode = await deps.conversationModes.get(pair.low, pair.high);
    let rendering: { translatedBody: string; translatedLanguage: string } | undefined;
    if (conversationMode?.mode === 'translated') {
      const sourceLanguage = deps.store.get(resolved.caller.accountId)?.defaultLanguage ?? 'en';
      const targetLanguage = deps.store.get(resolved.targetId)?.defaultLanguage ?? null;
      if (targetLanguage !== null && targetLanguage !== sourceLanguage) {
        const translated = await deps.translator.translate({
          sourceLanguage,
          targetLanguage,
          sourceText: body.trim().slice(0, 4000),
        });
        if (translated !== null) {
          rendering = { translatedBody: translated, translatedLanguage: targetLanguage };
        }
      }
    }

    const result = await deps.messages.sendText(
      resolved.caller.accountId,
      resolved.targetId,
      body,
      rendering,
    );
    if (!result.ok) {
      res.status(400).json({
        error: result.reason === 'empty' ? 'Write a message.' : 'That message is too long.',
      });
      return;
    }
    notifyMessage(resolved.targetId, result.message);
    deps.onEvent?.('message.sent', {
      kind: 'text',
      translated: rendering === undefined ? 0 : 1,
    });
    res.status(201).json({ message: toWire(result.message) });
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

      const payload = req.body as { audioBase64?: unknown; durationMs?: unknown } | undefined;
      const audioBase64 = typeof payload?.audioBase64 === 'string' ? payload.audioBase64 : '';
      const durationMs = typeof payload?.durationMs === 'number' ? payload.durationMs : 0;

      if (audioBase64.length === 0 || durationMs <= 0 || durationMs > MAX_VOICE_DURATION_MS) {
        res.status(400).json({ error: 'Voice notes can be up to two minutes.' });
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
      const mediaPath = join(deps.mediaDir, `vn_${randomBytes(12).toString('hex')}.m4a`);
      await writeFile(mediaPath, audio);

      const message = await deps.messages.sendVoice(
        resolved.caller.accountId,
        resolved.targetId,
        mediaPath,
        Math.round(durationMs),
      );
      notifyMessage(resolved.targetId, message);
      deps.onEvent?.('message.sent', { kind: 'voice' });
      res.status(201).json({ message: toWire(message) });
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

    const summary = await deps.push.notify(resolved.targetId, {
      kind: 'call',
      privacy: 'visible',
      urgency: 'high',
      title: 'Incoming call',
      body: `${senderName(resolved.caller.accountId)} is calling you on Videofy`,
      data: {
        kind: 'call',
        callId,
        fromAccountId: resolved.caller.accountId,
        fromName: senderName(resolved.caller.accountId),
      },
      collapseId: callId,
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
