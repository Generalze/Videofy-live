/** @author masterzee001 */
/**
 * The social surface (founder directive 2026-08-29): presence, the profile
 * extras, suggested connections, channel follows with a live push, reports,
 * and the four counts a profile screen shows.
 *
 * ONE FILE because every route here answers the same question from a
 * different angle -- "what may THIS caller learn about OTHER people" -- and
 * the answer rests on one graph. Presence is for accepted contacts only;
 * suggestions never name a private account or anyone already related;
 * interest counts are public because a channel is; a report is read by
 * nobody. Keeping those decisions side by side is what keeps them
 * consistent.
 *
 * THE LIVE SEAM is the one machine-to-machine route: the programme service
 * says a channel went live over the internal token, exactly as the gateway
 * reports a finished call. Same guard, same 404 for a wrong token, so it is
 * no more probeable than /internal/calls.
 *
 * Nothing here logs a bio, a note or a name. Events carry counts and kinds.
 */
import { randomUUID } from 'node:crypto';
import type express from 'express';
import {
  internalIngressRequestAllowed,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import { readDiscoveryMode } from '@videofy-live/account-trust';
import {
  ACCOUNT_AVAILABILITIES,
  BIO_MAX_LENGTH,
  type AccountAvailability,
  type AccountRecord,
  type AccountStore,
} from './account-store.js';
import type { CallRecordPort } from './call-records.js';
import { isChannelId, type ChannelFollowPort } from './channel-follows.js';
import type { ContactStore } from './contact-store.js';
import type { MessageStore } from './message-store.js';
import type { PresenceRegistry, PresenceState } from './presence.js';
import type { PushDispatcher } from './push/push-dispatcher.js';
import {
  REPORTS_PER_HOUR,
  REPORT_NOTE_MAX_LENGTH,
  isReportReason,
  type ReportPort,
} from './reports.js';
import type { Caller } from './routes.js';

export interface SocialRouteDependencies {
  readonly store: AccountStore;
  readonly contacts: ContactStore;
  readonly presence: PresenceRegistry;
  readonly follows: ChannelFollowPort;
  readonly reports: ReportPort;
  readonly push: PushDispatcher;
  /** For /me/counts. Optional only so a harness without them can still run. */
  readonly calls?: CallRecordPort;
  readonly messages?: MessageStore;
  /** See AccountRouteDependencies.officialAccounts. */
  readonly officialAccounts?: ReadonlySet<string>;
  /** The internal seam. Unconfigured means the live route is not registered. */
  readonly internalAuth: InternalIngressAuthResolution;
  readonly callerAccountId: (req: express.Request) => Caller | null;
  readonly nowMs?: () => number;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

/** Suggestions stop here; a longer list is a directory, not a suggestion. */
const MAX_SUGGESTIONS = 10;
/** Below this many mutual-contact suggestions, newcomers fill the list. */
const MIN_SUGGESTIONS_BEFORE_TOPUP = 3;
/** Ids per presence or interest query. Enough for a contact list, not a scrape. */
const MAX_IDS_PER_QUERY = 200;

/** `?ids=a,b,c` as a bounded, de-duplicated list. */
function idsFromQuery(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(',').map((id) => id.trim()).filter((id) => id.length > 0))].slice(
    0,
    MAX_IDS_PER_QUERY,
  );
}

function presentedToken(req: express.Request): string | undefined {
  const header = req.header('X-Videofy-Internal-Token');
  return typeof header === 'string' && header.length > 0 ? header : undefined;
}

export function registerSocialRoutes(app: express.Express, deps: SocialRouteDependencies): void {
  const nowMs = deps.nowMs ?? (() => Date.now());

  const signedIn = (req: express.Request, res: express.Response): Caller | null => {
    const caller = deps.callerAccountId(req);
    if (caller === null) res.status(401).json({ error: 'Sign in to continue.' });
    return caller;
  };

  const presenceOf = (record: AccountRecord): PresenceState =>
    deps.presence.stateOf(record.accountId, record.availability);

  /* ---------------------------------------------------------------- presence */

  app.post('/presence/heartbeat', (req, res) => {
    const caller = signedIn(req, res);
    if (caller === null) return;
    const state = (req.body as { state?: unknown } | undefined)?.state;
    if (state !== 'active' && state !== 'busy') {
      res.status(400).json({ error: "state is 'active' or 'busy'." });
      return;
    }
    deps.presence.heartbeat(caller.accountId, state);
    deps.presence.sweep();
    res.status(200).json({ ok: true });
  });

  /**
   * Presence for a list of ids -- ANSWERED ONLY FOR ACCEPTED CONTACTS. An id
   * that is not one is simply absent from the answer: not 'away', which
   * would let a stranger tell "not my contact" from "my contact, offline".
   */
  app.get('/presence', (req, res) => {
    const caller = signedIn(req, res);
    if (caller === null) return;
    const mine = new Set(
      deps.contacts.contactsOf(caller.accountId).map((edge) => deps.contacts.other(edge, caller.accountId)),
    );
    const presence: Record<string, PresenceState> = {};
    for (const id of idsFromQuery(req.query['ids'])) {
      if (!mine.has(id)) continue;
      const record = deps.store.get(id);
      if (record === null) continue;
      presence[id] = presenceOf(record);
    }
    res.status(200).json({ presence });
  });

  /* ----------------------------------------------------------------- profile */

  app.patch('/profile', async (req, res) => {
    const caller = signedIn(req, res);
    if (caller === null) return;
    const body = (req.body ?? {}) as {
      bio?: unknown;
      availability?: unknown;
      notificationsEnabled?: unknown;
    };
    const extras: {
      bio?: string;
      availability?: AccountAvailability;
      notificationsEnabled?: boolean;
    } = {};
    if (body.bio !== undefined) {
      if (typeof body.bio !== 'string' || body.bio.length > BIO_MAX_LENGTH) {
        res.status(400).json({ error: `bio is text of at most ${BIO_MAX_LENGTH} characters.` });
        return;
      }
      extras.bio = body.bio.trim();
    }
    if (body.availability !== undefined) {
      if (!(ACCOUNT_AVAILABILITIES as readonly unknown[]).includes(body.availability)) {
        res.status(400).json({ error: "availability is 'auto', 'busy' or 'away'." });
        return;
      }
      extras.availability = body.availability as AccountAvailability;
    }
    if (body.notificationsEnabled !== undefined) {
      if (typeof body.notificationsEnabled !== 'boolean') {
        res.status(400).json({ error: 'notificationsEnabled is true or false.' });
        return;
      }
      extras.notificationsEnabled = body.notificationsEnabled;
    }
    const updated = await deps.store.setProfileExtras(caller.accountId, extras);
    if (updated === null) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    deps.onEvent?.('profile.extras.updated', {
      fields: Object.keys(extras).length,
      availability: updated.availability ?? 'auto',
      notificationsEnabled: updated.notificationsEnabled === false ? 0 : 1,
    });
    res.status(200).json({
      bio: updated.bio ?? '',
      availability: updated.availability ?? 'auto',
      notificationsEnabled: updated.notificationsEnabled !== false,
    });
  });

  /* ------------------------------------------------------------- suggestions */

  /**
   * People you might know. Two rules make it safe, and both are structural:
   * the candidate pool is `discoverableAccounts()`, so a private account is
   * never in it; and anyone with an edge of ANY state to the caller is
   * removed before ranking, so a block or a pending request is never
   * "suggested" back.
   */
  app.get('/contacts/suggestions', (req, res) => {
    const caller = signedIn(req, res);
    if (caller === null) return;
    const me = caller.accountId;
    const related = new Set(
      deps.contacts.edgesOf(me).map((edge) => deps.contacts.other(edge, me)),
    );
    const excluded = (accountId: string): boolean => accountId === me || related.has(accountId);

    // Contacts-of-contacts, counted. Only ACCEPTED edges on both hops: a
    // pending request is not a relationship anyone should be inferred from.
    const mutual = new Map<string, number>();
    for (const first of deps.contacts.contactsOf(me)) {
      const friend = deps.contacts.other(first, me);
      for (const second of deps.contacts.contactsOf(friend)) {
        const candidate = deps.contacts.other(second, friend);
        if (excluded(candidate)) continue;
        mutual.set(candidate, (mutual.get(candidate) ?? 0) + 1);
      }
    }

    const discoverable = new Map(
      deps.store.discoverableAccounts().map((record) => [record.accountId, record] as const),
    );
    const describe = (
      record: AccountRecord,
      mutualCount: number,
      reason: 'mutual-contacts' | 'new-on-c7',
    ) => ({
      accountId: record.accountId,
      username: record.username ?? null,
      displayName: record.displayName ?? null,
      official: deps.officialAccounts?.has(record.accountId) ?? false,
      spokenLanguage: record.spokenLanguage ?? record.defaultLanguage ?? null,
      mutualCount,
      reason,
    });

    const ranked = [...mutual.entries()]
      .filter(([accountId]) => discoverable.has(accountId))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_SUGGESTIONS)
      .map(([accountId, count]) => describe(discoverable.get(accountId)!, count, 'mutual-contacts'));

    if (ranked.length < MIN_SUGGESTIONS_BEFORE_TOPUP) {
      const already = new Set(ranked.map((entry) => entry.accountId));
      const newcomers = [...discoverable.values()]
        .filter((record) => !excluded(record.accountId) && !already.has(record.accountId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.accountId.localeCompare(b.accountId))
        .slice(0, MAX_SUGGESTIONS - ranked.length)
        .map((record) => describe(record, 0, 'new-on-c7'));
      ranked.push(...newcomers);
    }

    res.status(200).json({ suggestions: ranked });
  });

  /* ----------------------------------------------------------------- follows */

  app.put('/channels/:channelId/follow', async (req, res) => {
    const caller = signedIn(req, res);
    if (caller === null) return;
    const channelId = req.params['channelId'];
    if (!isChannelId(channelId)) {
      res.status(400).json({ error: 'Not a channel id.' });
      return;
    }
    const body = (req.body ?? {}) as { following?: unknown; remind?: unknown };
    if (typeof body.following !== 'boolean' || (body.remind !== undefined && typeof body.remind !== 'boolean')) {
      res.status(400).json({ error: 'following is true or false; remind, if given, likewise.' });
      return;
    }
    if (!body.following) {
      await deps.follows.remove(caller.accountId, channelId);
      deps.onEvent?.('channel.unfollowed', {});
      res.status(200).json({ following: false, remind: false });
      return;
    }
    // Re-following keeps the original date, so "following since" is honest
    // and the follows list does not reorder when a reminder is toggled.
    const existing = (await deps.follows.followsOf(caller.accountId)).find(
      (follow) => follow.channelId === channelId,
    );
    const remind = body.remind ?? existing?.remind ?? false;
    await deps.follows.upsert({
      accountId: caller.accountId,
      channelId,
      followedAtMs: existing?.followedAtMs ?? nowMs(),
      remind,
    });
    deps.onEvent?.('channel.followed', { remind: remind ? 1 : 0 });
    res.status(200).json({ following: true, remind });
  });

  app.get('/channels/follows', async (req, res) => {
    const caller = signedIn(req, res);
    if (caller === null) return;
    const follows = await deps.follows.followsOf(caller.accountId);
    res.status(200).json({
      follows: follows.map((follow) => ({ channelId: follow.channelId, remind: follow.remind })),
    });
  });

  /** Public: how many people follow each channel. No sign-in, no names. */
  app.get('/channels/interest', async (req, res) => {
    const ids = idsFromQuery(req.query['ids']).filter(isChannelId);
    const counts: Record<string, number> = {};
    const found = await deps.follows.countFor(ids);
    for (const id of ids) counts[id] = found.get(id) ?? 0;
    res.status(200).json({ counts });
  });

  if (deps.internalAuth.mode === 'unconfigured') {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        service: 'account',
        level: 'warn',
        message: 'Internal channel-live endpoint NOT registered: no INTERNAL_WEBRTC_TOKEN.',
      }),
    );
  } else {
    /**
     * The programme service says a channel went live. Fan out to every
     * follower who asked to be reminded AND has not switched notifications
     * off. Going offline is recorded and pushes nothing -- nobody wants to
     * be woken to hear that something stopped.
     */
    app.post('/internal/channels/:channelId/live', async (req, res) => {
      if (!internalIngressRequestAllowed(deps.internalAuth, presentedToken(req))) {
        res.status(404).json({ error: 'Not found.' });
        return;
      }
      const channelId = req.params['channelId'];
      const body = (req.body ?? {}) as { live?: unknown; displayName?: unknown };
      if (!isChannelId(channelId) || typeof body.live !== 'boolean' || typeof body.displayName !== 'string') {
        res.status(400).json({ error: 'Not a live event.' });
        return;
      }
      const displayName = body.displayName.trim().slice(0, 80) || 'A channel';
      if (!body.live) {
        deps.onEvent?.('channel.live', { live: 0 });
        res.status(200).json({ notified: 0 });
        return;
      }
      const followers = await deps.follows.followersOf(channelId);
      const reminded = followers.filter(
        (follow) => follow.remind && deps.store.get(follow.accountId)?.notificationsEnabled !== false,
      );
      // Concurrent, like a ring: a live moment is time-critical and a
      // thousand sequential pushes would announce it after it ended.
      await Promise.all(
        reminded.map((follow) =>
          deps.push.notify(follow.accountId, {
            kind: 'message',
            privacy: 'visible',
            urgency: 'normal',
            title: `${displayName} is live on C7`,
            data: { kind: 'channel-live', channelId },
            collapseId: `channel-live-${channelId}`,
          }),
        ),
      );
      deps.onEvent?.('channel.live', { live: 1, followers: followers.length, notified: reminded.length });
      res.status(200).json({ notified: reminded.length });
    });
  }

  /* ----------------------------------------------------------------- reports */

  app.post('/reports', async (req, res) => {
    const caller = signedIn(req, res);
    if (caller === null) return;
    const body = (req.body ?? {}) as {
      accountId?: unknown;
      messageId?: unknown;
      reason?: unknown;
      note?: unknown;
    };
    const targetId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
    const messageId = body.messageId === undefined || body.messageId === null ? null : body.messageId;
    const note = body.note === undefined ? '' : body.note;
    if (
      targetId.length === 0 ||
      targetId === caller.accountId ||
      !isReportReason(body.reason) ||
      (messageId !== null && (typeof messageId !== 'string' || messageId.length === 0)) ||
      typeof note !== 'string' ||
      note.length > REPORT_NOTE_MAX_LENGTH
    ) {
      res.status(400).json({ error: 'A report names another account, a reason, and at most 500 characters of note.' });
      return;
    }
    const now = nowMs();
    const recent = await deps.reports.countByReporterSince(caller.accountId, now - 60 * 60 * 1000);
    if (recent >= REPORTS_PER_HOUR) {
      deps.onEvent?.('report.rate-limited', {});
      res.status(429).json({ error: 'Too many reports in the last hour. Try again later.' });
      return;
    }
    const reportId = `rep_${randomUUID()}`;
    await deps.reports.insert({
      reportId,
      reporterAccountId: caller.accountId,
      targetAccountId: targetId,
      messageId: messageId as string | null,
      reason: body.reason,
      note: note.trim(),
      createdAtMs: now,
    });
    // The reason is a closed enum and safe to count; nothing else is logged.
    deps.onEvent?.('report.filed', { reason: body.reason, withMessage: messageId === null ? 0 : 1 });
    res.status(201).json({ reportId });
  });

  /* ------------------------------------------------------------------ counts */

  app.get('/me/counts', async (req, res) => {
    const caller = signedIn(req, res);
    if (caller === null) return;
    const [calls, following, saved] = await Promise.all([
      deps.calls?.countForAccount(caller.accountId) ?? Promise.resolve(0),
      deps.follows.countOf(caller.accountId),
      deps.messages?.savedCount(caller.accountId) ?? Promise.resolve(0),
    ]);
    res.status(200).json({
      connections: deps.contacts.contactsOf(caller.accountId).length,
      calls,
      following,
      saved,
    });
  });
}
