/** @author masterzee001 */
/**
 * The boot screen's words and timing, kept out of React so they can be tested.
 *
 * Founder ruling (29 Aug 2026): "Replace [the plain white startup screen] with
 * a branded startup screen: deep dark/navy background with subtle premium
 * gradient; centered C7 logo; below it Videofy Live; below that: Speak
 * naturally. Be understood everywhere.; optional subtle loading indicator
 * near the bottom. Show immediately on startup while resources/session load;
 * transition smoothly once ready; no flash of plain white."
 *
 * The brand name, the tagline, the ground colour and the mark width live here
 * so the native splash (app.json), the JS screen (BootScreen.tsx) and the
 * founder's mock read ONE source. The test reads app.json back and refuses a
 * drift, because the hand-off from the OS splash to the first JS frame is only
 * invisible while the two agree on colour and size.
 */
import type { AuthState } from '../auth/authSessionManager';

export const BRAND_NAME = 'Videofy Live';
export const TAGLINE = 'Speak naturally. Be understood everywhere.';

/**
 * The flat ground under the native splash and the first JS frame. It is the
 * launcher icon's own corner colour (assets/icon.png, measured), so the tile
 * the person tapped, the OS splash and the app's first frame share one dark.
 * The C7 ground (#070b12) with its illumination fades in over it afterwards.
 */
export const SPLASH_GROUND = '#0b0f14';

/** The mark's width in dp, on the native splash and on the JS screen alike. */
export const BOOT_MARK_WIDTH = 200;

/**
 * How long the brand screen stays up even when the session check is instant.
 * Measured from mount, so a slow check adds nothing; a fast one does not blink.
 */
export const MINIMUM_BOOT_VISIBLE_MS = 700;

export type BootStatus = AuthState['status'];

/** True while the session layer has not yet decided who, if anyone, is signed in. */
export function isBootPhase(status: BootStatus): boolean {
  return status === 'starting' || status === 'validating';
}

/** The small line under the indicator: what the phone is doing right now. */
export function bootPhaseWords(status: BootStatus): string {
  switch (status) {
    case 'starting':
      return 'Starting';
    case 'validating':
      return 'Checking your session';
    case 'signed-in':
    case 'signed-out':
      return 'Ready';
  }
}

/**
 * Milliseconds still to hold the screen before it may leave: the remainder of
 * the minimum, never negative and never longer than the minimum itself (a
 * wall clock that jumped backwards must not turn the hold into a wait).
 */
export function bootExitDelayMs(mountedAtMs: number, nowMs: number, minimumVisibleMs = MINIMUM_BOOT_VISIBLE_MS): number {
  return Math.min(minimumVisibleMs, Math.max(0, mountedAtMs + minimumVisibleMs - nowMs));
}
