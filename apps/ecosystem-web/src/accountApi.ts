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
  readonly body: string | null;
  readonly mediaDurationMs: number | null;
  readonly createdAtMs: number;
  readonly readAtMs: number | null;
}

export interface ConversationEntry {
  readonly partner: ContactPerson;
  readonly last: WireMessage;
  readonly unread: number;
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
    markRead: (accountId: string) =>
      request(accountUrl, token, `/messages/with/${accountId}/read`, json({}), () => undefined),

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
