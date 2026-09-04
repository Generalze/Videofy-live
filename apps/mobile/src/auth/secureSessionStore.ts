/** @author masterzee001 */
/**
 * The ONLY thing in this app that touches a stored credential.
 *
 * WHY OWNERSHIP IS THE POINT. A session token is the whole account: anyone
 * holding one is signed in as that person until it expires. If three modules
 * know how to read it, three modules can leak it, log it, or forget to clear it
 * on sign-out -- and the one that forgets is discovered by a stranger, not by a
 * test. So exactly one module knows the storage key, and everything else asks
 * the session layer for an authenticated request rather than for the token.
 *
 * `expo-secure-store`, NEVER `AsyncStorage`. SecureStore is backed by the
 * Android Keystore and encrypted at rest; AsyncStorage is an unencrypted file
 * readable by anything with access to the app sandbox, including a rooted
 * device or a backup extraction. The two have almost identical APIs, which is
 * precisely how a credential ends up in the wrong one.
 *
 * NOTHING HERE LOGS, and that is not an oversight. There is no debug path that
 * prints a token, no error message that includes one, and no "just this once"
 * flag. A credential in a log survives in crash reports, in support tickets and
 * in screenshots long after the session has expired.
 */
import * as SecureStore from 'expo-secure-store';

/**
 * One key, one place.
 *
 * Namespaced so a future secret cannot collide with it, and never derived at a
 * call site -- a key built from a variable is a key somebody can get wrong.
 */
const SESSION_KEY = 'videofy.session.v1';

/**
 * What the server hands back from `POST /sessions`, plus when we received it.
 *
 * `receivedAtMs` is ours rather than the server's, and is used only to decide
 * whether a stored session is worth VALIDATING -- never to decide that it is
 * valid. Only the server can say that, because only the server checks `ver`
 * against the account, which is what makes "sign out everywhere" work.
 */
export interface StoredSession {
  readonly accountId: string;
  readonly token: string;
  readonly expiresInSeconds: number;
  readonly receivedAtMs: number;
}

/** Shape check for something read back from storage. */
function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['accountId'] === 'string' &&
    candidate['accountId'].length > 0 &&
    typeof candidate['token'] === 'string' &&
    candidate['token'].length > 0 &&
    typeof candidate['expiresInSeconds'] === 'number' &&
    typeof candidate['receivedAtMs'] === 'number'
  );
}

export interface SecureSessionStore {
  read(): Promise<StoredSession | null>;
  write(session: StoredSession): Promise<void>;
  /** Must succeed even when there is nothing stored. */
  clear(): Promise<void>;
}

export function createSecureSessionStore(
  storage: Pick<typeof SecureStore, 'getItemAsync' | 'setItemAsync' | 'deleteItemAsync'> = SecureStore,
): SecureSessionStore {
  return {
    async read(): Promise<StoredSession | null> {
      let raw: string | null;
      try {
        raw = await storage.getItemAsync(SESSION_KEY);
      } catch {
        /*
         * SecureStore can throw when the Keystore entry is unreadable -- after
         * a device restore, or a biometric change that invalidated the key.
         * Treated as "no session" rather than propagated: the person signs in
         * again, which works, instead of meeting a crash they cannot act on.
         */
        return null;
      }
      if (raw === null) return null;

      try {
        const parsed: unknown = JSON.parse(raw);
        /*
         * A stored value that no longer matches this shape is discarded rather
         * than coerced. Half a session is not a session, and guessing at the
         * missing half is how a request goes out with an empty token.
         */
        return isStoredSession(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    async write(session: StoredSession): Promise<void> {
      await storage.setItemAsync(SESSION_KEY, JSON.stringify(session));
    },

    async clear(): Promise<void> {
      try {
        await storage.deleteItemAsync(SESSION_KEY);
      } catch {
        /*
         * SWALLOWED DELIBERATELY. Clearing runs on sign-out, and sign-out must
         * always leave this device signed out. A throw here -- from an already
         * absent key, or an unreadable Keystore -- must not abort the caller
         * and leave a credential behind because tidying it up failed.
         */
      }
    },
  };
}
