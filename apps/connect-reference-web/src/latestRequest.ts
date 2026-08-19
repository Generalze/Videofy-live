// owner: masterzee001
/**
 * Latest-request guard. A screen that fires a fetch per navigation can watch
 * responses land out of order — the KC server answers a live room slowly
 * (it asks the platform for the roster) and an idle room instantly, so two
 * quick clicks can dress the second room's lobby in the first room's answer.
 * Only the request the user made LAST may touch the screen: begin() when the
 * request is fired, isCurrent() when its answer lands, clear() when the
 * surface goes away entirely.
 */

export interface LatestRequestGuard {
  begin(key: string): void;
  isCurrent(key: string): boolean;
  clear(): void;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let current: string | null = null;
  return {
    begin(key) {
      current = key;
    },
    isCurrent: (key) => current !== null && current === key,
    clear() {
      current = null;
    },
  };
}
