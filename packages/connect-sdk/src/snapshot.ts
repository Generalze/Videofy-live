/** @owner masterzee001 */
import type { DeliveryState } from '@videofy-live/connect-contracts';

/**
 * The ONLY place the internal per-speaker gain becomes a public word. The
 * float itself never crosses the surface: 1 means the original is the
 * delivery, 0 means the translated voice replaced it, anything between is
 * the original held underneath a live interpretation.
 */
export function deliveryStateFromGain(gain: number): DeliveryState {
  if (gain >= 1) return 'original';
  if (gain <= 0) return 'translated';
  return 'reduced';
}

/** Snapshots are handed out frozen so nobody can mutate shared state. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
