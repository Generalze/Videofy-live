/** @author masterzee001 */
/**
 * The console's Replay copy and form shaping.
 *
 * TWO PROPERTIES ARE WORTH THE FILE.
 *
 *   THE CONSOLE DOES NOT DECIDE RETENTION. Every sentence it shows about what
 *   will happen is read out of the service's own resolution, so a test that
 *   feeds it a resolution nobody would compute -- `keep` reported as coming
 *   from an override that says `none` -- still prints the service's answer.
 *   That is the point: if the console recomputed, it could not.
 *
 *   `inherit` IS AN ABSENT KEY, AND NEVER A NULL. On the wire, an absent
 *   duration inherits the channel's days and an explicit null is a refusal, so
 *   a payload builder that turned "leave it alone" into `null` would turn a
 *   working programme into a refused one.
 */
import { describe, expect, it } from 'vitest';
import {
  INHERIT,
  NO_OVERRIDE,
  POLICY_DESCRIPTIONS,
  REPLAY_POLICIES,
  REPLAY_VISIBILITIES,
  VISIBILITY_CAVEAT,
  VISIBILITY_DESCRIPTIONS,
  VISIBILITY_LABELS,
  channelDraftProblem,
  channelSettingsPayload,
  describeAiringReplay,
  describeResolution,
  describeSize,
  describeSources,
  draftFromSettings,
  overrideDraftFrom,
  overrideIsEmpty,
  overridePayload,
  replayPlaybackUrl,
  type ChannelReplayDraft,
  type OwnerAiringDto,
  type ProgrammeOverrideDraft,
} from './replayConsole';

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

/* ================================================================ the words */

describe('the replay tiers are not the channel tiers', () => {
  it('offers unlisted, and never locked', () => {
    expect(REPLAY_VISIBILITIES).toEqual(['public', 'unlisted', 'private']);
    expect(Object.keys(VISIBILITY_LABELS)).not.toContain('locked');
  });

  it('says what unlisted actually does, in the one place it is written', () => {
    /*
     * The tier people get wrong. "Hidden" is what they hear; "anybody with the
     * link" is what it does, and the copy has to say the second.
     */
    expect(VISIBILITY_DESCRIPTIONS.unlisted).toContain('link');
    expect(VISIBILITY_DESCRIPTIONS.unlisted).toContain('Not listed');
    expect(VISIBILITY_DESCRIPTIONS.private).toContain('Nobody but you');
  });

  it('warns that a replay setting does not decide who reaches the channel', () => {
    expect(VISIBILITY_CAVEAT).toContain('separate from who can reach the channel');
  });

  it('says that a programme kept nothing still appears in history', () => {
    expect(POLICY_DESCRIPTIONS.none).toContain('still appears in your history');
  });

  it('has a label and a description for every choice', () => {
    for (const policy of REPLAY_POLICIES) {
      expect(POLICY_DESCRIPTIONS[policy].length, policy).toBeGreaterThan(20);
    }
    for (const visibility of REPLAY_VISIBILITIES) {
      expect(VISIBILITY_DESCRIPTIONS[visibility].length, visibility).toBeGreaterThan(20);
    }
  });
});

/* ============================================================= the channel */

describe('the channel form', () => {
  it('starts unsubmitted for a channel that has decided nothing', () => {
    // A cursor position, not a decision: nothing is stored until Save.
    expect(draftFromSettings(null)).toEqual({
      policy: 'keep',
      durationDays: null,
      visibility: 'unlisted',
      allowOverrides: true,
    });
  });

  it('shows what is stored for a channel that has', () => {
    expect(
      draftFromSettings({
        channelId: 'ch',
        defaultPolicy: 'expire',
        defaultDurationDays: 30,
        defaultVisibility: 'public',
        allowOverrides: false,
      }),
    ).toEqual({ policy: 'expire', durationDays: 30, visibility: 'public', allowOverrides: false });
  });

  it('sends a duration only with expire', () => {
    const draft: ChannelReplayDraft = {
      policy: 'keep',
      durationDays: 30,
      visibility: 'public',
      allowOverrides: true,
    };
    // A number left behind by a policy the operator moved away from is not
    // something they asked for.
    expect(channelSettingsPayload(draft)['defaultDurationDays']).toBeNull();
    expect(channelSettingsPayload({ ...draft, policy: 'expire' })['defaultDurationDays']).toBe(30);
  });

  it('refuses to submit expire with nothing in the box', () => {
    const draft: ChannelReplayDraft = {
      policy: 'expire',
      durationDays: null,
      visibility: 'public',
      allowOverrides: true,
    };
    expect(channelDraftProblem(draft, 3650)).toContain('how long');
    expect(channelDraftProblem({ ...draft, durationDays: 0 }, 3650)).toContain('whole number');
    expect(channelDraftProblem({ ...draft, durationDays: 1.5 }, 3650)).toContain('whole number');
    expect(channelDraftProblem({ ...draft, durationDays: 3651 }, 3650)).toContain('3650');
    expect(channelDraftProblem({ ...draft, durationDays: 30 }, 3650)).toBeNull();
  });

  it('takes the bound from the service rather than inventing one', () => {
    const draft: ChannelReplayDraft = {
      policy: 'expire',
      durationDays: 400,
      visibility: 'public',
      allowOverrides: true,
    };
    expect(channelDraftProblem(draft, 3650)).toBeNull();
    expect(channelDraftProblem(draft, 90)).toContain('90');
  });

  it('has nothing to say about a policy that carries no duration', () => {
    for (const policy of ['keep', 'none'] as const) {
      expect(
        channelDraftProblem(
          { policy, durationDays: 30, visibility: 'public', allowOverrides: true },
          3650,
        ),
        policy,
      ).toBeNull();
    }
  });
});

/* =========================================================== the programme */

describe('an override says only what it says', () => {
  it('inherit is an absent key, never a literal and never a null', () => {
    /*
     * THE DISTINCTION THE WIRE CARES ABOUT. Absent inherits the channel's days;
     * an explicit null says there is deliberately no duration and is refused
     * alongside `expire`. A payload builder that confused them would turn a
     * working programme into a refused one.
     */
    const payload = overridePayload(NO_OVERRIDE);
    expect(payload).toEqual({});
    expect(JSON.stringify(payload)).not.toContain('null');
    expect(JSON.stringify(payload)).not.toContain(INHERIT);
  });

  it('never sends a null duration, whatever the form holds', () => {
    const drafts: ProgrammeOverrideDraft[] = [
      { policy: 'expire', durationDays: null, visibility: INHERIT },
      { policy: 'keep', durationDays: 30, visibility: INHERIT },
      { policy: INHERIT, durationDays: 30, visibility: 'public' },
      { policy: 'none', durationDays: null, visibility: 'private' },
    ];
    for (const draft of drafts) {
      const payload = overridePayload(draft);
      expect('durationDays' in payload ? payload['durationDays'] : 1, JSON.stringify(draft)).not.toBeNull();
    }
  });

  it('sends a duration only alongside an explicit expire', () => {
    expect(overridePayload({ policy: 'expire', durationDays: 7, visibility: INHERIT })).toEqual({
      policy: 'expire',
      durationDays: 7,
    });
    // Restating expire with an empty box means "the channel's days".
    expect(overridePayload({ policy: 'expire', durationDays: null, visibility: INHERIT })).toEqual({
      policy: 'expire',
    });
    // A duration with no policy would be a duration for a policy nobody stated.
    expect(overridePayload({ policy: INHERIT, durationDays: 7, visibility: INHERIT })).toEqual({});
  });

  it('sends a visibility on its own', () => {
    expect(overridePayload({ policy: INHERIT, durationDays: null, visibility: 'private' })).toEqual({
      visibility: 'private',
    });
  });

  it('reads a stored override back into the form', () => {
    expect(overrideDraftFrom({ policy: 'expire', durationDays: 7 })).toEqual({
      policy: 'expire',
      durationDays: 7,
      visibility: INHERIT,
    });
    expect(overrideDraftFrom(null)).toEqual(NO_OVERRIDE);
    expect(overrideDraftFrom({})).toEqual(NO_OVERRIDE);
  });

  it('round-trips: what came back, sent again, is the same statement', () => {
    for (const stored of [
      {},
      { policy: 'keep' as const },
      { visibility: 'public' as const },
      { policy: 'expire' as const, durationDays: 14 },
      { policy: 'none' as const, visibility: 'private' as const },
    ]) {
      expect(overridePayload(overrideDraftFrom(stored)), JSON.stringify(stored)).toEqual(stored);
    }
  });

  it('knows when a programme departs from its channel at all', () => {
    expect(overrideIsEmpty(NO_OVERRIDE)).toBe(true);
    expect(overrideIsEmpty({ policy: INHERIT, durationDays: 7, visibility: INHERIT })).toBe(true);
    expect(overrideIsEmpty({ policy: 'keep', durationDays: null, visibility: INHERIT })).toBe(false);
  });
});

/* ============================================================ the resolution */

describe('what will happen is read from the service, not worked out here', () => {
  it('prints the service answer even when it contradicts the override', () => {
    /*
     * THE PROOF THAT NOTHING IS RECOMPUTED. This resolution is one nothing
     * would produce: `keep`, attributed to a programme override. A console that
     * derived the sentence from the form would disagree with it. This one does
     * not, which is exactly why it can never tell an operator something the
     * service is not going to do.
     */
    expect(
      describeResolution(
        {
          ok: true,
          resolved: {
            retention: { policy: 'keep' },
            visibility: 'private',
            retentionSource: 'programme-override',
            visibilitySource: 'programme-override',
          },
        },
        NOW,
      ),
    ).toBe('Recorded and kept indefinitely, private.');
  });

  it('states the days from the instant the service produced', () => {
    expect(
      describeResolution(
        {
          ok: true,
          resolved: {
            retention: { policy: 'expire', expiresAtMs: NOW + 30 * DAY_MS },
            visibility: 'public',
            retentionSource: 'channel-default',
            visibilitySource: 'channel-default',
          },
        },
        NOW,
      ),
    ).toBe('Recorded and kept for 30 days, public.');
  });

  it('says one day in the singular', () => {
    expect(
      describeResolution(
        {
          ok: true,
          resolved: {
            retention: { policy: 'expire', expiresAtMs: NOW + DAY_MS },
            visibility: 'unlisted',
            retentionSource: 'channel-default',
            visibilitySource: 'channel-default',
          },
        },
        NOW,
      ),
    ).toContain('1 day,');
  });

  it('says nothing will be recorded, plainly', () => {
    expect(
      describeResolution(
        {
          ok: true,
          resolved: {
            retention: { policy: 'none' },
            visibility: 'private',
            retentionSource: 'programme-override',
            visibilitySource: 'channel-default',
          },
        },
        NOW,
      ),
    ).toBe('Nothing will be recorded for this programme.');
  });

  it('shows the service refusal verbatim rather than a sentence of its own', () => {
    // The service says why. Rewording it here would be a second explanation of
    // a decision made somewhere else.
    const detail = 'this channel does not permit per-programme replay overrides';
    expect(describeResolution({ ok: false, refusal: 'overrides-forbidden', detail }, NOW)).toBe(detail);
    expect(describeSources({ ok: false, refusal: 'overrides-forbidden', detail })).toBeNull();
  });

  it('says which of the two decided each half', () => {
    const resolved = {
      retention: { policy: 'keep' as const },
      visibility: 'public' as const,
      retentionSource: 'channel-default' as const,
      visibilitySource: 'channel-default' as const,
    };
    expect(describeSources({ ok: true, resolved })).toContain('channel default');
    expect(
      describeSources({
        ok: true,
        resolved: { ...resolved, retentionSource: 'programme-override', visibilitySource: 'programme-override' },
      }),
    ).toContain('Both set for this programme');
    expect(
      describeSources({ ok: true, resolved: { ...resolved, retentionSource: 'programme-override' } }),
    ).toContain('Retention set for this programme');
    expect(
      describeSources({ ok: true, resolved: { ...resolved, visibilitySource: 'programme-override' } }),
    ).toContain('Audience set for this programme');
  });
});

/* =============================================================== the history */

describe('a history row says what became of the recording', () => {
  const base: OwnerAiringDto = {
    runId: 'run_a',
    channelId: 'ch',
    programmeId: 'ch',
    startedAtMs: NOW,
    endedAtMs: NOW + 60_000,
    replay: null,
  };

  function withReplay(overrides: Partial<NonNullable<OwnerAiringDto['replay']>>): OwnerAiringDto {
    return {
      ...base,
      replay: {
        runId: 'run_a',
        status: 'available',
        visibility: 'public',
        expiresAtMs: null,
        failure: null,
        bytes: 1024,
        segmentCount: 2,
        watchable: true,
        listedPublicly: true,
        ...overrides,
      },
    };
  }

  it('never dresses "kept nothing" up as a failure', () => {
    /*
     * A broadcast the operator chose not to record and one whose recording
     * broke are different things to have happened.
     */
    expect(describeAiringReplay(base)).toBe('No recording was kept for this broadcast.');
    expect(describeAiringReplay(base)).not.toContain('fail');
  });

  it('says a failure in the words the service chose', () => {
    const summary = 'Programme media became unavailable before replay retention completed.';
    expect(
      describeAiringReplay(
        withReplay({ status: 'failed', failure: { reason: 'source-media-unavailable', summary } }),
      ),
    ).toBe(summary);
  });

  it('distinguishes listed from link-only', () => {
    expect(describeAiringReplay(withReplay({}))).toContain('listed on your channel page');
    expect(describeAiringReplay(withReplay({ listedPublicly: false }))).toBe(
      'Available by link only.',
    );
  });

  it('says the retention has passed for an available recording nobody may watch', () => {
    // The lifecycle worker has not swept it yet; the promise is still kept.
    expect(describeAiringReplay(withReplay({ watchable: false }))).toContain('retention period');
  });

  it('has a sentence for every lifecycle state', () => {
    for (const status of ['recording', 'processing', 'expired', 'deleted', 'failed'] as const) {
      const sentence = describeAiringReplay(withReplay({ status, watchable: false }));
      expect(sentence.length, status).toBeGreaterThan(5);
      expect(sentence, status).not.toContain('undefined');
    }
  });

  it('never leaks a path through a summary', () => {
    const airing = withReplay({
      status: 'failed',
      failure: { reason: 'source-media-unavailable', summary: 'Programme media became unavailable.' },
    });
    expect(describeAiringReplay(airing)).not.toContain('/');
  });
});

describe('the small things', () => {
  it('describes a size the way a person reads one', () => {
    expect(describeSize(512)).toBe('512 B');
    expect(describeSize(2048)).toBe('2.0 kB');
    expect(describeSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(describeSize(120 * 1024 * 1024)).toBe('120 MB');
    expect(describeSize(3 * 1024 ** 4)).toBe('3.0 TB');
  });

  it('builds a playback link at the media service, from a run id and nothing else', () => {
    /*
     * NEVER FROM A RESPONSE. No response carries a location, so there is
     * nothing to be tempted by; the origin is the console's own configuration.
     */
    expect(replayPlaybackUrl('https://ingest.example.com/', 'run_a')).toBe(
      'https://ingest.example.com/replays/run_a/playlist.m3u8',
    );
    expect(replayPlaybackUrl('https://ingest.example.com', 'run a/b')).toBe(
      'https://ingest.example.com/replays/run%20a%2Fb/playlist.m3u8',
    );
  });
});
