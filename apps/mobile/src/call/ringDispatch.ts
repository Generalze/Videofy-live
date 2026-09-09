/** @author masterzee001 */
export type RingDispatchStatus = 'accepted' | 'no-routable-device' | 'provider-failed' | 'unknown';

export interface RingDispatchPayload {
  readonly status: RingDispatchStatus;
  readonly reachedDevices: number;
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly pruned: number;
  readonly unreachablePlatforms: readonly string[];
}

export const UNKNOWN_RING_DISPATCH: RingDispatchPayload = {
  status: 'unknown',
  reachedDevices: -1,
  attempted: 0,
  delivered: 0,
  failed: 0,
  pruned: 0,
  unreachablePlatforms: [],
};

function positiveCount(...values: readonly number[]): number {
  return values.reduce(
    (max, value) =>
      typeof value === 'number' && Number.isFinite(value) ? Math.max(max, Math.floor(value)) : max,
    0,
  );
}

/**
 * Older gateways only understand top-level reachedDevices and treat 0 as
 * unavailable. Send 0 only when the semantic result proves no routable device.
 */
export function legacyReachedDevicesFor(dispatch: RingDispatchPayload): number {
  if (dispatch.status === 'no-routable-device') return 0;
  if (dispatch.status === 'accepted') {
    return Math.max(1, positiveCount(dispatch.reachedDevices, dispatch.delivered));
  }
  return -1;
}
