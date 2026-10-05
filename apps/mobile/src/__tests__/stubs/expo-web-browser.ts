/** @author masterzee001 */
/**
 * Stub for expo-web-browser.
 *
 * DELIBERATELY USELESS, like the expo-secure-store stub beside it. The real
 * module opens a system browser, which a node test cannot do and should not
 * pretend to -- anything reaching this is a test asserting something it has
 * no way to observe. Tests that need an outcome inject one.
 */
export function maybeCompleteAuthSession(): void {}

export async function openAuthSessionAsync(): Promise<never> {
  throw new Error(
    'expo-web-browser stub: a test reached the real browser session; inject the outcome instead',
  );
}
