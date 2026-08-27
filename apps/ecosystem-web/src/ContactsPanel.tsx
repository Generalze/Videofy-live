/** @author masterzee001 */
/**
 * The contact graph, on the web dashboard.
 *
 * This is where "who added you" lives -- the question the dashboard previously
 * had no answer to anywhere. Requests FOR you come first because they are the
 * only rows here where somebody else is waiting on your decision; the server
 * already refuses to list your own requests as answerable, so this panel
 * cannot offer accepting yourself.
 *
 * The web now carries the same contact actions as the phone, which also
 * unblocks the two-account flow: accept a request here while the phone holds
 * the other side, instead of needing two phones.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  createAccountApi,
  personName,
  type ContactsResponse,
  type ContactPerson,
} from './accountApi';
import { Avatar } from './Avatar';

export function ContactsPanel({
  accountUrl,
  token,
  onMessage,
  onCall,
}: {
  readonly accountUrl: string;
  readonly token: string;
  readonly onMessage: (person: ContactPerson) => void;
  /** Rings the person and opens the call -- codes are for conferences. */
  readonly onCall: (person: ContactPerson) => void;
}) {
  const [api] = useState(() => createAccountApi(accountUrl, token));
  const [data, setData] = useState<ContactsResponse | null>(null);
  const [username, setUsername] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await api.contacts();
    if (result.ok) setData(result.value);
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  const add = useCallback(async () => {
    const handle = username.trim();
    if (handle.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await api.requestContact(handle);
    setNotice(result.ok ? 'Request sent.' : result.error);
    if (result.ok) setUsername('');
    await load();
    setBusy(false);
  }, [api, busy, load, username]);

  const act = useCallback(
    async (action: () => Promise<{ ok: boolean }>) => {
      setNotice(null);
      const result = await action();
      if (!result.ok && 'error' in result) setNotice(String((result as { error: string }).error));
      await load();
    },
    [load],
  );

  return (
    <div className="app-contacts">
      <article className="app-card">
        <p className="domain-field">Add a contact</p>
        <div className="contact-add-row">
          <input
            className="contact-input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="c7username"
            autoCapitalize="none"
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add();
            }}
          />
          <button
            type="button"
            className="button button-primary button-small"
            disabled={busy || username.trim().length === 0}
            onClick={() => void add()}
          >
            Add
          </button>
        </div>
        {notice !== null ? <p className="contact-notice">{notice}</p> : null}
      </article>

      {data !== null && data.requests.length > 0 ? (
        <article className="app-card">
          <p className="domain-field">Requests for you</p>
          {data.requests.map((person) => (
            <div key={person.accountId} className="contact-row">
              <span className="contact-name">
                <Avatar api={api} accountId={person.accountId} name={personName(person)} size={32} />
                {personName(person)}
              </span>
              <span className="contact-actions">
                <button
                  type="button"
                  className="button button-small button-primary"
                  onClick={() => void act(() => api.acceptContact(person.accountId))}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => void act(() => api.blockContact(person.accountId))}
                >
                  Block
                </button>
              </span>
            </div>
          ))}
        </article>
      ) : null}

      <article className="app-card">
        <p className="domain-field">Contacts</p>
        {data === null ? <p className="app-empty">Loading…</p> : null}
        {data !== null && data.contacts.length === 0 ? (
          <p className="app-empty">
            Nobody yet. Being contacts is what lets you ring, message and send voice notes to
            each other.
          </p>
        ) : null}
        {data?.contacts.map((person) => (
          <div key={person.accountId} className="contact-row">
            <span className="contact-name">
              <Avatar api={api} accountId={person.accountId} name={personName(person)} size={32} />
              {personName(person)}
              {person.username !== null ? (
                <span className="contact-handle"> {person.username}</span>
              ) : null}
            </span>
            <span className="contact-actions">
              <button
                type="button"
                className="button button-small button-primary"
                onClick={() => onCall(person)}
              >
                Call
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => onMessage(person)}
              >
                Message
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={() => void act(() => api.removeContact(person.accountId))}
              >
                Remove
              </button>
            </span>
          </div>
        ))}
      </article>

      {data !== null && data.sent.length > 0 ? (
        <article className="app-card">
          <p className="domain-field">Waiting for an answer</p>
          {data.sent.map((person) => (
            <div key={person.accountId} className="contact-row">
              <span className="contact-name">{personName(person)}</span>
              <span className="contact-pending">requested</span>
            </div>
          ))}
        </article>
      ) : null}
    </div>
  );
}
