/** @author masterzee001 */
/**
 * Contacts and messaging, as the account service serves them to a browser.
 *
 * Transcribed from the same route files the mobile client names -- routes.ts
 * for contacts, message-routes.ts for messages -- so the two clients cannot
 * drift apart without the drift being a diff against a named source. Every
 * function takes the token explicitly; nothing here reads storage, because the
 * shell owns the session and this module owns only wire shapes.
 */

export interface ContactPerson {
  readonly accountId: string;
  readonly username: string | null;
  readonly displayName: string | null;
  /** The platform's own badge. Env-granted server-side; never client-set. */
  readonly official?: boolean;
}

export interface ContactsResponse {
  readonly contacts: readonly ContactPerson[];
  readonly requests: readonly (ContactPerson & { readonly requestedAtMs: number })[];
  readonly sent: readonly ContactPerson[];
}

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

export interface IncomingRing {
  readonly callId: string;
  readonly fromAccountId: string;
  readonly fromName: string;
  readonly atMs: number;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

async function request<T>(
  accountUrl: string,
  token: string,
  path: string,
  init: RequestInit | undefined,
  parse: (body: unknown) => T,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${accountUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: `Bearer ${token}`,
      },
    });
  } catch {
    return { ok: false, error: 'Could not reach C7.' };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* some replies are empty; failures carry their own sentence below */
  }
  if (!response.ok) {
    const message = (body as { error?: unknown } | null)?.error;
    return {
      ok: false,
      error: typeof message === 'string' ? message : 'That did not work. Try again.',
    };
  }
  return { ok: true, value: parse(body) };
}

const json = (value: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

/** Module-level: several panels share one signed-in identity per page. */
const avatarCache = new Map<string, { url: string | null; atMs: number }>();

export function createAccountApi(accountUrl: string, token: string) {
  return {
    contacts: () =>
      request(accountUrl, token, '/contacts', undefined, (body) => body as ContactsResponse),
    requestContact: (username: string) =>
      request(accountUrl, token, '/contacts/request', json({ username }), () => undefined),
    acceptContact: (accountId: string) =>
      request(accountUrl, token, '/contacts/accept', json({ accountId }), () => undefined),
    blockContact: (accountId: string) =>
      request(accountUrl, token, '/contacts/block', json({ accountId }), () => undefined),
    removeContact: (accountId: string) =>
      request(accountUrl, token, '/contacts/remove', json({ accountId }), () => undefined),

    conversations: () =>
      request(
        accountUrl,
        token,
        '/messages/conversations',
        undefined,
        (body) => (body as { conversations: ConversationEntry[] }).conversations,
      ),
    messagesWith: (accountId: string) =>
      request(
        accountUrl,
        token,
        `/messages/with/${accountId}`,
        undefined,
        (body) => (body as { messages: WireMessage[] }).messages,
      ),
    sendText: (accountId: string, body: string) =>
      request(
        accountUrl,
        token,
        `/messages/with/${accountId}`,
        json({ body }),
        (reply) => (reply as { message: WireMessage }).message,
      ),
    /**
     * Ring a contact: their phones get a push, their open dashboards a banner.
     * The server answers with the callId to open and how many phones it
     * reached -- zero is a real answer the caller should see.
     */
    ring: (accountId: string) =>
      request(
        accountUrl,
        token,
        `/contacts/${accountId}/ring`,
        json({}),
        (reply) => reply as { callId: string; reachedDevices: number },
      ),
    rings: () =>
      request(
        accountUrl,
        token,
        '/rings',
        undefined,
        (body) => (body as { rings: IncomingRing[] }).rings,
      ),
    dismissRing: (callId: string) =>
      request(accountUrl, token, `/rings/${encodeURIComponent(callId)}/dismiss`, json({}), () => undefined),
    conversationMode: (accountId: string) =>
      request(
        accountUrl,
        token,
        `/messages/with/${accountId}/mode`,
        undefined,
        (body) => body as { mode: 'normal' | 'translated'; billing: string },
      ),
    setConversationMode: (accountId: string, mode: 'normal' | 'translated') =>
      request(
        accountUrl,
        token,
        `/messages/with/${accountId}/mode`,
        json({ mode }),
        (body) => body as { mode: 'normal' | 'translated' },
      ),
    setLanguages: (languages: {
      spokenLanguage?: 'en' | 'es' | 'fr';
      listeningLanguage?: 'en' | 'es' | 'fr';
    }) => request(accountUrl, token, '/accounts/languages', json(languages), () => undefined),
    setDefaultLanguage: (defaultLanguage: 'en' | 'es' | 'fr') =>
      request(accountUrl, token, '/accounts/default-language', json({ defaultLanguage }), () => undefined),
    markRead: (accountId: string) =>
      request(accountUrl, token, `/messages/with/${accountId}/read`, json({}), () => undefined),

    /** Drop the cached picture so the next ask refetches (post-upload). */
    forgetAvatar: (accountId: string): void => {
      const cached = avatarCache.get(accountId);
      if (cached?.url) URL.revokeObjectURL(cached.url);
      avatarCache.delete(accountId);
    },

    /** The picture travels as a data URL; the server judges the bytes. */
    setAvatar: (image: string) =>
      request(accountUrl, token, '/profile/avatar', { ...json({ image }), method: 'PUT' }, () => undefined),
    removeAvatar: () =>
      request(accountUrl, token, '/profile/avatar', { method: 'DELETE' }, () => undefined),

    /**
     * A contact's picture as an object URL, or null when they have none.
     *
     * Fetched WITH the auth header -- an <img src> carries none -- and cached
     * per account for a minute, matching the server's own cache window. The
     * cache also remembers "no picture", or every poll would re-ask 404s.
     */
    avatarUrl: async (accountId: string): Promise<string | null> => {
      const cached = avatarCache.get(accountId);
      if (cached !== undefined && Date.now() - cached.atMs < 60_000) return cached.url;
      let url: string | null = null;
      try {
        const response = await fetch(`${accountUrl}/avatars/${accountId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (response.ok) url = URL.createObjectURL(await response.blob());
      } catch {
        /* no picture is the honest render for a failed fetch */
      }
      const previous = cached?.url;
      if (previous && previous !== url) URL.revokeObjectURL(previous);
      avatarCache.set(accountId, { url, atMs: Date.now() });
      return url;
    },

    /**
     * A voice note's audio, as an object URL a plain <audio> element plays.
     *
     * Fetched with the auth header rather than linked directly, because the
     * media route is participant-checked and an <audio src> carries no
     * headers. The caller owns revoking the URL when done with it.
     */
    voiceNoteUrl: async (messageId: string): Promise<string | null> => {
      try {
        const response = await fetch(`${accountUrl}/messages/media/${messageId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) return null;
        return URL.createObjectURL(await response.blob());
      } catch {
        return null;
      }
    },
  };
}

export type AccountApi = ReturnType<typeof createAccountApi>;

export function personName(person: ContactPerson): string {
  return person.displayName ?? person.username ?? person.accountId;
}
