/** @owner masterzee001 */
import type { ConnectEventMap, ConnectEventName } from '@videofy-live/connect-contracts';

type AnyListener = (payload: never) => void;

/**
 * Minimal typed emitter. Listener faults are swallowed: an integrator's
 * throwing handler must never be able to break the call loop that invoked it.
 */
export class ConnectEventEmitter {
  private readonly listeners = new Map<ConnectEventName, Set<AnyListener>>();

  on<K extends ConnectEventName>(event: K, listener: (payload: ConnectEventMap[K]) => void): void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(listener as AnyListener);
  }

  off<K extends ConnectEventName>(event: K, listener: (payload: ConnectEventMap[K]) => void): void {
    this.listeners.get(event)?.delete(listener as AnyListener);
  }

  emit<K extends ConnectEventName>(event: K, payload: ConnectEventMap[K]): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    for (const listener of [...bucket]) {
      try {
        (listener as (value: ConnectEventMap[K]) => void)(payload);
      } catch {
        // Deliberately swallowed; the SDK's own loop must survive listeners.
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
