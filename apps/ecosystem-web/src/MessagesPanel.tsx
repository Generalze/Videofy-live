/** @author masterzee001 */
/**
 * Messaging, on the web dashboard.
 *
 * The same conversations the phone sees, because they are the same server
 * rows: text both ways, voice notes playable, unread counts honest. The web
 * does not RECORD voice notes -- that stays a phone gesture -- but it must
 * play the ones it receives, or half of every conversation is a grey box.
 *
 * Voice audio is fetched WITH the auth header and played from an object URL,
 * because the media route is participant-checked and an <audio src> carries
 * no headers. URLs are revoked when the thread changes; a blob per note held
 * forever is a slow leak wearing headphones.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createAccountApi,
  personName,
  type ContactPerson,
  type ConversationEntry,
  type WireMessage,
} from './accountApi';

function formatDuration(durationMs: number | null): string {
  const total = Math.max(0, Math.round((durationMs ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function MessagesPanel({
  accountUrl,
  token,
  selfId,
  initialPartner,
}: {
  readonly accountUrl: string;
  readonly token: string;
  readonly selfId: string;
  /** Set when Contacts said "Message" -- opens that thread directly. */
  readonly initialPartner: ContactPerson | null;
}) {
  const [api] = useState(() => createAccountApi(accountUrl, token));
  const [conversations, setConversations] = useState<readonly ConversationEntry[] | null>(null);
  const [partner, setPartner] = useState<ContactPerson | null>(initialPartner);
  const [messages, setMessages] = useState<readonly WireMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [voiceUrls, setVoiceUrls] = useState<Record<string, string>>({});
  const voiceUrlsRef = useRef<Record<string, string>>({});

  const loadConversations = useCallback(async () => {
    const result = await api.conversations();
    if (result.ok) setConversations(result.value);
  }, [api]);

  const loadThread = useCallback(async () => {
    if (partner === null) return;
    const result = await api.messagesWith(partner.accountId);
    if (result.ok) {
      setMessages(result.value);
      void api.markRead(partner.accountId);
    }
  }, [api, partner]);

  useEffect(() => {
    void loadConversations();
    const timer = setInterval(() => void loadConversations(), 6000);
    return () => clearInterval(timer);
  }, [loadConversations]);

  useEffect(() => {
    setMessages([]);
    // Blob URLs from the previous thread are dead weight the moment it closes.
    for (const url of Object.values(voiceUrlsRef.current)) URL.revokeObjectURL(url);
    voiceUrlsRef.current = {};
    setVoiceUrls({});
    void loadThread();
    const timer = setInterval(() => void loadThread(), 4000);
    return () => clearInterval(timer);
  }, [loadThread]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (partner === null || body.length === 0) return;
    setDraft('');
    setNotice(null);
    const result = await api.sendText(partner.accountId, body);
    if (!result.ok) {
      setDraft(body);
      setNotice(result.error);
      return;
    }
    await loadThread();
    await loadConversations();
  }, [api, draft, loadConversations, loadThread, partner]);

  const fetchVoice = useCallback(
    async (messageId: string) => {
      const url = await api.voiceNoteUrl(messageId);
      if (url === null) {
        setNotice('That voice note could not be fetched.');
        return;
      }
      voiceUrlsRef.current = { ...voiceUrlsRef.current, [messageId]: url };
      setVoiceUrls(voiceUrlsRef.current);
    },
    [api],
  );

  return (
    <div className="app-messages">
      <aside className="messages-list">
        <p className="domain-field">Conversations</p>
        {conversations === null ? <p className="app-empty">Loading…</p> : null}
        {conversations !== null && conversations.length === 0 ? (
          <p className="app-empty">
            No conversations yet. Add a contact and say hello -- messages are free in normal
            mode.
          </p>
        ) : null}
        {conversations?.map((entry) => (
          <button
            key={entry.partner.accountId}
            type="button"
            className={`messages-item${
              partner?.accountId === entry.partner.accountId ? ' messages-item-active' : ''
            }`}
            onClick={() => setPartner(entry.partner)}
          >
            <span className="contact-name">{personName(entry.partner)}</span>
            <span className="messages-preview">
              {entry.last.kind === 'voice'
                ? `Voice note (${formatDuration(entry.last.mediaDurationMs)})`
                : (entry.last.body ?? '')}
            </span>
            {entry.unread > 0 ? <span className="messages-unread">{entry.unread}</span> : null}
          </button>
        ))}
      </aside>

      <section className="messages-thread">
        {partner === null ? (
          <p className="app-empty">Pick a conversation, or message somebody from Contacts.</p>
        ) : (
          <>
            <p className="domain-field">{personName(partner)}</p>
            <div className="messages-scroll">
              {[...messages].reverse().map((message) => (
                <div
                  key={message.messageId}
                  className={`bubble ${message.senderId === selfId ? 'bubble-mine' : 'bubble-theirs'}`}
                >
                  {message.kind === 'voice' ? (
                    voiceUrls[message.messageId] !== undefined ? (
                      <audio controls src={voiceUrls[message.messageId]} />
                    ) : (
                      <button
                        type="button"
                        className="button button-small"
                        onClick={() => void fetchVoice(message.messageId)}
                      >
                        Play voice note ({formatDuration(message.mediaDurationMs)})
                      </button>
                    )
                  ) : (
                    message.body
                  )}
                </div>
              ))}
            </div>
            {notice !== null ? <p className="contact-notice">{notice}</p> : null}
            <div className="messages-composer">
              <input
                className="contact-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Message"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void send();
                }}
              />
              <button
                type="button"
                className="button button-primary button-small"
                disabled={draft.trim().length === 0}
                onClick={() => void send()}
              >
                Send
              </button>
            </div>
            <p className="messages-footnote">
              Normal mode -- messages are free and not translated. Voice notes are recorded on
              the phone.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
