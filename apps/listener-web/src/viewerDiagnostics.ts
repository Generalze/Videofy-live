/** @owner masterzee001 */
/**
 * Whether the technical diagnostics surface exists on this page load.
 *
 * Owner decision: diagnostics are for developers when they need them, so they
 * must not appear on the Viewer at all. Not collapsed, not dimmed, not behind
 * a summary a curious audience member can open — absent.
 *
 * The gate is an explicit URL flag rather than a build-time switch so a
 * developer can reach it against a real deployment while investigating,
 * without a rebuild and without a control that advertises itself to everyone
 * else.
 *
 * Callers must use this to decide whether to RENDER the surface, never merely
 * to hide it. A `hidden` attribute is defeated by any `display` declaration,
 * which is exactly how an audio-queue panel reached viewers once already.
 */
const DIAGNOSTICS_PARAM = 'diagnostics';

/** Values that mean "on". Anything else, including a bare flag, means off. */
const ENABLED_VALUES = new Set(['1', 'true', 'on']);

export function isDiagnosticsRequested(search: string): boolean {
  if (!search) return false;
  try {
    const value = new URLSearchParams(
      search.startsWith('?') ? search.slice(1) : search,
    ).get(DIAGNOSTICS_PARAM);
    return value !== null && ENABLED_VALUES.has(value.toLowerCase());
  } catch {
    // A malformed query string is not a reason to expose diagnostics.
    return false;
  }
}
