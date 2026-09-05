/** @author masterzee001 */
/**
 * The Replay product surface: what an operator sets, and what an audience sees.
 *
 * FOUR RULES DECIDE EVERY HANDLER BELOW.
 *
 * 1. THE OWNER IS FOUND BY THEIR SESSION, never by an id in a path. Exactly as
 *    `channel-routes.ts` does it, and for the same reason: an id in a path is a
 *    value the caller chose, so preferring it -- or falling back to it -- turns
 *    a tenant boundary into a suggestion. `/channels/mine/...` has no id to
 *    vary. The programme routes do carry one, and it is checked against the
 *    same `mayAdminister` seam the vocabulary and sponsored-creative routes
 *    already use. No second admin concept is introduced here.
 *
 * 2. THE CHANNEL'S AUTHORITY IS ASKED FIRST, AND REPLAY VISIBILITY ONLY EVER
 *    NARROWS WHAT SURVIVES IT. A `public` replay on a channel the platform does
 *    not publish is not public. Channel visibility (`public`/`private`/`locked`)
 *    and replay visibility (`public`/`unlisted`/`private`) are different
 *    vocabularies about different things -- a door and a stored object -- and
 *    the only place they meet is the single boolean this file derives.
 *
 * 3. A PUBLIC ANSWER'S SHAPE NEVER DEPENDS ON SOMETHING HIDDEN. Two channels
 *    that do not publish history -- one because it does not exist, one because
 *    its operator made it private -- get the same 404 with the same sentence,
 *    because a different answer for each is an existence oracle. Within a
 *    listing, `audience.ts` holds the same line for individual recordings.
 *
 * 4. POLICY IS RESOLVED BY `resolveReplayPolicy`, HERE, ONCE. The console shows
 *    what an override will actually do, and that preview is computed by the
 *    same function the media service will use when the programme opens -- not
 *    re-implemented in a component where it would drift into telling operators
 *    something that is not going to happen.
 *
 * THE PATHS FOLLOW THIS SERVICE'S EXISTING SPLIT. An operator's own channel is
 * `/channels/mine/...`, as `channel-routes.ts` has it. A programme an operator
 * administers is `/operator/programmes/:programmeId/...`, as vocabulary and the
 * sponsored creative have it, and the bare `/programmes/...` and
 * `/channels/:channelId/...` prefixes stay public. Two prefixes that differ by
 * one word are not decoration: they are the reason a reviewer can tell at a
 * glance whether a handler needs a session.
 *
 * AND NOTHING HERE EMITS A LOCATION. Not a storage reference, not an archive
 * root, not an object key. The catalogue does not hold one (see `airing.ts`),
 * the audience views cannot express one (see `audience.ts`), and playback is
 * addressed by run id, which the media service authorises for itself.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type express from 'express';
import {
  MAX_AIRING_PAGE,
  pageSize,
  toOwnerView,
  toPublicByLink,
  toPublicListing,
  type AiringCursor,
  type AiringQuery,
  type ProgrammeAiringCatalogue,
  type ProgrammeAiringPage,
  type PublicAiringView,
} from '@videofy-live/programme-replay';
import {
  MAX_REPLAY_DURATION_DAYS,
  overrideIsEmpty,
  resolveReplayPolicy,
  validateChannelReplaySettings,
  validateProgrammeReplayOverride,
  type ChannelReplaySettings,
  type ChannelReplaySettingsStore,
  type ProgrammeReplayOverride,
  type ProgrammeReplayOverrideStore,
  type ReplayPolicyResolution,
} from '@videofy-live/programme-replay-policy';
import type { ChannelVisibility } from '@videofy-live/shared-types';

type OverridePolicy = NonNullable<ProgrammeReplayOverride['policy']>;
type OverrideVisibility = NonNullable<ProgrammeReplayOverride['visibility']>;

export interface ReplayRouteCaller {
  readonly accountId: string;
}

/** The little the routes need to know about a channel. */
export interface ReplayRouteChannel {
  readonly channelId: string;
  readonly visibility: ChannelVisibility;
}

export interface ReplayRouteDependencies {
  readonly settings: ChannelReplaySettingsStore;
  readonly overrides: ProgrammeReplayOverrideStore;
  readonly airings: ProgrammeAiringCatalogue;
  /** The existing operator identity. No new account auth system. */
  readonly callerAccountId: (req: express.Request) => ReplayRouteCaller | null;
  /** This caller's own channel, by session. Never by an id they supplied. */
  readonly ownChannel: (accountId: string) => Promise<ReplayRouteChannel | null>;
  /** A channel by opaque id. Existence only; publishing is decided here. */
  readonly channelById: (channelId: string) => Promise<ReplayRouteChannel | null>;
  /** The same, by @handle, so the canonical stream page can ask. */
  readonly channelByHandle: (handle: string) => Promise<ReplayRouteChannel | null>;
  /**
   * May this caller administer this programme?
   *
   * Supplied by the host so authority stays where the platform already keeps
   * it. A route that decided this for itself would be a second answer to a
   * question already answered once.
   */
  readonly mayAdminister: (accountId: string, programmeId: string) => Promise<boolean>;
  /**
   * The key the PUBLIC page cursor is sealed with.
   *
   * A KEY RATHER THAN A SIGNATURE, and the difference is the whole point. A
   * signed cursor is still readable, and what it reads out is the run id of the
   * last airing on the page -- which is the address of that recording. Sealed,
   * a cursor is a token the server can open and nobody else can.
   *
   * The host passes the service secret; this derives its own key from it so a
   * cursor is never interchangeable with a session token.
   */
  readonly cursorSecret: Buffer;
  /** Taken as a parameter so expiry and resolution are testable. */
  readonly now?: () => number;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

/**
 * Whether the platform publishes this channel.
 *
 * THE ONLY PLACE THE TWO VOCABULARIES MEET. `private` is a bearer link and
 * `locked` additionally wants a code; neither is something to put in a listing
 * anybody can browse, so both collapse to "not published" and Replay
 * visibility never gets a chance to widen them. Written as an exhaustive
 * switch so a fourth channel tier added later is a compile error here rather
 * than a channel that quietly starts publishing its history.
 */
export function channelIsPublished(visibility: ChannelVisibility): boolean {
  switch (visibility) {
    case 'public':
      return true;
    case 'private':
    case 'locked':
      return false;
    default: {
      const unreachable: never = visibility;
      return unreachable;
    }
  }
}

/**
 * Express 4 does not catch a rejected async handler; the failure becomes an
 * unhandled rejection and takes the process with it. Every handler rides
 * through this so a storage fault is a 500 with a sentence, never an outage.
 */
function guarded(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): (req: express.Request, res: express.Response) => void {
  return (req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'That could not be completed. Try again.' });
      }
    });
  };
}

/**
 * ONE ANSWER FOR "NO SUCH CHANNEL" AND "THAT CHANNEL DOES NOT PUBLISH".
 *
 * Two sentences here would be an existence oracle: anybody could walk a list of
 * ids and learn which are real private channels, which is precisely the fact a
 * private channel is keeping. The wording is deliberately the same as the one
 * `channel-routes.ts` gives for a missing channel.
 */
function noSuchChannel(res: express.Response): void {
  res.status(404).json({ error: 'No such channel.' });
}

/* --------------------------------------------------------------- the query */

/**
 * A page request out of a query string, or the sentence saying why not.
 *
 * STRICT, AND NOT LENIENT-WITH-A-FALLBACK. `?limit=abc` is a caller mistake and
 * says so; silently substituting a page size would answer a question nobody
 * asked. The cursor is all-or-nothing for the same reason: half a cursor is not
 * "start from the beginning", it is a client bug that would otherwise show a
 * reader page one forever while they pressed Next.
 */
export function readAiringQuery(query: express.Request['query']): { value: AiringQuery } | { error: string } {
  const raw = (name: string): string | undefined => {
    const value = query[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const result: { limit?: number; after?: AiringCursor } = {};

  const limit = raw('limit');
  if (limit !== undefined) {
    const parsed = Number(limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_AIRING_PAGE) {
      return { error: `limit must be a whole number between 1 and ${MAX_AIRING_PAGE}.` };
    }
    result.limit = parsed;
  }

  const afterStartedAtMs = raw('afterStartedAtMs');
  const afterRunId = raw('afterRunId');
  if ((afterStartedAtMs === undefined) !== (afterRunId === undefined)) {
    return {
      error: 'A page cursor needs both afterStartedAtMs and afterRunId, or neither.',
    };
  }
  if (afterStartedAtMs !== undefined && afterRunId !== undefined) {
    const startedAtMs = Number(afterStartedAtMs);
    if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) {
      return { error: 'afterStartedAtMs must be a whole number of milliseconds.' };
    }
    result.after = { startedAtMs, runId: afterRunId };
  }

  // Never present-and-undefined: `exactOptionalPropertyTypes` is on, and an
  // explicit undefined would reach `pageSize` as a stated absence of a limit.
  return { value: result };
}

/**
 * A PUBLIC page request: a limit, and one opaque `after` token.
 *
 * DELIBERATELY NOT `afterStartedAtMs`/`afterRunId`, which is what the owner
 * routes take. Those two fields ARE a run id, and a public caller must not be
 * able to state one or read one back.
 */
export function readPublicAiringQuery(
  secret: Buffer,
  query: express.Request['query'],
): { value: AiringQuery } | { error: string } {
  const limitOnly = readAiringQuery({ ...query, afterStartedAtMs: undefined, afterRunId: undefined });
  if ('error' in limitOnly) return limitOnly;

  const after = query['after'];
  if (after === undefined) return limitOnly;
  if (typeof after !== 'string' || after === '') {
    return { error: 'after must be the page token from a previous response.' };
  }
  const opened = unsealCursor(secret, after);
  if (opened === null) {
    /*
     * REFUSED, NEVER RESTARTED. Falling back to the first page would page a
     * reader in a circle for ever while they pressed Next -- and would hide a
     * client bug behind an answer that looks like data.
     */
    return { error: 'That page token is not usable. Start from the first page.' };
  }
  return { value: { ...limitOnly.value, after: opened } };
}

/** The OWNER's page cursor, in the clear. They may see their own run ids. */
function ownerNextOf(page: ProgrammeAiringPage): { startedAtMs: number; runId: string } | null {
  return page.next === null ? null : { startedAtMs: page.next.startedAtMs, runId: page.next.runId };
}

/* ------------------------------------------------- the sealed public cursor */

/**
 * Why the public cursor is ENCRYPTED and not merely signed.
 *
 * Keyset pagination needs a tiebreaker the database can compare, and that
 * tiebreaker is the run id. So the cursor names the last airing on the page --
 * and a cursor a client can read is the address of that airing, handed out by
 * the very listing that decided not to show it. Page with `limit=1` and the
 * cursors alone enumerate every run id on the channel, in order.
 *
 * Base64 is not secrecy and a signature is not secrecy. AES-GCM is: the server
 * can open the token, the holder cannot, and a tampered one fails the tag
 * rather than decoding into some other channel's page.
 *
 * THE KEY IS DERIVED, not the service secret itself, so a cursor is never
 * interchangeable with a session token even if one is pasted where the other
 * is expected.
 */
function cursorKey(secret: Buffer): Buffer {
  return createHash('sha256').update(secret).update('videofy:replay-airing-cursor:v1').digest();
}

export function sealCursor(secret: Buffer, cursor: AiringCursor): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cursorKey(secret), iv);
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify([cursor.startedAtMs, cursor.runId]), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

/**
 * The cursor a client handed back, or null when it is not one of ours.
 *
 * NULL RATHER THAN A THROW, and the caller answers 400. A cursor that has been
 * edited, truncated, or minted against another deployment is a client error,
 * not a server fault -- and it must never fall back to "start from the
 * beginning", which would page a reader in a circle for ever.
 */
export function unsealCursor(secret: Buffer, token: string): AiringCursor | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    // 12 iv + 16 tag + at least one byte of payload.
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const opened = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
    const parsed: unknown = JSON.parse(opened);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [startedAtMs, runId] = parsed as [unknown, unknown];
    if (typeof startedAtMs !== 'number' || !Number.isSafeInteger(startedAtMs)) return null;
    if (typeof runId !== 'string' || runId === '') return null;
    return { startedAtMs, runId };
  } catch {
    // A failed tag, a truncated token, a body that is not our JSON.
    return null;
  }
}

/* --------------------------------------------------------- the public body */

/**
 * Where a recording is watched.
 *
 * A PATH, NOT AN ORIGIN. The media service owns this shape and authorises the
 * request when it arrives; the account service has no business knowing which
 * host serves it, and a page that is served relative today keeps working when
 * that answer changes.
 */
export function replayWatchPath(runId: string): string {
  return `/replays/${encodeURIComponent(runId)}/playlist.m3u8`;
}

interface PublicAiringBody {
  readonly channelId: string;
  readonly programmeId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly replay: { readonly watchUrl: string; readonly expiresAtMs: number | null } | null;
}

/**
 * The airing on the wire.
 *
 * THE RUN ID SURVIVES ONLY INSIDE A WATCH URL, and only for a recording this
 * audience may already watch -- where it is the capability rather than a
 * disclosure. Everywhere else it is gone before the serialiser sees it, which
 * is what stops a listing from handing out the address of the recordings it
 * has just hidden.
 */
function toPublicBody(view: PublicAiringView): PublicAiringBody {
  return {
    channelId: view.channelId,
    programmeId: view.programmeId,
    startedAtMs: view.startedAtMs,
    endedAtMs: view.endedAtMs,
    replay:
      view.replay === null
        ? null
        : { watchUrl: replayWatchPath(view.replay.runId), expiresAtMs: view.replay.expiresAtMs },
  };
}

/* ------------------------------------------------------------- the bodies */

/** Channel settings out of a PUT body, or the sentence saying why not. */
export function readChannelSettings(
  channelId: string,
  body: unknown,
): { value: ChannelReplaySettings } | { error: string } {
  const sent = (body ?? {}) as Record<string, unknown>;
  const durationDays = sent['defaultDurationDays'];
  if (durationDays !== undefined && durationDays !== null && typeof durationDays !== 'number') {
    return { error: 'defaultDurationDays must be a whole number of days, or null.' };
  }
  const allowOverrides = sent['allowOverrides'];
  if (allowOverrides !== undefined && typeof allowOverrides !== 'boolean') {
    return { error: 'allowOverrides is true or false.' };
  }

  const settings: ChannelReplaySettings = {
    /*
     * THE CHANNEL COMES FROM THE SESSION, NOT THE BODY. A channelId in a
     * payload is a value the caller chose; this one is the channel their
     * session actually owns. Any channelId sent in the body is ignored rather
     * than compared, because a comparison invites somebody to relax it later.
     */
    channelId,
    defaultPolicy: sent['defaultPolicy'] as ChannelReplaySettings['defaultPolicy'],
    defaultDurationDays: durationDays === undefined ? null : (durationDays as number | null),
    defaultVisibility: sent['defaultVisibility'] as ChannelReplaySettings['defaultVisibility'],
    // Defaulting to true here is not a retention default: it is the ABSENCE of
    // a restriction, which is the state a channel is in before anybody sets one.
    allowOverrides: allowOverrides === undefined ? true : allowOverrides,
  };

  const problem = validateChannelReplaySettings(settings);
  return problem === null ? { value: settings } : { error: problem };
}

/**
 * An override out of a PUT body, or the sentence saying why not.
 *
 * ABSENT AND NULL ARE DIFFERENT ANSWERS FOR `durationDays`, and this is where
 * the distinction enters the system. Omitting the key means "say nothing about
 * duration, inherit the channel's"; sending `null` means "there is deliberately
 * no duration". They resolve differently and they are stored differently.
 */
export function readOverride(body: unknown): { value: ProgrammeReplayOverride } | { error: string } {
  const sent = (body ?? {}) as Record<string, unknown>;
  const durationDays = sent['durationDays'];
  if (durationDays !== undefined && durationDays !== null && typeof durationDays !== 'number') {
    return { error: 'durationDays must be a whole number of days, or null.' };
  }

  /*
   * ASSEMBLED BY ASSIGNMENT, not by spreading conditionals. Under
   * `exactOptionalPropertyTypes` a spread of `{}` widens the property to
   * `T | undefined`, and the compiler stops being able to tell "absent" from
   * "present and undefined" -- which is the one distinction this body carries.
   */
  const draft: {
    policy?: OverridePolicy;
    durationDays?: number | null;
    visibility?: OverrideVisibility;
  } = {};
  if (sent['policy'] !== undefined) draft.policy = sent['policy'] as OverridePolicy;
  if (sent['visibility'] !== undefined) draft.visibility = sent['visibility'] as OverrideVisibility;
  if (durationDays !== undefined) draft.durationDays = durationDays as number | null;
  const override: ProgrammeReplayOverride = draft;

  const problem = validateProgrammeReplayOverride(override);
  return problem === null ? { value: override } : { error: problem };
}

/** The resolution, as JSON, whether it succeeded or not. */
function toResolutionBody(resolution: ReplayPolicyResolution): Record<string, unknown> {
  return resolution.ok
    ? { ok: true, resolved: resolution.value }
    : { ok: false, refusal: resolution.refusal, detail: resolution.detail };
}

/* --------------------------------------------------------------- the routes */

export function registerReplayRoutes(app: express.Express, deps: ReplayRouteDependencies): void {
  const now = deps.now ?? ((): number => Date.now());

  const signedIn = (req: express.Request, res: express.Response): ReplayRouteCaller | null => {
    const caller = deps.callerAccountId(req);
    if (caller === null) res.status(401).json({ error: 'Sign in to continue.' });
    return caller;
  };

  /** The caller's own channel, or the refusal already written. */
  const ownChannel = async (
    req: express.Request,
    res: express.Response,
  ): Promise<ReplayRouteChannel | null> => {
    const caller = signedIn(req, res);
    if (caller === null) return null;
    const channel = await deps.ownChannel(caller.accountId);
    if (channel === null) {
      res.status(404).json({ error: 'You do not have a channel yet.' });
      return null;
    }
    return channel;
  };

  /* ------------------------------------------------------ the channel's defaults */

  app.get('/channels/mine/replay-settings', guarded(async (req, res) => {
    const channel = await ownChannel(req, res);
    if (channel === null) return;
    const settings = await deps.settings.read(channel.channelId);
    res.status(200).json({
      /*
       * NULL IS AN ANSWER, and the console must show it as one. "This channel
       * has not decided" is not "this channel keeps nothing", and a response
       * that invented an empty settings object here would have made the
       * decision on the operator's behalf, silently, in a JSON serialiser.
       */
      settings,
      /* So the form can bound its own input without inventing the number. */
      maxDurationDays: MAX_REPLAY_DURATION_DAYS,
      channelPublished: channelIsPublished(channel.visibility),
    });
  }));

  app.put('/channels/mine/replay-settings', guarded(async (req, res) => {
    const channel = await ownChannel(req, res);
    if (channel === null) return;
    const read = readChannelSettings(channel.channelId, req.body);
    if ('error' in read) {
      res.status(400).json({ error: read.error });
      return;
    }
    const saved = await deps.settings.save(read.value);
    if (!saved.ok || saved.value === undefined) {
      res
        .status(saved.refusal === 'invalid-settings' ? 400 : 503)
        .json({ error: saved.detail ?? 'Those replay settings could not be stored.' });
      return;
    }
    deps.onEvent?.('channel.replay.settings.updated', {
      policy: saved.value.defaultPolicy,
      visibility: saved.value.defaultVisibility,
      overrides: String(saved.value.allowOverrides),
    });
    res.status(200).json({
      settings: saved.value,
      maxDurationDays: MAX_REPLAY_DURATION_DAYS,
      channelPublished: channelIsPublished(channel.visibility),
    });
  }));

  /* ---------------------------------------------- the programme's departure */

  /**
   * The programme's authority, and the channel it belongs to.
   *
   * `mayAdminister` IS THE PLATFORM'S ANSWER and this does not second-guess it.
   * What it adds is the channel the override belongs to, which is the channel
   * the caller administers -- the same relationship `mayAdminister` is checking.
   */
  const administered = async (
    req: express.Request,
    res: express.Response,
  ): Promise<{ programmeId: string; channel: ReplayRouteChannel } | null> => {
    const caller = signedIn(req, res);
    if (caller === null) return null;
    const programmeId = String(req.params['programmeId'] ?? '');
    if (programmeId === '') {
      res.status(400).json({ error: 'Name the programme.' });
      return null;
    }
    if (!(await deps.mayAdminister(caller.accountId, programmeId))) {
      // The same answer whether the programme is another operator's or does
      // not exist: "you may not" and "there is none" are not distinguished.
      res.status(404).json({ error: 'No such programme.' });
      return null;
    }
    const channel = await deps.ownChannel(caller.accountId);
    if (channel === null) {
      res.status(404).json({ error: 'You do not have a channel yet.' });
      return null;
    }
    return { programmeId, channel };
  };

  /** The override, and what it would actually do if the programme aired now. */
  const overrideBody = async (
    programmeId: string,
    channelId: string,
    override: ProgrammeReplayOverride | null,
  ): Promise<Record<string, unknown>> => {
    const settings = await deps.settings.read(channelId);
    return {
      programmeId,
      override,
      channelSettings: settings,
      /*
       * THE PREVIEW COMES FROM THE REAL RESOLVER. The console shows an operator
       * what their override will do, and computing that in a component would be
       * a second implementation of a rule with one home -- one that would drift
       * into promising something the media service is not going to do.
       */
      resolution: toResolutionBody(resolveReplayPolicy(settings, override, now())),
      maxDurationDays: MAX_REPLAY_DURATION_DAYS,
    };
  };

  app.get('/operator/programmes/:programmeId/replay-override', guarded(async (req, res) => {
    const authorised = await administered(req, res);
    if (authorised === null) return;
    const stored = await deps.overrides.read(authorised.programmeId);
    res
      .status(200)
      .json(
        await overrideBody(
          authorised.programmeId,
          authorised.channel.channelId,
          stored?.override ?? null,
        ),
      );
  }));

  app.put('/operator/programmes/:programmeId/replay-override', guarded(async (req, res) => {
    const authorised = await administered(req, res);
    if (authorised === null) return;
    const read = readOverride(req.body);
    if ('error' in read) {
      res.status(400).json({ error: read.error });
      return;
    }

    /*
     * AN EMPTY OVERRIDE IS A REMOVAL, not a stored row saying nothing. An
     * operator who clears every field has said "use the channel's answer", and
     * keeping an empty row would leave the programme looking overridden on
     * every screen that asks whether it is.
     */
    if (overrideIsEmpty(read.value)) {
      const cleared = await deps.overrides.clear(authorised.programmeId);
      if (!cleared.ok) {
        res.status(503).json({ error: cleared.detail ?? 'That could not be stored.' });
        return;
      }
      deps.onEvent?.('programme.replay.override.cleared', {});
      res
        .status(200)
        .json(await overrideBody(authorised.programmeId, authorised.channel.channelId, null));
      return;
    }

    /*
     * REFUSED NOW RATHER THAN AT BROADCAST TIME. An override that cannot
     * resolve -- because the channel forbids overrides, because the channel is
     * unconfigured, because the pair of policy and duration is incoherent -- is
     * a recording that will not happen, and the operator is standing here.
     * Telling them at the moment they press Save costs one query; telling them
     * afterwards costs a programme.
     *
     * `overrides-forbidden` IS THE AUTHORITY ANSWER, so it is a 409 rather than
     * a 400: nothing is wrong with what they sent, the channel does not permit
     * it. The console may also disable the control, but a disabled control is
     * never the authorisation -- this is.
     */
    const settings = await deps.settings.read(authorised.channel.channelId);
    const resolution = resolveReplayPolicy(settings, read.value, now());
    if (!resolution.ok) {
      res.status(resolution.refusal === 'overrides-forbidden' ? 409 : 400).json({
        error: resolution.detail,
        refusal: resolution.refusal,
      });
      return;
    }

    const saved = await deps.overrides.save({
      programmeId: authorised.programmeId,
      channelId: authorised.channel.channelId,
      override: read.value,
    });
    if (!saved.ok || saved.value === undefined) {
      res
        .status(saved.refusal === 'invalid-settings' ? 400 : 503)
        .json({ error: saved.detail ?? 'That override could not be stored.' });
      return;
    }
    deps.onEvent?.('programme.replay.override.updated', {
      policy: saved.value.override.policy ?? 'inherited',
      visibility: saved.value.override.visibility ?? 'inherited',
    });
    res
      .status(200)
      .json(
        await overrideBody(
          authorised.programmeId,
          authorised.channel.channelId,
          saved.value.override,
        ),
      );
  }));

  app.delete('/operator/programmes/:programmeId/replay-override', guarded(async (req, res) => {
    const authorised = await administered(req, res);
    if (authorised === null) return;
    const cleared = await deps.overrides.clear(authorised.programmeId);
    if (!cleared.ok) {
      res.status(503).json({ error: cleared.detail ?? 'That could not be removed.' });
      return;
    }
    deps.onEvent?.('programme.replay.override.cleared', {});
    res
      .status(200)
      .json(await overrideBody(authorised.programmeId, authorised.channel.channelId, null));
  }));

  /* ------------------------------------------------------- the owner's history */

  app.get('/channels/mine/airings', guarded(async (req, res) => {
    const channel = await ownChannel(req, res);
    if (channel === null) return;
    const query = readAiringQuery(req.query);
    if ('error' in query) {
      res.status(400).json({ error: query.error });
      return;
    }
    const page = await deps.airings.listByChannel(channel.channelId, query.value);
    const at = now();
    const published = channelIsPublished(channel.visibility);
    res.status(200).json({
      airings: page.airings.map((record) => toOwnerView(record, published, at)),
      next: ownerNextOf(page),
      pageSize: pageSize(query.value),
      channelPublished: published,
    });
  }));

  app.get('/operator/programmes/:programmeId/airings', guarded(async (req, res) => {
    const authorised = await administered(req, res);
    if (authorised === null) return;
    const query = readAiringQuery(req.query);
    if ('error' in query) {
      res.status(400).json({ error: query.error });
      return;
    }
    const page = await deps.airings.listByProgramme(authorised.programmeId, query.value);
    const at = now();
    const published = channelIsPublished(authorised.channel.visibility);
    res.status(200).json({
      airings: page.airings.map((record) => toOwnerView(record, published, at)),
      next: ownerNextOf(page),
      pageSize: pageSize(query.value),
      channelPublished: published,
    });
  }));

  /* ------------------------------------------------------------ the audience */

  /**
   * A channel anybody may read the history of, or the 404 already written.
   *
   * ONE ANSWER FOR BOTH REFUSALS. A channel that does not exist and a channel
   * whose operator does not publish it are indistinguishable from out here, by
   * construction rather than by care.
   */
  const publishedChannel = async (
    res: express.Response,
    lookup: Promise<ReplayRouteChannel | null>,
  ): Promise<ReplayRouteChannel | null> => {
    const channel = await lookup;
    if (channel === null || !channelIsPublished(channel.visibility)) {
      noSuchChannel(res);
      return null;
    }
    return channel;
  };

  const publicListing = async (
    req: express.Request,
    res: express.Response,
    lookup: Promise<ReplayRouteChannel | null>,
  ): Promise<void> => {
    const channel = await publishedChannel(res, lookup);
    if (channel === null) return;
    const query = readPublicAiringQuery(deps.cursorSecret, req.query);
    if ('error' in query) {
      res.status(400).json({ error: query.error });
      return;
    }
    const page = await deps.airings.listByChannel(channel.channelId, query.value);
    const at = now();
    res.status(200).json({
      channelId: channel.channelId,
      /*
       * `true` here, ALWAYS, and not the channel's own flag: this endpoint only
       * answers for published channels, so the argument is a constant. Passing
       * a variable would suggest there is a path through here where it is
       * false, and somebody would eventually find one.
       */
      airings: page.airings.map((record) => toPublicBody(toPublicListing(record, true, at))),
      /*
       * SEALED. The cursor names the last airing on the page, and that name is
       * the run id -- the address of a recording this listing may have just
       * declined to show. Handed back opaque, it is a token; handed back in the
       * clear it is an enumeration of the channel at limit=1.
       */
      next: page.next === null ? null : sealCursor(deps.cursorSecret, page.next),
      pageSize: pageSize(query.value),
    });
  };

  app.get('/channels/:channelId/airings', guarded(async (req, res) => {
    const channelId = String(req.params['channelId'] ?? '');
    await publicListing(req, res, deps.channelById(channelId));
  }));

  /** The canonical stream page's history, by @handle. */
  app.get('/streams/:handle/airings', guarded(async (req, res) => {
    const handle = String(req.params['handle'] ?? '');
    await publicListing(req, res, deps.channelByHandle(handle));
  }));

  /**
   * One airing, fetched by somebody who already has its address.
   *
   * WHERE `unlisted` EARNS ITS NAME. A recording withheld from every listing is
   * served here, because "known link" is exactly what the tier means. A
   * `private` one is still refused, because private is authorisation rather
   * than obscurity, and it is refused by returning the SAME shape a
   * never-recorded airing gets -- not by a different status code, which would
   * be the existence oracle in miniature.
   */
  app.get('/channels/:channelId/airings/:runId', guarded(async (req, res) => {
    const channelId = String(req.params['channelId'] ?? '');
    const runId = String(req.params['runId'] ?? '');
    const channel = await publishedChannel(res, deps.channelById(channelId));
    if (channel === null) return;
    const record = await deps.airings.findByRunId(runId);
    /*
     * THE RUN MUST BELONG TO THE CHANNEL IN THE PATH. Without this a public
     * channel's id would be a key that unlocks any run in the catalogue,
     * including a private channel's -- the exact cross-tenant read that the
     * channel check above is for.
     */
    if (record === null || record.identity.channelId !== channel.channelId) {
      res.status(404).json({ error: 'No such broadcast.' });
      return;
    }
    res.status(200).json({ airing: toPublicBody(toPublicByLink(record, true, now())) });
  }));
}
