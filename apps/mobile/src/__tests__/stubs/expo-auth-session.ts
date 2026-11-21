/** @author masterzee001 */
/** Stub for expo-auth-session. See expo-web-browser.ts for why. */
export function makeRedirectUri(options: { scheme?: string; path?: string }): string {
  return `${options.scheme ?? 'app'}://${options.path ?? ''}`;
}
