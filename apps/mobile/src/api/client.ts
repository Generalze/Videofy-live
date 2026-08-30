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
/** Presence as the server tells it: only ever given for accepted contacts. */
export type PresenceState = 'active' | 'busy' | 'away';
export type Availability = 'auto' | 'busy' | 'away';

export interface ContactPerson {
  readonly accountId: string;
  readonly username: string | null;
  readonly displayName: string | null;
  /** A verified C7 account. */
  readonly official?: boolean;
  /** The language they speak (what a call sounds like); never the one they listen in. */
  readonly spokenLanguage?: string | null;
  /** Only present on accepted contacts; absent means "not yours to know". */
  readonly presence?: PresenceState;
}

/** GET /contacts/suggestions: people the viewer might know, never anyone already related. */
export interface SuggestedPerson extends ContactPerson {
  readonly mutualCount: number;
  readonly reason: 'mutual-contacts' | 'new-on-c7';
}

/** PUT /channels/:id/follow, GET /channels/follows. */
export interface ChannelFollow {
  readonly channelId: string;
  /** Push me when this channel goes live ("Interested"). */
  readonly remind: boolean;
}

/** GET /me/counts: the numbers on the profile. */
export interface MeCounts {
  readonly connections: number;
  readonly calls: number;
  readonly following: number;
  readonly saved: number;
}

export type ReportReason = 'spam' | 'harassment' | 'hate' | 'sexual' | 'violence' | 'abuse' | 'impersonation' | 'other';

export interface ContactsResponse {
  readonly contacts: readonly ContactPerson[];
  readonly requests: readonly (ContactPerson & { readonly requestedAtMs: number })[];
  readonly sent: readonly ContactPerson[];
}

import type { CallHistoryEntry } from '../call/callHistoryWords';

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
  /** Translated voice note: a derived rendition exists beside the original. */
  readonly translatedDurationMs?: number | null;
  readonly translatedAudioAvailable?: boolean;
  /** Message actions (founder ruling 29 Aug): what the server did to this message. */
  readonly editedAtMs?: number | null;
  readonly retractedAtMs?: number | null;
  readonly replyToMessageId?: string | null;
  readonly replyTo?: { readonly messageId: string; readonly senderId: string; readonly kind: 'text' | 'voice'; readonly preview: string } | null;
  readonly forwardedFrom?: { readonly messageId: string; readonly senderId: string } | null;
  readonly reactions?: readonly { readonly emoji: string; readonly count: number; readonly mine: boolean }[];
  readonly pinnedByMe?: boolean;
}

/**
 * A finished direct call, in the same timeline as the messages. The account
 * service records it from the gateway's telephone outcome; the chat shows it
 * between the messages so a missed call is found where a person looks.
 */
export type WireCallEntry = CallHistoryEntry;

/** What `GET /messages/with/:id` returns: messages and calls, newest first. */
export type TimelineItem = WireMessage | WireCallEntry;

export interface ConversationEntry {
  readonly partner: ContactPerson;
  readonly last: WireMessage;
  readonly unread: number;
  readonly muted?: boolean;
  readonly archived?: boolean;
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
  /*
   * A CATALOGUE CODE, not a three-way union.
   *
   * These were 'en' | 'es' | 'fr' on both sides of the wire, which is how the
   * Profile screen came to offer three languages while media ingest published
   * ninety-eight. The server validates against the shared catalogue; the type
   * here says what the server accepts.
   */
  readonly defaultLanguage?: string | null;
  readonly spokenLanguage?: string | null;
  readonly listeningLanguage?: string | null;
  readonly official?: boolean;
  /** Whether people can find this account by username (POST /accounts/discovery). */
  readonly discoverable: boolean;
  /** Up to 160 characters, shown on the person's profile. */
  readonly bio: string;
  /** 'auto' follows the heartbeat; 'busy' / 'away' override it for everyone. */
  readonly availability: Availability;
  /** Off = messages and live reminders arrive silently (calls still ring). */
  readonly notificationsEnabled: boolean;
}

/**
 * Another person, as the server lets THIS viewer see them. Relationship is
 * from the viewer's side; the language is the one they speak (what a call
 * sounds like), never the one they prefer to listen in.
 */
export interface PersonProfile {
  readonly accountId: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly official: boolean;
  readonly discoverable: boolean;
  readonly spokenLanguage: string | null;
  readonly relationship: 'contact' | 'requested' | 'incoming' | 'blocked' | 'none';
  readonly bio?: string;
  /** Only when relationship is 'contact'. */
  readonly presence?: PresenceState;
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

    // ---- social (social-routes.ts) -------------------------------------
    /** People the viewer might know: mutual contacts first, then new on C7. Never anyone already related. */
    suggestions: () =>
      request(authorizedFetch, '/contacts/suggestions', undefined, (body) => (body as { suggestions: SuggestedPerson[] }).suggestions),
    /** I am here (or busy). Sent while the app is in the foreground; 120 s without one reads as away. */
    heartbeat: (state: 'active' | 'busy') =>
      request(authorizedFetch, '/presence/heartbeat', json({ state }), () => undefined),
    /** Presence for accepted contacts only; ids that are not yours are simply absent. */
    presence: (ids: readonly string[]) =>
      request(authorizedFetch, `/presence?ids=${encodeURIComponent(ids.join(','))}`, undefined, (body) => (body as { presence: Record<string, PresenceState> }).presence),
    /** Bio, availability, notifications: PATCH what changed. */
    updateProfile: (input: { bio?: string; availability?: Availability; notificationsEnabled?: boolean }) =>
      request(authorizedFetch, '/profile', { ...json(input), method: 'PATCH' }, (body) => body as { bio: string; availability: Availability; notificationsEnabled: boolean }),
    /** Follow a channel; `remind` = push me when it goes live. Omitting remind keeps the earlier choice. */
    setFollow: (channelId: string, following: boolean, remind?: boolean) =>
      request(authorizedFetch, `/channels/${encodeURIComponent(channelId)}/follow`, { ...json({ following, ...(remind === undefined ? {} : { remind }) }), method: 'PUT' }, (body) => body as { following: boolean; remind: boolean }),
    follows: () =>
      request(authorizedFetch, '/channels/follows', undefined, (body) => (body as { follows: ChannelFollow[] }).follows),
    /** Public: how many people follow each channel. */
    channelInterest: (ids: readonly string[]) =>
      request(authorizedFetch, `/channels/interest?ids=${encodeURIComponent(ids.join(','))}`, undefined, (body) => (body as { counts: Record<string, number> }).counts),
    counts: () =>
      request(authorizedFetch, '/me/counts', undefined, (body) => body as MeCounts),

    // ---- messaging (message-routes.ts) ---------------------------------
    conversations: () =>
      request(
        authorizedFetch,
        '/messages/conversations',
        undefined,
        (body) => (body as { conversations: ConversationEntry[] }).conversations,
      ),
    profileOf: (accountId: string) =>
      request(
        authorizedFetch,
        `/profiles/${encodeURIComponent(accountId)}`,
        undefined,
        (body) => body as PersonProfile,
      ),
    messagesWith: (accountId: string, beforeMs?: number) =>
      request(
        authorizedFetch,
        `/messages/with/${accountId}${beforeMs === undefined ? '' : `?before=${beforeMs}`}`,
        undefined,
        (body) => (body as { messages: TimelineItem[] }).messages,
      ),
    sendText: (accountId: string, body: string, replyToMessageId?: string) =>
      request(
        authorizedFetch,
        `/messages/with/${accountId}`,
        json({ body, ...(replyToMessageId === undefined ? {} : { replyToMessageId }) }),
        (reply) => (reply as { message: WireMessage }).message,
      ),
    sendVoice: (accountId: string, audioBase64: string, durationMs: number, replyToMessageId?: string) =>
      request(
        authorizedFetch,
        `/messages/with/${accountId}/voice`,
        json({ audioBase64, durationMs, ...(replyToMessageId === undefined ? {} : { replyToMessageId }) }),
        (reply) => (reply as { message: WireMessage }).message,
      ),
    /* Message actions: each word means exactly what the server does. */
    forwardMessage: (toAccountId: string, messageId: string) =>
      request(authorizedFetch, `/messages/with/${toAccountId}/forward`, json({ messageId }), (reply) => (reply as { message: WireMessage }).message),
    editMessage: (messageId: string, body: string) =>
      request(authorizedFetch, `/messages/${encodeURIComponent(messageId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) }, (reply) => (reply as { message: WireMessage }).message),
    retractMessage: (messageId: string) =>
      request(authorizedFetch, `/messages/${encodeURIComponent(messageId)}/retract`, { method: 'POST' }, (reply) => (reply as { message: WireMessage }).message),
    hideMessage: (messageId: string) =>
      request(authorizedFetch, `/messages/${encodeURIComponent(messageId)}/hide`, { method: 'POST' }, () => undefined),
    unhideMessage: (messageId: string) =>
      request(authorizedFetch, `/messages/${encodeURIComponent(messageId)}/hide`, { method: 'DELETE' }, () => undefined),
    /** Report a person or one of their messages. Metadata only: ids, a reason, the reporter's words; never the content. */
    report: (input: { accountId: string; messageId?: string; reason: ReportReason; note?: string }) =>
      request(authorizedFetch, '/reports', json(input), (reply) => (reply as { reportId: string }).reportId),
    reactToMessage: (messageId: string, emoji: string | null) =>
      request(authorizedFetch, `/messages/${encodeURIComponent(messageId)}/reaction`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emoji }) }, (reply) => (reply as { reactions: readonly { emoji: string; count: number; mine: boolean }[] }).reactions),
    pinMessage: (messageId: string, pinned: boolean) =>
      request(authorizedFetch, `/messages/${encodeURIComponent(messageId)}/pin`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned }) }, (reply) => (reply as { pinnedByMe: boolean }).pinnedByMe),
    pinnedMessages: (accountId: string) =>
      request(authorizedFetch, `/messages/with/${accountId}/pinned`, undefined, (body) => (body as { messages: WireMessage[] }).messages),
    searchMessages: (accountId: string, q: string) =>
      request(authorizedFetch, `/messages/with/${accountId}/search?q=${encodeURIComponent(q)}`, undefined, (body) => (body as { messages: WireMessage[] }).messages),
    conversationSettings: (accountId: string, settings: { muted?: boolean; archived?: boolean }) =>
      request(authorizedFetch, `/messages/with/${accountId}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) }, (reply) => reply as { muted: boolean; archived: boolean }),
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
    setLanguages: (languages: {
      /** A catalogue code (routes.ts validates it against the shared catalogue). */
      spokenLanguage?: string;
      listeningLanguage?: string;
    }) => request(authorizedFetch, '/accounts/languages', json(languages), () => undefined),
    setDefaultLanguage: (defaultLanguage: string) =>
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
            defaultLanguage?: string | null;
            spokenLanguage?: string | null;
            listeningLanguage?: string | null;
            official?: boolean;
            discoverable?: boolean;
            bio?: string;
            availability?: Availability;
            notificationsEnabled?: boolean;
          };
        };
        return {
          accountId: raw.accountId,
          email: raw.email,
          username: raw.profile?.username ?? null,
          displayName: raw.profile?.displayName ?? null,
          defaultLanguage: raw.profile?.defaultLanguage ?? null,
          spokenLanguage: raw.profile?.spokenLanguage ?? null,
          listeningLanguage: raw.profile?.listeningLanguage ?? null,
          official: raw.profile?.official ?? false,
          discoverable: raw.profile?.discoverable === true,
          bio: raw.profile?.bio ?? '',
          availability: raw.profile?.availability ?? 'auto',
          notificationsEnabled: raw.profile?.notificationsEnabled !== false,
        } satisfies Profile;
      }),
    setDisplayName: (displayName: string) =>
      request(authorizedFetch, '/accounts/display-name', json({ displayName }), () => undefined),
    /** routes.ts POST /accounts/discovery: whether people can find you by username. Off is the default. */
    setDiscoverable: (discoverable: boolean) =>
      request(authorizedFetch, '/accounts/discovery', json({ discoverable }), (body) => body as { discoverable: boolean }),
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
