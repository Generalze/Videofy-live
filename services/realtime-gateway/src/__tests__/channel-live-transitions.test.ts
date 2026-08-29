/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import { diffLiveTransitions } from '../channel-live-transitions.js';

const row = (channelId: string, live: boolean) => ({ channelId, live, displayName: `Channel ${channelId}` });

describe('channel live transitions', () => {
  it('reports a channel once when it goes live and once when it stops', () => {
    const seen = new Map<string, boolean>();
    expect(diffLiveTransitions(seen, [row('a', true)])).toEqual([{ channelId: 'a', live: true, displayName: 'Channel a' }]);
    expect(diffLiveTransitions(seen, [row('a', true)])).toEqual([]);
    expect(diffLiveTransitions(seen, [row('a', false)])).toEqual([{ channelId: 'a', live: false, displayName: 'Channel a' }]);
  });

  it('a channel that first appears off-air is not a transition', () => {
    expect(diffLiveTransitions(new Map(), [row('b', false)])).toEqual([]);
  });

  it('a re-broadcast for another channel does not re-push the ones that did not change', () => {
    const seen = new Map<string, boolean>();
    diffLiveTransitions(seen, [row('a', true), row('b', false)]);
    expect(diffLiveTransitions(seen, [row('a', true), row('b', true)])).toEqual([
      { channelId: 'b', live: true, displayName: 'Channel b' },
    ]);
  });
});
