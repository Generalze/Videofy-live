/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import { legacyReachedDevicesFor, UNKNOWN_RING_DISPATCH } from '../call/ringDispatch';

const base = {
  attempted: 0,
  delivered: 0,
  failed: 0,
  pruned: 0,
  unreachablePlatforms: [],
} as const;

describe('ring dispatch compatibility', () => {
  it('only sends legacy zero when no-routable-device is proven', () => {
    expect(
      legacyReachedDevicesFor({
        ...base,
        status: 'no-routable-device',
        reachedDevices: 0,
      }),
    ).toBe(0);
  });

  it('does not let ambiguous or provider failures look unavailable to older gateways', () => {
    expect(legacyReachedDevicesFor(UNKNOWN_RING_DISPATCH)).toBe(-1);
    expect(
      legacyReachedDevicesFor({
        ...base,
        status: 'provider-failed',
        reachedDevices: 0,
        attempted: 1,
        failed: 1,
      }),
    ).toBe(-1);
  });

  it('keeps accepted ring dispatch positive for older gateways', () => {
    expect(
      legacyReachedDevicesFor({
        ...base,
        status: 'accepted',
        reachedDevices: 0,
        delivered: 1,
      }),
    ).toBe(1);
  });
});
