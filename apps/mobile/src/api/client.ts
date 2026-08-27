/** @author masterzee001 */
/**
 * The app's view of the account service, typed against contracts that were
 * READ, not guessed.
 *
 * Every function here takes the session layer's `authorizedFetch` -- the one
 * narrow capability push and messaging code are allowed to hold. Nothing in
 * this module can see a credential, store one, or log one; it shapes requests
 * and parses responses, and that is all.
 *
 * WHY THE SHAPES ARE SPELLED OUT LONGHAND. Four separate faults tonight came
 * from a client re-deriving a contract the server had already written down
 * (a guessed ack signature, a hand-built socket option, an invented id, an
 * ignored flag). These types are transcribed from the server routes, with the
 * route file named beside each, so the next drift is a diff against a named
 * source instead of an argument about memory.
 */
import type { AuthorizedFetch } from '../push/deviceRegistrationService';

/** A person as the contact and messaging routes describe them (routes.ts). */
export interface ContactPerson {
  readonly accountId: string;
  readonly username: string | null;
  readonly displayName: string | null;
}

export interface ContactsResponse {
  readonly contacts: readonly ContactPerson[];
  readonly requests: readonly (ContactPerson & { readonly requestedAtMs: number })[];
  readonly sent: readonly ContactPerson[];
}

/** A message as message-routes.ts sends it. `mediaPath` never crosses the wire. */
export interface WireMessage {
  readonly messageId: string;
  readonly senderId: string;
  readonly kind: 'text' | 'voice';
  /** Always the original words as typed. */
  readonly body: string | null;
  /** Present when the conversation was in translated mode at send time. */
  readonly translatedBody?: string | null;
  readonly translatedLanguage?: string | null;
  readonly mediaDurationMs: number | null;
  readonly createdAtMs: number;
  readonly readAtMs: number | null;
}

export interface ConversationEntry {
  readonly partner: ContactPerson;
  readonly last: WireMessage;
  readonly unread: number;
}

export interface VerificationStatus {
  readonly state: string;
  readonly email: string;
  readonly phone: string;
  readonly identity: string;
}

export interface Profile {
  readonly accountId: string;
  readonly email: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly defaultLanguage?: 'en' | 'es' | 'fr' | null;
  readonly official?: boolean;
}

/** One failure shape for the whole layer: what happened, and no credential. */
export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number | 'network'; readonly error: string };

async function request<T>(
  authorizedFetch: AuthorizedFetch,
  path: string,
  init: RequestInit | undefined,
  parse: (body: unknown) => T,
): Promise<ApiResult<T>> {
  let response: Response | null;
  try {
    response = await authorizedFetch(path, init);
  } catch {
    return { ok: false, status: 'network', error: 'Could not reach Videofy.' };
  }
  if (response === null) {
    return { ok: false, status: 401, error: 'Sign in to continue.' };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* some successes have empty bodies; failures below carry their own text */
  }
  if (!response.ok) {
    const message =
      typeof (body as { error?: unknown } | null)?.error === 'string'
        ? String((body as { error: string }).error)
        : 'That did not work. Try again.';
    return { ok: false, status: response.status, error: message };
  }
  return { ok: true, value: parse(body) };
}

const json = (value: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

export function createApi(authorizedFetch: AuthorizedFetch) {
  return {
    // ---- contacts (routes.ts) ------------------------------------------
    contacts: () =>
      request(authorizedFetch, '/contacts', undefined, (body) => body as ContactsResponse),
    requestContact: (username: string) =>
      request(authorizedFetch, '/contacts/request', json({ username }), () => undefined),
    acceptContact: (accountId: string) =>
      request(authorizedFetch, '/contacts/accept', json({ accountId }), () => undefined),
    blockContact: (accountId: string) =>
      request(authorizedFetch, '/contacts/block', json({ accountId }), () => undefined),
    removeContact: (accountId: string) =>
      request(authorizedFetch, '/contacts/remove', json({ accountId }), () => undefined),

    // ---- messaging (message-routes.ts) ---------------------------------
    conversations: () =>
      request(
        authorizedFetch,
        '/messages/conversations',
        undefined,
        (body) => (body as { conversations: ConversationEntry[] }).conversations,
      ),
    messagesWith: (accountId: string, beforeMs?: number) =>
      request(
        authorizedFetch,
        `/messages/with/${accountId}${beforeMs === undefined ? '' : `?before=${beforeMs}`}`,
        undefined,
        (body) => (body as { messages: WireMessage[] }).messages,
      ),
    sendText: (accountId: string, body: string) =>
      request(
        authorizedFetch,
        `/messages/with/${accountId}`,
        json({ body }),
        (reply) => (reply as { message: WireMessage }).message,
      ),
    sendVoice: (accountId: string, audioBase64: string, durationMs: number) =>
      request(
        authorizedFetch,
        `/messages/with/${accountId}/voice`,
        json({ audioBase64, durationMs }),
        (reply) => (reply as { message: WireMessage }).message,
      ),
    conversationMode: (accountId: string) =>
      request(
        authorizedFetch,
        `/messages/with/${accountId}/mode`,
        undefined,
        (body) => body as { mode: 'normal' | 'translated' },
      ),
    setConversationMode: (accountId: string, mode: 'normal' | 'translated') =>
      request(
        authorizedFetch,
        `/messages/with/${accountId}/mode`,
        json({ mode }),
        (body) => body as { mode: 'normal' | 'translated' },
      ),
    setDefaultLanguage: (defaultLanguage: 'en' | 'es' | 'fr') =>
      request(authorizedFetch, '/accounts/default-language', json({ defaultLanguage }), () => undefined),
    markRead: (accountId: string) =>
      request(authorizedFetch, `/messages/with/${accountId}/read`, json({}), () => undefined),

    // ---- ringing (message-routes.ts) -----------------------------------
    /*
     * The caller must ALREADY BE IN THE CALL when this fires: only a verified
     * account may create one, and ring-then-join would race the callee into
     * being the creator. The call screen joins first, then rings.
     */
    ring: (accountId: string, callId: string) =>
      request(
        authorizedFetch,
        `/contacts/${accountId}/ring`,
        json({ callId }),
        (reply) => reply as { callId: string; reachedDevices: number },
      ),

    // ---- profile and verification (routes.ts) --------------------------
    me: () =>
      request(authorizedFetch, '/me', undefined, (body) => {
        const raw = body as {
          accountId: string;
          email: string;
          profile?: {
            username?: string | null;
            displayName?: string | null;
            defaultLanguage?: 'en' | 'es' | 'fr' | null;
            official?: boolean;
          };
        };
        return {
          accountId: raw.accountId,
          email: raw.email,
          username: raw.profile?.username ?? null,
          displayName: raw.profile?.displayName ?? null,
          defaultLanguage: raw.profile?.defaultLanguage ?? null,
          official: raw.profile?.official ?? false,
        } satisfies Profile;
      }),
    setDisplayName: (displayName: string) =>
      request(authorizedFetch, '/accounts/display-name', json({ displayName }), () => undefined),
    /** avatar-routes.ts: PUT judges the bytes; DELETE clears. */
    setAvatar: (image: string) =>
      request(
        authorizedFetch,
        '/profile/avatar',
        { ...json({ image }), method: 'PUT' },
        () => undefined,
      ),
    removeAvatar: () =>
      request(authorizedFetch, '/profile/avatar', { method: 'DELETE' }, () => undefined),
    verification: () =>
      request(authorizedFetch, '/verification', undefined, (body) => body as VerificationStatus),
    sendVerificationEmail: () =>
      request(authorizedFetch, '/verification/email', json({}), () => undefined),
  };
}

export type Api = ReturnType<typeof createApi>;
