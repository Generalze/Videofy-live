/** @author masterzee001 */
/**
 * The advert a viewer is in, and the ways it could quietly stop meaning anything.
 *
 * An impression is a claim that a particular advert ran in a particular
 * programme, to particular people. Every assertion here is about something
 * that would make that claim false while everything still looked fine: a
 * replay counted twice, an advert from another broadcast displacing this one,
 * a countdown that restarts on reconnect and stretches one advert across the
 * rest of the programme.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptAdvert,
  advertBelongsToRun,
  advertStillRunning,
  slotContent,
  type ProgrammeAdvertEvent,
} from './programmeAdvert';

const EVENT: ProgrammeAdvertEvent = {
  runId: 'run_1',
  decisionId: 'dec_1',
  creativeId: 'crea_1',
  programmeTimeMs: 600_000,
  durationMs: 30_000,
};

describe('whose advert this is', () => {
  it('accepts one for the broadcast being watched', () => {
    expect(advertBelongsToRun(EVENT, 'run_1')).toBe(true);
  });

  it('refuses one from another broadcast', () => {
    // A viewer who switched channels mid-advert must not keep the previous
    // programme's, and a stray event must not displace theirs.
    expect(advertBelongsToRun(EVENT, 'run_2')).toBe(false);
  });

  it('refuses one when this viewer is watching no run at all', () => {
    expect(advertBelongsToRun(EVENT, null)).toBe(false);
  });
});

describe('taking an advert as current', () => {
  it('takes a new one and starts its clock', () => {
    const advert = acceptAdvert(null, EVENT, 1_000);
    expect(advert?.decisionId).toBe('dec_1');
    expect(advert?.startedAtMs).toBe(1_000);
  });

  it('treats the same decision arriving again as the same advert', () => {
    const first = acceptAdvert(null, EVENT, 1_000);
    const again = acceptAdvert(first, EVENT, 20_000);
    /*
     * Reconnects replay. Restarting the countdown would stretch one advert
     * across the rest of the programme, and to anybody counting it would look
     * like a second impression.
     */
    expect(again).toBe(first);
    expect(again?.startedAtMs).toBe(1_000);
  });

  it('replaces it when a genuinely different advert arrives', () => {
    const first = acceptAdvert(null, EVENT, 1_000);
    const second = acceptAdvert(first, { ...EVENT, decisionId: 'dec_2' }, 40_000);
    expect(second?.decisionId).toBe('dec_2');
    expect(second?.startedAtMs).toBe(40_000);
  });

  it('declines an advert with no duration rather than showing it for ever', () => {
    expect(acceptAdvert(null, { ...EVENT, durationMs: 0 }, 1_000)).toBeNull();
  });
});

describe('what the slot shows', () => {
  it('shows the C7 advert while its own duration is running', () => {
    const advert = acceptAdvert(null, EVENT, 1_000);
    expect(slotContent(advert, 20_000)).toEqual({ kind: 'c7', creativeId: 'crea_1' });
  });

  it('returns to the house creative when it has finished', () => {
    const advert = acceptAdvert(null, EVENT, 1_000);
    expect(advertStillRunning(advert, 31_001)).toBe(false);
    // Not a failure state: it is the ordinary condition of a programme with
    // nothing sold into this moment.
    expect(slotContent(advert, 31_001)).toEqual({ kind: 'house' });
  });

  it('shows the house creative when C7 has decided nothing', () => {
    expect(slotContent(null, 1_000)).toEqual({ kind: 'house' });
  });

  it('carries nothing commercial to the browser', () => {
    const advert = acceptAdvert(null, EVENT, 1_000);
    const serialised = JSON.stringify(advert).toLowerCase();
    // A viewer with developer tools is not an authorised reader of what a
    // break is worth, and a browser is a public place.
    for (const forbidden of ['advertiser', 'priority', 'price', 'cpm', 'rate', 'campaign']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});
