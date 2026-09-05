/** @author masterzee001 */
/**
 * The Replay panel, as an operator reads it.
 *
 * The assertions worth having are the ones about what an operator is TOLD:
 *
 *   that a channel which has decided nothing has decided nothing, and that the
 *   controls in front of them are not already in force;
 *
 *   that `unlisted` means a link rather than a secret;
 *
 *   that a public replay on a channel which is not public is listed to nobody,
 *   which is the fact that lives on two different settings and is therefore the
 *   one nobody works out;
 *
 *   that what will actually happen is the SERVICE'S sentence and not the sum of
 *   the two forms on screen;
 *
 *   and that a deployment with no storage is told so rather than being offered
 *   a form that would lose what they typed.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReplayPanel, type ReplayPanelProps } from './ReplayPanel';
import { INHERIT, NO_OVERRIDE, type OwnerAiringDto } from './replayConsole';

const NOW = 1_700_000_000_000;

const BASE: ReplayPanelProps = {
  unavailable: false,
  loading: false,
  saving: false,
  configured: true,
  channelPublished: true,
  maxDurationDays: 3650,
  draft: { policy: 'keep', durationDays: null, visibility: 'public', allowOverrides: true },
  overrideDraft: NO_OVERRIDE,
  overridesAllowed: true,
  resolution: null,
  airings: [],
  hasMoreHistory: false,
  loadingMore: false,
  error: null,
  ingestUrl: 'https://ingest.example.com',
  nowMs: NOW,
  onDraftChange: () => {},
  onOverrideChange: () => {},
  onSaveSettings: () => {},
  onSaveOverride: () => {},
  onLoadMore: () => {},
  onReload: () => {},
};

function markup(overrides: Partial<ReplayPanelProps> = {}): string {
  return renderToStaticMarkup(<ReplayPanel {...BASE} {...overrides} />);
}

function airing(overrides: Partial<OwnerAiringDto> = {}): OwnerAiringDto {
  return {
    runId: 'run_a',
    channelId: 'ch_1',
    programmeId: 'ch_1',
    startedAtMs: NOW,
    endedAtMs: NOW + 60_000,
    replay: null,
    ...overrides,
  };
}

function withReplay(overrides: Partial<NonNullable<OwnerAiringDto['replay']>> = {}): OwnerAiringDto {
  return airing({
    replay: {
      runId: 'run_a',
      status: 'available',
      visibility: 'public',
      expiresAtMs: null,
      failure: null,
      bytes: 5 * 1024 * 1024,
      segmentCount: 12,
      watchable: true,
      listedPublicly: true,
      ...overrides,
    },
  });
}

/* ============================================================ the capability */

describe('a deployment that cannot keep replay settings says so', () => {
  it('offers no form at all', () => {
    /*
     * A FORM WITHOUT STORAGE ACCEPTS A RETENTION DECISION AND LOSES IT, and
     * the operator broadcasts believing it is in force.
     */
    const html = markup({ unavailable: true });
    expect(html).toContain('not available on this deployment');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('Save replay settings');
  });
});

/* ============================================================== the defaults */

describe('a channel that has decided nothing', () => {
  it('is told the controls are not in force yet', () => {
    const html = markup({ configured: false });
    expect(html).toContain('has not chosen a replay setting yet');
    expect(html).toContain('Nothing below is in force until you save it');
  });

  it('says nothing of the sort once it has', () => {
    expect(markup({ configured: true })).not.toContain('has not chosen a replay setting');
  });
});

describe('the duration box belongs to expire', () => {
  it('is absent for keep and for none', () => {
    for (const policy of ['keep', 'none'] as const) {
      const html = markup({ draft: { ...BASE.draft, policy } });
      expect(html, policy).not.toContain('replay-duration');
    }
  });

  it('appears for expire, and complains when it is empty', () => {
    const html = markup({
      draft: { ...BASE.draft, policy: 'expire', durationDays: null },
    });
    expect(html).toContain('replay-duration');
    expect(html).toContain('Say how long recordings should be kept');
  });

  it('bounds itself by the number the service gave, not one of its own', () => {
    const html = markup({
      maxDurationDays: 90,
      draft: { ...BASE.draft, policy: 'expire', durationDays: 120 },
    });
    expect(html).toContain('max="90"');
    expect(html).toContain('The longest you can set is 90 days');
  });
});

/* ============================================================ the visibility */

describe('the replay tiers, in the words that stop a mistake', () => {
  it('offers unlisted and never locked', () => {
    const html = markup();
    expect(html).toContain('Unlisted');
    expect(html).not.toContain('Locked');
  });

  it('says unlisted is a link rather than a secret', () => {
    const html = markup({ draft: { ...BASE.draft, visibility: 'unlisted' } });
    expect(html).toContain('Anyone you give the link to can watch it');
  });

  it('says a replay setting is not the channel door', () => {
    expect(markup()).toContain('separate from who can reach the channel');
  });

  it('warns when the channel itself is not public, whatever is chosen here', () => {
    /*
     * TWO SETTINGS, TWO PAGES, TWO OF THE SAME THREE WORDS. This is the fact an
     * operator is least likely to derive and most likely to be surprised by.
     */
    const html = markup({ channelPublished: false, draft: { ...BASE.draft, visibility: 'public' } });
    expect(html).toContain('no replay of it is listed to anybody');
    expect(markup({ channelPublished: true })).not.toContain('no replay of it is listed to anybody');
  });
});

/* ============================================================= the override */

describe('a programme that may not differ', () => {
  it('is told why, and the controls are disabled', () => {
    const html = markup({ overridesAllowed: false });
    expect(html).toContain('does not let individual programmes differ');
    expect(html).toContain('disabled');
  });

  it('and the disabled control is not the authorisation', () => {
    /*
     * SAID HERE BECAUSE IT IS EASY TO BELIEVE OTHERWISE. The service refuses an
     * override on a channel that forbids one whether or not this attribute is
     * present, and `replay-routes.test.ts` is where that is proven. The panel
     * merely stops inviting an operator to be refused.
     */
    const html = markup({ overridesAllowed: false });
    expect(html).toContain('refused rather than overruled');
  });

  it('offers "use the channel setting" as a first-class choice', () => {
    const html = markup();
    expect(html).toContain(`value="${INHERIT}"`);
    expect(html).toContain('Use the channel setting');
  });

  it('explains that an empty duration box means the channel number', () => {
    // Empty is not "no duration"; those are different answers on the wire.
    const html = markup({
      overrideDraft: { policy: 'expire', durationDays: null, visibility: INHERIT },
    });
    expect(html).toContain('use the channel’s own number of days');
  });
});

/* ============================================================ the resolution */

describe('what will happen is the service answer', () => {
  it('prints a resolution the two forms on screen do not add up to', () => {
    /*
     * The forms say "use the channel setting" for everything, and the service
     * says the programme overrides both. A panel that derived the sentence
     * would print the other answer. This one prints the service's, which is
     * what the media service is actually going to do.
     */
    const html = markup({
      overrideDraft: NO_OVERRIDE,
      resolution: {
        ok: true,
        resolved: {
          retention: { policy: 'expire', expiresAtMs: NOW + 7 * 86_400_000 },
          visibility: 'private',
          retentionSource: 'programme-override',
          visibilitySource: 'programme-override',
        },
      },
    });
    expect(html).toContain('Recorded and kept for 7 days, private.');
    expect(html).toContain('Both set for this programme');
  });

  it('shows a refusal in the service words', () => {
    const html = markup({
      resolution: {
        ok: false,
        refusal: 'channel-unconfigured',
        detail: 'no replay settings are configured for channel ch_1',
      },
    });
    expect(html).toContain('no replay settings are configured for channel ch_1');
  });

  it('shows nothing at all when there is no resolution to show', () => {
    expect(markup({ resolution: null })).not.toContain('replay-resolution');
  });
});

/* =============================================================== the history */

describe('the history says what became of each recording', () => {
  it('says "kept nothing" as its own answer, with no play link', () => {
    const html = markup({ airings: [airing()] });
    expect(html).toContain('No recording was kept for this broadcast.');
    expect(html).not.toContain('Watch');
  });

  it('offers a play link only for something that would actually play', () => {
    expect(markup({ airings: [withReplay()] })).toContain('Watch');
    expect(markup({ airings: [withReplay({ watchable: false, status: 'expired' })] })).not.toContain(
      '>Watch<',
    );
  });

  it('links at the media service, built from the run id', () => {
    const html = markup({ airings: [withReplay()] });
    expect(html).toContain('https://ingest.example.com/replays/run_a/playlist.m3u8');
  });

  it('never renders a storage reference, an archive root or a spool path', () => {
    const html = markup({
      airings: [
        withReplay(),
        airing(),
        withReplay({
          status: 'failed',
          watchable: false,
          failure: {
            reason: 'source-media-unavailable',
            summary: 'Programme media became unavailable before replay retention completed.',
          },
        }),
      ],
    });
    for (const forbidden of ['storageReference', '/replay/runs/', '.bin', 'spool', 'archiveRoot']) {
      expect(html, forbidden).not.toContain(forbidden);
    }
  });

  it('tells the operator which recordings a stranger would find', () => {
    expect(markup({ airings: [withReplay({ listedPublicly: true })] })).toContain(
      'listed on your channel page',
    );
    expect(markup({ airings: [withReplay({ listedPublicly: false })] })).toContain(
      'Available by link only',
    );
  });

  it('says a failure in the service words and never calls it a choice', () => {
    const html = markup({
      airings: [
        withReplay({
          status: 'failed',
          watchable: false,
          failure: { reason: 'archive-unavailable', summary: 'The replay archive was unavailable.' },
        }),
      ],
    });
    expect(html).toContain('The replay archive was unavailable.');
    expect(html).not.toContain('No recording was kept');
  });

  it('offers the next page only when there is one', () => {
    expect(markup({ hasMoreHistory: true })).toContain('Show earlier broadcasts');
    expect(markup({ hasMoreHistory: false })).not.toContain('Show earlier broadcasts');
  });

  it('says plainly when nothing has gone out yet', () => {
    expect(markup({ airings: [] })).toContain('Nothing has gone out on this channel yet');
  });
});

describe('a failure to reach the service', () => {
  it('is shown with a way to try again, and does not hide the form', () => {
    const html = markup({ error: 'Replay settings could not be reached. Try again.' });
    expect(html).toContain('could not be reached');
    expect(html).toContain('Try again');
    expect(html).toContain('replay-policy');
  });
});
