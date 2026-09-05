/** @author masterzee001 */
/**
 * What the Replay controls SAY, and how a form becomes a request.
 *
 * WHAT IS DELIBERATELY NOT HERE: the retention rules. Whether `keep` may carry
 * a duration, whether a programme may differ from its channel at all, what an
 * override actually resolves to -- every one of those is decided by
 * `resolveReplayPolicy` in the account service, and the console shows the
 * answer it is given rather than working one out. A second implementation in a
 * component is not a convenience; it is a promise to an operator that the
 * service is under no obligation to keep, and the day the two disagree the
 * console is the one that lies.
 *
 * So what lives here is FORM SHAPING and WORDS. Which control is on screen,
 * which keys a payload carries, and the sentences that describe each choice --
 * written once, in one file, because the difference between the three replay
 * tiers is the thing people get wrong and it should read identically wherever
 * it appears.
 *
 * AND THE TIERS ARE NOT THE CHANNEL'S TIERS. A channel is public, private or
 * LOCKED; a replay is public, UNLISTED or private. They are different words for
 * different things -- a door and a stored object -- and the copy below says so
 * out loud, because an operator who reads "private" on two pages and assumes it
 * means one thing will eventually be surprised by the one it does not.
 */

/* ------------------------------------------------------------ the vocabulary */

export type ReplayPolicy = 'keep' | 'expire' | 'none';
export type ReplayVisibility = 'public' | 'unlisted' | 'private';

/** What a programme control may say when it is not overriding anything. */
export const INHERIT = 'inherit';
export type Inherited<T extends string> = T | typeof INHERIT;

export const REPLAY_POLICIES: readonly ReplayPolicy[] = ['keep', 'expire', 'none'];
export const REPLAY_VISIBILITIES: readonly ReplayVisibility[] = ['public', 'unlisted', 'private'];

export const POLICY_LABELS: Readonly<Record<ReplayPolicy, string>> = {
  keep: 'Keep indefinitely',
  expire: 'Keep for a set time',
  none: 'Do not record',
};

export const POLICY_DESCRIPTIONS: Readonly<Record<ReplayPolicy, string>> = {
  keep: 'Every broadcast is recorded and stays available until you remove it.',
  expire: 'Every broadcast is recorded and released automatically after the time you set.',
  none: 'Nothing is recorded. The broadcast still appears in your history — it happened — but there is no replay to watch.',
};

/**
 * The REPLAY tiers, in the words an operator needs.
 *
 * `unlisted` IS THE ONE WORTH SPELLING OUT. It is not "hidden": anybody holding
 * the link watches it, and it is simply absent from the lists people browse.
 * An operator who reads it as "nobody can see this" has chosen the wrong tier,
 * and `private` is the one they wanted.
 */
export const VISIBILITY_LABELS: Readonly<Record<ReplayVisibility, string>> = {
  public: 'Public',
  unlisted: 'Unlisted · Link-only',
  private: 'Private',
};

export const VISIBILITY_DESCRIPTIONS: Readonly<Record<ReplayVisibility, string>> = {
  public: 'Listed on your channel page. Anyone can find and watch it.',
  unlisted: 'Not listed anywhere. Anyone you give the link to can watch it — the link is the only thing needed.',
  private: 'Not listed, and the link is not enough. Nobody but you can watch it.',
};

/**
 * Said next to the visibility control, once.
 *
 * The two settings are on different pages, they use two of the same three
 * words, and only one of them decides whether anybody reaches the channel at
 * all. Stating the relationship is cheaper than an operator discovering it.
 */
export const VISIBILITY_CAVEAT =
  'These are replay settings, and they are separate from who can reach the channel. ' +
  'A public replay on a channel that is not public is still not listed to anybody.';

/* -------------------------------------------------------- the channel's form */

export interface ChannelReplayDraft {
  readonly policy: ReplayPolicy;
  /** Meaningful only while the policy is `expire`; the form owns the box. */
  readonly durationDays: number | null;
  readonly visibility: ReplayVisibility;
  readonly allowOverrides: boolean;
}

export interface ChannelReplaySettingsDto {
  readonly channelId: string;
  readonly defaultPolicy: ReplayPolicy;
  readonly defaultDurationDays: number | null;
  readonly defaultVisibility: ReplayVisibility;
  readonly allowOverrides: boolean;
}

/**
 * The form's starting state.
 *
 * A CHANNEL THAT HAS DECIDED NOTHING GETS AN UNSUBMITTED FORM, not a default.
 * The controls have to start somewhere, and `keep`/`unlisted` is the least
 * surprising place for a cursor to be -- but nothing is saved until the
 * operator presses the button, and `settingsAreUnset` is what the panel uses to
 * say so on screen. A form position is not a decision.
 */
export function draftFromSettings(settings: ChannelReplaySettingsDto | null): ChannelReplayDraft {
  if (settings === null) {
    return { policy: 'keep', durationDays: null, visibility: 'unlisted', allowOverrides: true };
  }
  return {
    policy: settings.defaultPolicy,
    durationDays: settings.defaultDurationDays,
    visibility: settings.defaultVisibility,
    allowOverrides: settings.allowOverrides,
  };
}

/**
 * The form as a request body.
 *
 * The duration rides only with `expire`, which is FORM SHAPING and not the
 * rule: the box is on screen for exactly that choice, and a number left behind
 * by a policy the operator moved away from is not something they asked for. The
 * rule itself is the service's, and a body that violates it is refused there --
 * see the test that sends one deliberately.
 */
export function channelSettingsPayload(draft: ChannelReplayDraft): Record<string, unknown> {
  return {
    defaultPolicy: draft.policy,
    defaultDurationDays: draft.policy === 'expire' ? draft.durationDays : null,
    defaultVisibility: draft.visibility,
    allowOverrides: draft.allowOverrides,
  };
}

/** Whether the form can be submitted at all, in the words the operator needs. */
export function channelDraftProblem(draft: ChannelReplayDraft, maxDurationDays: number): string | null {
  if (draft.policy !== 'expire') return null;
  const days = draft.durationDays;
  if (days === null) return 'Say how long recordings should be kept.';
  if (!Number.isInteger(days) || days < 1) return 'Use a whole number of days, one or more.';
  if (days > maxDurationDays) {
    return `The longest you can set is ${maxDurationDays} days. Use “Keep indefinitely” instead.`;
  }
  return null;
}

/* ------------------------------------------------------ the programme's form */

export interface ProgrammeOverrideDraft {
  readonly policy: Inherited<ReplayPolicy>;
  readonly durationDays: number | null;
  readonly visibility: Inherited<ReplayVisibility>;
}

export interface ProgrammeReplayOverrideDto {
  readonly policy?: ReplayPolicy;
  readonly durationDays?: number | null;
  readonly visibility?: ReplayVisibility;
}

export const NO_OVERRIDE: ProgrammeOverrideDraft = {
  policy: INHERIT,
  durationDays: null,
  visibility: INHERIT,
};

export function overrideDraftFrom(stored: ProgrammeReplayOverrideDto | null): ProgrammeOverrideDraft {
  if (stored === null) return NO_OVERRIDE;
  return {
    policy: stored.policy ?? INHERIT,
    durationDays: stored.durationDays ?? null,
    visibility: stored.visibility ?? INHERIT,
  };
}

/**
 * The override as a request body.
 *
 * `inherit` BECOMES AN ABSENT KEY, which is what the API reads as "say nothing
 * about this, use the channel's". It is never sent as a literal, and never as
 * an explicit null: for the duration those two are DIFFERENT ANSWERS on the
 * wire -- absent inherits the channel's days, null says there is deliberately
 * no duration and is refused alongside `expire` -- and the console has no
 * control that means the second one. Keeping it unreachable from here is the
 * point; the API still accepts it from callers that mean it.
 */
export function overridePayload(draft: ProgrammeOverrideDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (draft.policy !== INHERIT) body['policy'] = draft.policy;
  if (draft.visibility !== INHERIT) body['visibility'] = draft.visibility;
  // Only alongside an explicit `expire`, and only as a number. See above.
  if (draft.policy === 'expire' && draft.durationDays !== null) {
    body['durationDays'] = draft.durationDays;
  }
  return body;
}

/** Whether this programme departs from its channel at all. */
export function overrideIsEmpty(draft: ProgrammeOverrideDraft): boolean {
  return Object.keys(overridePayload(draft)).length === 0;
}

/* ------------------------------------------------------------ what it means */

export interface ResolvedReplayDto {
  readonly retention: { readonly policy: ReplayPolicy; readonly expiresAtMs?: number };
  readonly visibility: ReplayVisibility;
  readonly retentionSource: 'channel-default' | 'programme-override';
  readonly visibilitySource: 'channel-default' | 'programme-override';
}

export type ResolutionDto =
  | { readonly ok: true; readonly resolved: ResolvedReplayDto }
  | { readonly ok: false; readonly refusal: string; readonly detail: string };

/**
 * The resolution, in a sentence.
 *
 * READ FROM THE SERVICE'S ANSWER, never recomputed. The expiry below is the
 * instant the service produced for a broadcast starting now, and the number of
 * days is derived from it rather than from the form -- so if the two ever
 * disagree, the screen shows what is actually going to happen.
 */
export function describeResolution(
  resolution: ResolutionDto,
  startedAtMs: number,
): string {
  if (!resolution.ok) return resolution.detail;
  const { retention, visibility } = resolution.resolved;
  const audience = VISIBILITY_LABELS[visibility].toLowerCase();
  if (retention.policy === 'none') return 'Nothing will be recorded for this programme.';
  if (retention.policy === 'keep') {
    return `Recorded and kept indefinitely, ${audience}.`;
  }
  const expiresAtMs = retention.expiresAtMs;
  if (expiresAtMs === undefined) return `Recorded and kept for a set time, ${audience}.`;
  const days = Math.max(1, Math.round((expiresAtMs - startedAtMs) / 86_400_000));
  return `Recorded and kept for ${days} ${days === 1 ? 'day' : 'days'}, ${audience}.`;
}

/** Which of the two decided each half, so an operator can see the inheritance. */
export function describeSources(resolution: ResolutionDto): string | null {
  if (!resolution.ok) return null;
  const { retentionSource, visibilitySource } = resolution.resolved;
  if (retentionSource === 'channel-default' && visibilitySource === 'channel-default') {
    return 'Both from the channel default.';
  }
  if (retentionSource === 'programme-override' && visibilitySource === 'programme-override') {
    return 'Both set for this programme.';
  }
  return retentionSource === 'programme-override'
    ? 'Retention set for this programme; audience from the channel default.'
    : 'Audience set for this programme; retention from the channel default.';
}

/* ---------------------------------------------------------------- a history */

export interface OwnerReplayDto {
  readonly runId: string;
  readonly status: string;
  readonly visibility: ReplayVisibility;
  readonly expiresAtMs: number | null;
  readonly failure: { readonly reason: string; readonly summary: string } | null;
  readonly bytes: number;
  readonly segmentCount: number;
  readonly watchable: boolean;
  readonly listedPublicly: boolean;
}

export interface OwnerAiringDto {
  readonly runId: string;
  readonly channelId: string;
  readonly programmeId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly replay: OwnerReplayDto | null;
}

/**
 * What one history row says about its recording.
 *
 * "KEPT NOTHING" IS ITS OWN SENTENCE, and never dressed up as a failure. A
 * broadcast the operator chose not to record and a broadcast whose recording
 * broke are different things to have happened, and an operator looking at last
 * Tuesday is entitled to be told which.
 */
export function describeAiringReplay(airing: OwnerAiringDto): string {
  const replay = airing.replay;
  if (replay === null) return 'No recording was kept for this broadcast.';
  if (replay.failure !== null) return replay.failure.summary;
  switch (replay.status) {
    case 'available':
      return replay.watchable
        ? replay.listedPublicly
          ? 'Available, and listed on your channel page.'
          : 'Available by link only.'
        : 'The retention period for this recording has passed.';
    case 'recording':
      return 'Still recording.';
    case 'processing':
      return 'Finishing the recording.';
    case 'expired':
      return 'Released: the retention period has passed.';
    case 'deleted':
      return 'Removed.';
    case 'failed':
      return 'The recording failed.';
    default:
      return 'The state of this recording is not known.';
  }
}

/** Bytes, roughly, for a person. Never the exact figure nobody reads. */
export function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? 'kB'}`;
}

/**
 * Where a recording is watched.
 *
 * THE MEDIA SERVICE, NOT THE ACCOUNT SERVICE. History is metadata and lives in
 * one place; the bytes live in another and are authorised there. Composed from
 * a run id and the ingest origin the console already has -- never from anything
 * a response carried, because no response carries a location.
 */
export function replayPlaybackUrl(ingestUrl: string, runId: string): string {
  return `${ingestUrl.replace(/\/$/u, '')}/replays/${encodeURIComponent(runId)}/playlist.m3u8`;
}
