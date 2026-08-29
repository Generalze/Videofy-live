/** @author masterzee001 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOOT_MARK_WIDTH,
  BRAND_NAME,
  MINIMUM_BOOT_VISIBLE_MS,
  SPLASH_GROUND,
  TAGLINE,
  bootExitDelayMs,
  bootPhaseWords,
  isBootPhase,
} from '../boot/bootCopy';

const mobileRoot = resolve(__dirname, '..', '..');

describe('boot copy', () => {
  it('carries the founder ruling word for word', () => {
    expect(BRAND_NAME).toBe('Videofy Live');
    expect(TAGLINE).toBe('Speak naturally. Be understood everywhere.');
  });

  it('knows which statuses are still booting', () => {
    expect(isBootPhase('starting')).toBe(true);
    expect(isBootPhase('validating')).toBe(true);
    expect(isBootPhase('signed-in')).toBe(false);
    expect(isBootPhase('signed-out')).toBe(false);
  });

  it('says what the phone is doing, plainly', () => {
    expect(bootPhaseWords('starting')).toBe('Starting');
    expect(bootPhaseWords('validating')).toBe('Checking your session');
    expect(bootPhaseWords('signed-in')).toBe('Ready');
    expect(bootPhaseWords('signed-out')).toBe('Ready');
  });
});

describe('boot exit delay', () => {
  it('holds the remainder of the minimum when the session check is instant', () => {
    expect(bootExitDelayMs(1_000, 1_100, 700)).toBe(600);
    expect(bootExitDelayMs(1_000, 1_000)).toBe(MINIMUM_BOOT_VISIBLE_MS);
  });

  it('adds nothing once the minimum has passed', () => {
    expect(bootExitDelayMs(1_000, 1_700, 700)).toBe(0);
    expect(bootExitDelayMs(1_000, 9_000, 700)).toBe(0);
  });

  it('never holds longer than the minimum, even with a clock that went backwards', () => {
    expect(bootExitDelayMs(5_000, 1_000, 700)).toBe(700);
    expect(bootExitDelayMs(5_000, 1_000, 0)).toBe(0);
  });
});

/**
 * The native splash and the JS screen must agree, or the hand-off shows. This
 * reads app.json back rather than trusting a comment to keep them aligned.
 */
describe('native splash agrees with the JS boot screen', () => {
  const appJson = JSON.parse(readFileSync(resolve(mobileRoot, 'app.json'), 'utf8')) as {
    expo: { backgroundColor?: string; plugins: ReadonlyArray<string | readonly [string, Record<string, unknown>]> };
  };
  const splash = appJson.expo.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-splash-screen');

  it('declares the expo-splash-screen plugin with the shared ground and mark width', () => {
    expect(Array.isArray(splash)).toBe(true);
    const config = (splash as readonly [string, Record<string, unknown>])[1];
    expect(config['backgroundColor']).toBe(SPLASH_GROUND);
    expect(config['imageWidth']).toBe(BOOT_MARK_WIDTH);
    expect(config['resizeMode']).toBe('contain');
    expect((config['android'] as Record<string, unknown>)['backgroundColor']).toBe(SPLASH_GROUND);
    expect((config['dark'] as Record<string, unknown>)['backgroundColor']).toBe(SPLASH_GROUND);
  });

  it('points at a splash image that exists', () => {
    const config = (splash as readonly [string, Record<string, unknown>])[1];
    expect(config['image']).toBe('./assets/splash-icon.png');
    expect(existsSync(resolve(mobileRoot, 'assets', 'splash-icon.png'))).toBe(true);
  });

  it('paints the root view the same dark, so nothing behind React is ever white', () => {
    expect(appJson.expo.backgroundColor).toBe(SPLASH_GROUND);
  });
});
