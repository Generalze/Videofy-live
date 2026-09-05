/** @author masterzee001 */
/**
 * The three rules from `audience.ts`, under attack.
 *
 *   UNLISTED IS A LINK, NOT A GREYED-OUT ROW.
 *   PRIVATE IS AUTHORISATION, NOT OBSCURITY.
 *   A PUBLIC ANSWER'S SHAPE NEVER CHANGES BECAUSE SOMETHING IS HIDDEN.
 *
 * The third one is the reason most of this file exists. A leak by response
 * shape is invisible to the person who writes it, invisible in review, and
 * perfectly usable by anybody with a browser and an afternoon: enumerate a
 * channel's history, look for the airings whose `replay` key is present but
 * unplayable, and you have a list of exactly the recordings whose operator
 * chose to hide them. So there are tests here that compare SERIALISED bytes
 * rather than fields, and a sweep that walks every combination of status,
 * visibility, retention and clock and insists all of them that withhold
 * produce one identical answer.
 */
import { describe, expect, it } from 'vitest';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import { REPLAY_STATUSES, type ReplayStatus } from './lifecycle.js';
import { REPLAY_FAILURE_REASONS } from './outcome.js';
import type { ReplayVisibility } from './policy.js';
import {
  REPLAY_NOT_KEPT,
  summariseFailure,
  type ProgrammeAiringRecord,
  type ReplayDisposition,
  type ReplaySummary,
} from './airing.js';
import {
  isWatchable,
  listableToPublic,
  reachableByLink,
  toOwnerView,
  toPublicByLink,
  toPublicListing,
} from './audience.js';

const RUN: ProgrammeRunIdentity = { channelId: 'chan_a', programmeId: 'prog_a', runId: 'run_a' };
const STARTED = 1_700_000_000_000;
const NOW = STARTED + 3_600_000;

const VISIBILITIES: readonly ReplayVisibility[] = ['public', 'unlisted', 'private'];

function summary(overrides: Partial<ReplaySummary> = {}): ReplaySummary {
  return {
    status: 'available',
    retention: { policy: 'keep' },
    visibility: 'public',
    finalisedAtMs: STARTED + 60_000,
    expiresAtMs: null,
    failure: null,
    bytes: 4_096,
    segmentCount: 3,
    initialisationCount: 1,
    ...overrides,
  };
}

function kept(overrides: Partial<ReplaySummary> = {}): ReplayDisposition {
  return { disposition: 'replay', summary: summary(overrides) };
}

function airing(replay: ReplayDisposition, overrides: Partial<ProgrammeAiringRecord> = {}): ProgrammeAiringRecord {
  return {
    identity: RUN,
    startedAtMs: STARTED,
    endedAtMs: STARTED + 60_000,
    replay,
    ...overrides,
  };
}

/* ============================================================= watchability */

describe('what can be played at all', () => {
  it('only available is watchable', () => {
    for (const status of REPLAY_STATUSES) {
      expect(isWatchable(summary({ status }), NOW), status).toBe(status === 'available');
    }
  });

  it('an available replay past its expiry is not watchable', () => {
    /*
     * THE GAP THE LIFECYCLE WORKER HAS NOT CLOSED YET. A thirty-day promise is
     * either honoured the instant it runs out or it is a thirty-ish-day
     * promise, and "we had not swept it yet" is not an answer to give the
     * person who was promised.
     */
    const expiring = summary({
      retention: { policy: 'expire', expiresAtMs: NOW - 1 },
      expiresAtMs: NOW - 1,
    });
    expect(isWatchable(expiring, NOW)).toBe(false);
    expect(isWatchable(expiring, NOW - 2)).toBe(true);
  });

  it('the expiry instant itself is over', () => {
    const at = summary({ retention: { policy: 'expire', expiresAtMs: NOW }, expiresAtMs: NOW });
    expect(isWatchable(at, NOW)).toBe(false);
  });

  it('a kept replay never expires however long ago it aired', () => {
    expect(isWatchable(summary(), STARTED + 100 * 365 * 86_400_000)).toBe(true);
  });
});

/* ================================================================ the tiers */

describe('unlisted is a link, private is a refusal', () => {
  it('public is both reachable and listable', () => {
    const replay = kept({ visibility: 'public' });
    expect(reachableByLink(replay, true, NOW)).toBe(true);
    expect(listableToPublic(replay, true, NOW)).toBe(true);
  });

  it('unlisted is reachable and never listable', () => {
    // The whole meaning of the tier, in two assertions.
    const replay = kept({ visibility: 'unlisted' });
    expect(reachableByLink(replay, true, NOW)).toBe(true);
    expect(listableToPublic(replay, true, NOW)).toBe(false);
  });

  it('private is neither, however the address was arrived at', () => {
    const replay = kept({ visibility: 'private' });
    expect(reachableByLink(replay, true, NOW)).toBe(false);
    expect(listableToPublic(replay, true, NOW)).toBe(false);
  });

  it('an airing that kept nothing is neither', () => {
    expect(reachableByLink(REPLAY_NOT_KEPT, true, NOW)).toBe(false);
    expect(listableToPublic(REPLAY_NOT_KEPT, true, NOW)).toBe(false);
  });
});

describe('replay visibility is a permission on top of the channel, never around it', () => {
  it('a public replay on a channel the platform does not publish is not public', () => {
    /*
     * THE BYPASS THIS FORBIDS. Replay visibility was added after channel
     * visibility, and a reading of "public replay" as "publish it" would let an
     * operator's replay setting overrule a channel setting made on another page
     * for a different reason.
     */
    for (const visibility of VISIBILITIES) {
      const replay = kept({ visibility });
      expect(reachableByLink(replay, false, NOW), visibility).toBe(false);
      expect(listableToPublic(replay, false, NOW), visibility).toBe(false);
    }
  });

  it('the channel decision alone never widens anything', () => {
    // Every tier, both channel answers: a public channel may only ever match
    // or narrow, never exceed, what the replay tier already allowed.
    for (const visibility of VISIBILITIES) {
      const replay = kept({ visibility });
      expect(reachableByLink(replay, false, NOW)).toBe(false);
      if (!reachableByLink(replay, true, NOW)) {
        expect(listableToPublic(replay, true, NOW)).toBe(false);
      }
    }
  });
});

/* ================================================== the shape does not move */

describe('a public answer never changes shape because something is hidden', () => {
  const hiddenReasons: readonly (readonly [string, ReplayDisposition])[] = [
    ['never recorded', REPLAY_NOT_KEPT],
    ['private', kept({ visibility: 'private' })],
    ['unlisted', kept({ visibility: 'unlisted' })],
    ['still recording', kept({ status: 'recording' })],
    ['processing', kept({ status: 'processing' })],
    ['deleted', kept({ status: 'deleted' })],
    ['expired by status', kept({ status: 'expired' })],
    [
      'expired by clock',
      kept({ retention: { policy: 'expire', expiresAtMs: NOW - 1 }, expiresAtMs: NOW - 1 }),
    ],
    [
      'failed',
      kept({
        status: 'failed',
        failure: summariseFailure({
          reason: 'source-media-unavailable',
          detail: '/var/spool/videofy/run_a/0001.m4s could not be opened',
          liveImpact: 'none',
        }),
      }),
    ],
  ];

  it('every reason to withhold produces the same bytes as never having recorded', () => {
    const control = JSON.stringify(toPublicListing(airing(REPLAY_NOT_KEPT), true, NOW));
    for (const [why, replay] of hiddenReasons) {
      expect(JSON.stringify(toPublicListing(airing(replay), true, NOW)), why).toBe(control);
    }
  });

  it('the keys are identical whether or not there is something to watch', () => {
    const shown = toPublicListing(airing(kept()), true, NOW);
    const hidden = toPublicListing(airing(kept({ visibility: 'private' })), true, NOW);
    expect(Object.keys(shown).sort()).toEqual(Object.keys(hidden).sort());
    expect('replay' in hidden).toBe(true);
    expect(hidden.replay).toBeNull();
  });

  it('a failure summary never reaches a public answer', () => {
    // Not the mapped sentence and certainly not the reason: "this one failed"
    // is still the disclosure that this one was being recorded.
    const failed = kept({
      status: 'failed',
      failure: { reason: 'archive-unavailable', summary: 'The replay archive was unavailable.' },
    });
    const view = toPublicListing(airing(failed), true, NOW);
    expect(JSON.stringify(view)).not.toContain('archive');
    expect(JSON.stringify(view)).not.toContain('unavailable');
  });

  it('no public answer carries bytes, counts, status, visibility or retention', () => {
    for (const visibility of VISIBILITIES) {
      for (const status of REPLAY_STATUSES) {
        const view = toPublicListing(airing(kept({ visibility, status })), true, NOW);
        const json = JSON.stringify(view);
        expect(json, `${visibility}/${status}`).not.toContain('bytes');
        expect(json).not.toContain('segmentCount');
        expect(json).not.toContain('initialisationCount');
        expect(json).not.toContain('status');
        expect(json).not.toContain('visibility');
        expect(json).not.toContain('retention');
      }
    }
  });

  it('never carries a storage reference, however the record was built', () => {
    /*
     * A `ReplaySummary` cannot hold one by construction, and this is the test
     * that says so out loud so a field added to it later has to argue with a
     * name rather than slip through.
     */
    const view = toPublicListing(airing(kept()), true, NOW);
    const json = JSON.stringify(view);
    for (const forbidden of ['storageReference', '/replay/', 'archiveRoot', '.bin', 'spool']) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });

  it('the whole sweep: withheld is withheld, shown is shown, and both look the same', () => {
    const control = JSON.stringify(toPublicListing(airing(REPLAY_NOT_KEPT), true, NOW));
    let shownAtLeastOnce = false;
    for (const visibility of VISIBILITIES) {
      for (const status of REPLAY_STATUSES) {
        for (const expiresAtMs of [null, NOW - 1, NOW + 1] as const) {
          for (const channelIsPublic of [true, false]) {
            const replay = kept({
              visibility,
              status,
              ...(expiresAtMs === null
                ? { retention: { policy: 'keep' } as const, expiresAtMs: null }
                : { retention: { policy: 'expire', expiresAtMs } as const, expiresAtMs }),
            });
            const view = toPublicListing(airing(replay), channelIsPublic, NOW);
            const expected =
              channelIsPublic &&
              visibility === 'public' &&
              status === 'available' &&
              (expiresAtMs === null || NOW < expiresAtMs);
            const label = `${visibility}/${status}/${String(expiresAtMs)}/${String(channelIsPublic)}`;
            if (expected) {
              shownAtLeastOnce = true;
              expect(view.replay, label).not.toBeNull();
            } else {
              expect(JSON.stringify(view), label).toBe(control);
            }
          }
        }
      }
    }
    // A sweep that never showed anything would pass while proving nothing.
    expect(shownAtLeastOnce).toBe(true);
  });
});

describe('the airing itself is history and does not disappear with its media', () => {
  it('a broadcast with a deleted recording still appears', () => {
    const view = toPublicListing(airing(kept({ status: 'deleted' })), true, NOW);
    expect(view.startedAtMs).toBe(STARTED);
    expect(view.endedAtMs).toBe(STARTED + 60_000);
    expect(view.replay).toBeNull();
  });

  it('a broadcast still on air appears with no end and nothing to watch', () => {
    const live = airing(kept({ status: 'recording' }), { endedAtMs: null });
    const view = toPublicListing(live, true, NOW);
    expect(view.endedAtMs).toBeNull();
    expect(view.replay).toBeNull();
  });
});

/* ========================================================= reaching by link */

describe('arriving with the address', () => {
  it('serves an unlisted recording that no listing would have shown', () => {
    const record = airing(kept({ visibility: 'unlisted' }));
    expect(toPublicListing(record, true, NOW).replay).toBeNull();
    expect(toPublicByLink(record, true, NOW).replay).toEqual({ runId: 'run_a', expiresAtMs: null });
  });

  it('still refuses a private one', () => {
    const record = airing(kept({ visibility: 'private' }));
    expect(toPublicByLink(record, true, NOW).replay).toBeNull();
  });

  it('still refuses everything on a channel the platform does not publish', () => {
    for (const visibility of VISIBILITIES) {
      expect(toPublicByLink(airing(kept({ visibility })), false, NOW).replay, visibility).toBeNull();
    }
  });

  it('a refused link answer is shaped exactly like a never-recorded one', () => {
    const control = JSON.stringify(toPublicByLink(airing(REPLAY_NOT_KEPT), true, NOW));
    expect(JSON.stringify(toPublicByLink(airing(kept({ visibility: 'private' })), true, NOW))).toBe(
      control,
    );
  });

  it('carries the expiry so a viewer knows how long they have', () => {
    const expiresAtMs = NOW + 86_400_000;
    const record = airing(kept({ retention: { policy: 'expire', expiresAtMs }, expiresAtMs }));
    expect(toPublicByLink(record, true, NOW).replay).toEqual({ runId: 'run_a', expiresAtMs });
  });
});

/* =============================================================== the owner */

describe('the operator is told the truth about their own broadcast', () => {
  it('sees status, retention, visibility, counts and the failure', () => {
    const failed = kept({
      status: 'failed',
      failure: { reason: 'no-media-retained', summary: 'No programme media was retained for this replay.' },
    });
    const view = toOwnerView(airing(failed), true, NOW);
    expect(view.replay?.status).toBe('failed');
    expect(view.replay?.failure?.reason).toBe('no-media-retained');
    expect(view.replay?.bytes).toBe(4_096);
    expect(view.replay?.segmentCount).toBe(3);
    expect(view.replay?.watchable).toBe(false);
  });

  it('null replay means the operator kept nothing, and nothing else means that', () => {
    expect(toOwnerView(airing(REPLAY_NOT_KEPT), true, NOW).replay).toBeNull();
    for (const status of REPLAY_STATUSES) {
      expect(toOwnerView(airing(kept({ status })), true, NOW).replay, status).not.toBeNull();
    }
  });

  it('watchable is the same judgement the audience gets', () => {
    for (const status of REPLAY_STATUSES) {
      const record = airing(kept({ status, visibility: 'private' }));
      expect(toOwnerView(record, true, NOW).replay?.watchable, status).toBe(
        status === 'available',
      );
    }
  });

  it('tells the operator plainly that a public replay on an unpublished channel is not listed', () => {
    /*
     * TWO SETTINGS ON TWO PAGES, and the answer to "will anybody find this"
     * depends on both. An operator should not have to derive it.
     */
    const record = airing(kept({ visibility: 'public' }));
    expect(toOwnerView(record, true, NOW).replay?.listedPublicly).toBe(true);
    expect(toOwnerView(record, false, NOW).replay?.listedPublicly).toBe(false);
  });

  it('says an unlisted replay is not listed even on a public channel', () => {
    const record = airing(kept({ visibility: 'unlisted' }));
    const view = toOwnerView(record, true, NOW);
    expect(view.replay?.watchable).toBe(true);
    expect(view.replay?.listedPublicly).toBe(false);
  });

  it('never carries a storage reference either', () => {
    const view = toOwnerView(airing(kept()), true, NOW);
    const json = JSON.stringify(view);
    for (const forbidden of ['storageReference', '/replay/', '.bin', 'spool']) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });

  it('every failure reason maps to a sentence and never to raw detail', () => {
    for (const reason of REPLAY_FAILURE_REASONS) {
      const view = toOwnerView(
        airing(
          kept({
            status: 'failed',
            failure: summariseFailure({
              reason,
              detail: 'C:\\spool\\videofy\\run_a\\0001.m4s',
              liveImpact: 'none',
            }),
          }),
        ),
        true,
        NOW,
      );
      expect(view.replay?.failure?.reason, reason).toBe(reason);
      expect(JSON.stringify(view), reason).not.toContain('spool');
    }
  });
});

/* ============================================ the locator, not just the state */

describe('a hidden recording keeps its address as well as its existence', () => {
  /*
   * THE SECOND HALF OF THE SHAPE RULE. `replay: null` protects nothing while
   * the same object carries the run id: the by-link route is addressed by run
   * id, and `unlisted` means reachable by whoever holds that address. A listing
   * that printed it would be handing out the link to every recording it had
   * just declined to show -- and at one airing per page, the whole channel.
   */
  it('no public view carries a run id at the top level, ever', () => {
    for (const visibility of VISIBILITIES) {
      for (const status of REPLAY_STATUSES) {
        const view = toPublicListing(airing(kept({ visibility, status })), true, NOW);
        expect(Object.keys(view).sort(), `${visibility}/${status}`).toEqual([
          'channelId',
          'endedAtMs',
          'programmeId',
          'replay',
          'startedAtMs',
        ]);
      }
    }
  });

  it('the run id of a withheld recording appears nowhere in its serialised view', () => {
    const secret = 'unlisted-secret-run-92817';
    const record: ProgrammeAiringRecord = {
      identity: { channelId: 'chan_a', programmeId: 'prog_a', runId: secret },
      startedAtMs: STARTED,
      endedAtMs: STARTED + 60_000,
      replay: kept({ visibility: 'unlisted' }),
    };
    expect(JSON.stringify(toPublicListing(record, true, NOW))).not.toContain(secret);
    expect(JSON.stringify(toPublicListing({ ...record, replay: kept({ visibility: 'private' }) }, true, NOW)))
      .not.toContain(secret);
    expect(JSON.stringify(toPublicListing({ ...record, replay: REPLAY_NOT_KEPT }, true, NOW)))
      .not.toContain(secret);
  });

  it('and does appear, inside replay, for one this audience may already watch', () => {
    // There it is the CAPABILITY -- how playback is addressed -- and telling
    // somebody the address of a recording you are handing them is not a leak.
    const record: ProgrammeAiringRecord = {
      identity: { channelId: 'chan_a', programmeId: 'prog_a', runId: 'public-run-00042' },
      startedAtMs: STARTED,
      endedAtMs: STARTED + 60_000,
      replay: kept({ visibility: 'public' }),
    };
    expect(toPublicListing(record, true, NOW).replay).toEqual({
      runId: 'public-run-00042',
      expiresAtMs: null,
    });
  });

  it('the by-link view discloses the run id only for what it is serving', () => {
    const record: ProgrammeAiringRecord = {
      identity: { channelId: 'chan_a', programmeId: 'prog_a', runId: 'unlisted-secret-run-92817' },
      startedAtMs: STARTED,
      endedAtMs: null,
      replay: kept({ visibility: 'unlisted' }),
    };
    // Served: the caller already had the id, so echoing it tells them nothing.
    expect(toPublicByLink(record, true, NOW).replay?.runId).toBe('unlisted-secret-run-92817');
    // Refused: and then it is gone from the answer entirely.
    const priv = toPublicByLink({ ...record, replay: kept({ visibility: 'private' }) }, true, NOW);
    expect(JSON.stringify(priv)).not.toContain('unlisted-secret-run-92817');
  });

  it('the owner keeps their own run ids, because they may', () => {
    const record: ProgrammeAiringRecord = {
      identity: { channelId: 'chan_a', programmeId: 'prog_a', runId: 'unlisted-secret-run-92817' },
      startedAtMs: STARTED,
      endedAtMs: null,
      replay: kept({ visibility: 'private' }),
    };
    expect(toOwnerView(record, true, NOW).runId).toBe('unlisted-secret-run-92817');
  });
});
