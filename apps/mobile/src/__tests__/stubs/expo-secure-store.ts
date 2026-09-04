/**
 * A stub that exists to be replaced.
 *
 * Every test injects its own storage, so reaching these throws means a test
 * used the real default instead of a fake -- which would silently pass while
 * testing nothing.
 */
export async function getItemAsync(): Promise<string | null> {
  throw new Error('expo-secure-store stub reached: inject a storage fake');
}
export async function setItemAsync(): Promise<void> {
  throw new Error('expo-secure-store stub reached: inject a storage fake');
}
export async function deleteItemAsync(): Promise<void> {
  throw new Error('expo-secure-store stub reached: inject a storage fake');
}
