/** @author masterzee001 */
import { describe, expect, it, vi } from 'vitest';
import { createAudioRouter, defaultRoute, resolveRoute } from '../call/audioRoute';

describe('audio route', () => {
  it('audio-only defaults to the earpiece; camera on defaults to the loudspeaker', () => {
    expect(defaultRoute(false)).toBe('earpiece');
    expect(defaultRoute(true)).toBe('speaker');
  });

  it('an explicit choice wins and keeps winning as the camera toggles', () => {
    expect(resolveRoute(false, 'speaker')).toBe('speaker');
    expect(resolveRoute(true, 'earpiece')).toBe('earpiece');
    expect(resolveRoute(true, null)).toBe('speaker');
  });

  it('applies the route through the platform switch, once per change, and releases on exit', async () => {
    const setMode = vi.fn(async () => {});
    const router = createAudioRouter(setMode);
    expect(await router.apply('earpiece')).toBe(true);
    expect(await router.apply('earpiece')).toBe(true);
    expect(setMode).toHaveBeenCalledTimes(1);
    expect(setMode).toHaveBeenLastCalledWith({ shouldRouteThroughEarpiece: true });
    expect(await router.apply('speaker')).toBe(true);
    expect(setMode).toHaveBeenLastCalledWith({ shouldRouteThroughEarpiece: false });
    expect(router.current()).toBe('speaker');
    await router.release();
    expect(router.current()).toBeNull();
  });

  it('goes through Telecom first while it owns the call, and falls back to the app switch when it does not', async () => {
    const setMode = vi.fn(async () => {});
    const owned = createAudioRouter(setMode, () => true);
    expect(await owned.apply('speaker')).toBe(true);
    expect(setMode).not.toHaveBeenCalled();
    const unowned = createAudioRouter(setMode, () => false);
    expect(await unowned.apply('speaker')).toBe(true);
    expect(setMode).toHaveBeenCalledWith({ shouldRouteThroughEarpiece: false });
  });

  it('a platform refusal is reported, never thrown into the call', async () => {
    const router = createAudioRouter(async () => {
      throw new Error('no audio manager');
    });
    expect(await router.apply('speaker')).toBe(false);
    await expect(router.release()).resolves.toBeUndefined();
  });
});
