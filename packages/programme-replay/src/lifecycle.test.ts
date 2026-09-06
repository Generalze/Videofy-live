/** @author masterzee001 */
/**
 * The moves a replay is allowed to make, and the ones that would be lies.
 *
 * The interesting cases are all the same shape: a late message arriving after
 * a decision has been taken. A finaliser that lands after a delete; a retry
 * that reopens a broadcast which has ended. Each reads as one assignment in a
 * diff, and each hands an audience a recording somebody believed was gone.
 */
import { describe, expect, it } from 'vitest';
import {
  REPLAY_STATUSES,
  REPLAY_TRANSITIONS,
  canTransition,
  isReplayStatus,
  isServable,
  isTerminalReplayStatus,
  type ReplayStatus,
} from './lifecycle.js';

describe('the six states of a recording', () => {
  it('names exactly the lifecycle the product describes', () => {
    expect([...REPLAY_STATUSES].sort()).toEqual([
      'available',
      'deleted',
      'expired',
      'failed',
      'processing',
      'recording',
    ]);
  });

  it('refuses a status it has never heard of', () => {
    expect(isReplayStatus('available')).toBe(true);
    expect(isReplayStatus('AVAILABLE')).toBe(false);
    expect(isReplayStatus('ready')).toBe(false);
  });

  it('serves media in exactly one state', () => {
    const servable = REPLAY_STATUSES.filter(isServable);
    expect(servable).toEqual(['available']);
  });

  it('never comes back from failed, expired or deleted', () => {
    expect(REPLAY_STATUSES.filter(isTerminalReplayStatus).sort()).toEqual([
      'deleted',
      'expired',
      'failed',
    ]);
  });
});

describe('the transitions that are refused', () => {
  it('refuses deleted to available', () => {
    // The case that matters: a finaliser that was already in flight when
    // somebody deleted the recording.
    expect(canTransition('deleted', 'available')).toBe(false);
  });

  it('refuses failed to recording', () => {
    expect(canTransition('failed', 'recording')).toBe(false);
  });

  it('refuses expired to recording', () => {
    expect(canTransition('expired', 'recording')).toBe(false);
  });

  it('refuses available back to processing', () => {
    // Re-processing something a viewer may already be watching is a new
    // recording, not an edit of this one.
    expect(canTransition('available', 'processing')).toBe(false);
  });

  it('refuses recording straight to available', () => {
    // The check between kept and playable lives in processing. A record that
    // skipped it would have nowhere to fail.
    expect(canTransition('recording', 'available')).toBe(false);
  });

  it('lets a deleted recording go nowhere at all', () => {
    expect(REPLAY_TRANSITIONS.deleted).toEqual([]);
    for (const status of REPLAY_STATUSES) {
      expect(canTransition('deleted', status)).toBe(false);
    }
  });

  it('lets nothing at all return to recording', () => {
    for (const status of REPLAY_STATUSES) {
      expect(canTransition(status, 'recording')).toBe(false);
    }
  });

  it('leaves every terminal state able only to be deleted', () => {
    expect(REPLAY_TRANSITIONS.failed).toEqual(['deleted']);
    expect(REPLAY_TRANSITIONS.expired).toEqual(['deleted']);
  });
});

describe('the transitions that are permitted', () => {
  it('walks a successful recording from recording to available', () => {
    expect(canTransition('recording', 'processing')).toBe(true);
    expect(canTransition('processing', 'available')).toBe(true);
  });

  it('lets a recording fail from either working state', () => {
    expect(canTransition('recording', 'failed')).toBe(true);
    expect(canTransition('processing', 'failed')).toBe(true);
  });

  it('lets an available recording expire or be deleted', () => {
    expect(canTransition('available', 'expired')).toBe(true);
    expect(canTransition('available', 'deleted')).toBe(true);
  });

  it('names a destination for every state, and no unknown ones', () => {
    const known = new Set<ReplayStatus>(REPLAY_STATUSES);
    for (const status of REPLAY_STATUSES) {
      for (const destination of REPLAY_TRANSITIONS[status]) {
        expect(known.has(destination)).toBe(true);
        // Nothing is its own destination: a transition to the state you are
        // already in is not a transition, it is a no-op somebody will read as
        // progress.
        expect(destination).not.toBe(status);
      }
    }
  });
});
