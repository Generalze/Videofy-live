/** @author masterzee001 */
/**
 * The registered C7 home, at `/app/`.
 *
 * A different job from the public site, and therefore a different character:
 * the marketing pages are cinematic, this is operational. Somebody arriving
 * here should learn four things without reading: who they are, whether they are
 * verified, which workspace they are in, and what needs their attention.
 *
 * SECURITY NOTE. Everything rendered here is decided by the SERVER. The
 * capabilities in the bootstrap payload say what to SHOW; they never say what
 * is allowed. Every action is authorized again at the point it happens, because
 * a hidden button is courtesy and an unauthorized request is an attack.
 */
import { useEffect, useState } from 'react';
import { internalLink, type Route } from '../router';
import { ProfilePanel, type Profile } from '../ProfilePanel';
import { VerificationPanel } from '../VerificationPanel';
import { expireSession, readSessionToken } from '../session';
import { ContactsPanel } from '../ContactsPanel';
import { MessagesPanel } from '../MessagesPanel';
import { createAccountApi, type ContactPerson, type IncomingRing } from '../accountApi';

const ACCOUNT_URL = (
  (import.meta.env['VITE_ACCOUNT_URL'] as string | undefined) ?? 'http://localhost:3006'
).replace(/\/$/, '');

type VerificationState = 'unverified' | 'pending' | 'verified' | 'failed' | 'expired';

interface WorkspaceSummary {
  readonly workspaceId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly organizationId?: string;
  readonly role?: string;
  readonly state?: string;
  readonly entitlement?: { readonly enabled: boolean; readonly capabilities: readonly string[] };
}

interface OrganizationDetail {
  readonly displayName: string;
  readonly state: string;
  readonly packageId: string;
  readonly role: string | null;
  readonly seats: {
    readonly contracted: number;
    readonly activeMembers: number;
    readonly reservedByInvitations: number;
    readonly allocated: number;
    readonly available: number;
    readonly overCapacity: boolean;
  } | null;
}

interface Bootstrap {
  readonly accountId: string;
  readonly email: string;
  readonly trust: {
    readonly state: string;
    readonly email: VerificationState;
    readonly phone: VerificationState;
    readonly identity: VerificationState;
    readonly restriction: string;
  };
  readonly workspaces: readonly WorkspaceSummary[];
  readonly capabilities: readonly string[];
  /** The handle people add you by, and the name they see. Kept apart. */
  readonly profile: Profile;
}

const ROLE_LABEL: Record<string, string> = {
  'organization-owner': 'Owner',
  'organization-admin': 'Administrator',
  'billing-admin': 'Billing administrator',
  member: 'Member',
};

/**
 * The seat picture, straight from the server.
 *
 * Deliberately never computed here. Frontend seat arithmetic is how a UI ends
 * up confidently showing "1 seat left" while the server refuses the invitation.
 */
function SeatPanel({ seats }: { readonly seats: NonNullable<OrganizationDetail['seats']> }) {
  return (
    <article className={`app-card${seats.overCapacity ? ' app-card-warn' : ''}`}>
      <p className="domain-field">Seats</p>
      <p className="seat-headline">
        {seats.allocated} of {seats.contracted} allocated
      </p>
      <ul className="seat-breakdown">
        <li>
          <span>Active members</span>
          <span>{seats.activeMembers}</span>
        </li>
        <li>
          <span>Reserved by invitations</span>
          <span>{seats.reservedByInvitations}</span>
        </li>
        <li>
          <span>Available</span>
          <span>{seats.available}</span>
        </li>
      </ul>
      {seats.overCapacity ? (
        <p className="app-note">
          This organization is over capacity. Nobody has been removed — no new seat can be
          allocated until the plan covers the people already here.
        </p>
      ) : null}
    </article>
  );
}

function SignedOut({ navigate }: { readonly navigate: (route: Route, hash?: string) => void }) {
  return (
    <section className="app-gate">
      <div className="shell app-gate-shell">
        <p className="hero-eyebrow">Consummate 7</p>
        <h1 className="app-title">Sign in to C7</h1>
        <p className="section-lede">
          One account across every C7 product. Sign in to continue, or create an account.
        </p>
        <div className="hero-actions">
          {/*
            The public join section is the one signup surface. A second form
            here would be a second place the registration rules live, and the
            two would drift.
          */}
          <a className="button button-primary" {...internalLink('c7', navigate, '#join')}>
            Create a C7 account
          </a>
          <a className="button button-ghost" {...internalLink('c7', navigate, '#join')}>
            Sign in
          </a>
        </div>
      </div>
    </section>
  );
}

export function AppShell({ navigate }: { readonly navigate: (route: Route, hash?: string) => void }) {
  const [state, setState] = useState<'loading' | 'signed-out' | 'ready' | 'error'>('loading');
  /*
   * WHICH PART OF THE ACCOUNT IS ON SCREEN. The shell used to pour
   * verification prompts, identity settings and products onto one page, so
   * "signed in" landed somewhere that read as a settings form. A dashboard is
   * what signing in is FOR; profile and verification are places you go, not
   * things that ambush you.
   */
  const [view, setView] = useState<
    'overview' | 'contacts' | 'messages' | 'profile' | 'verification'
  >('overview');
  /** Set when Contacts says "Message": Messages opens on that thread. */
  const [chatPartner, setChatPartner] = useState<ContactPerson | null>(null);
  const [me, setMe] = useState<Bootstrap | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [organization, setOrganization] = useState<OrganizationDetail | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  /**
   * Incoming rings. The dashboard is a laptop's only ring surface -- there is
   * no push channel in a browser tab -- so while somebody is signed in here,
   * the shell polls and a call banner outranks whatever tab is open.
   */
  const [incomingRings, setIncomingRings] = useState<readonly IncomingRing[]>([]);
  const [callNotice, setCallNotice] = useState<string | null>(null);

  useEffect(() => {
    if (state !== 'ready') return;
    const token = readSessionToken();
    if (token === null) return;
    const api = createAccountApi(ACCOUNT_URL, token);
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const result = await api.rings();
      if (!cancelled && result.ok) setIncomingRings(result.value);
    };
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state]);

  /** Ring them, then open the call. Codes stay for conferences. */
  const callContact = (person: ContactPerson): void => {
    const token = readSessionToken();
    if (token === null) return;
    setCallNotice(null);
    void createAccountApi(ACCOUNT_URL, token)
      .ring(person.accountId)
      .then((result) => {
        if (!result.ok) {
          setCallNotice(result.error);
          return;
        }
        if (result.value.reachedDevices === 0) {
          // Their dashboard may still pick it up; the caller should know the
          // phone will not ring rather than sit waiting in an empty call.
          setCallNotice('No phone is registered for them — they will only see this if their C7 dashboard is open.');
        }
        window.open(`/call/?call=${encodeURIComponent(result.value.callId)}`, '_blank', 'noopener');
      });
  };

  const answerRing = (ring: IncomingRing, join: boolean): void => {
    const token = readSessionToken();
    setIncomingRings((current) => current.filter((entry) => entry.callId !== ring.callId));
    if (token !== null) void createAccountApi(ACCOUNT_URL, token).dismissRing(ring.callId);
    if (join) window.open(`/call/?call=${encodeURIComponent(ring.callId)}`, '_blank', 'noopener');
  };

  useEffect(() => {
    const token = readSessionToken();
    if (token === null) {
      /*
       * THE RESTRICTED AREA RESTRICTS. Arriving here without a session used
       * to park somebody on a static signed-out page; the coherent answer is
       * the join flow itself. replace() rather than assign() so Back does not
       * bounce them straight into the gate again.
       */
      setState('signed-out');
      window.location.replace('/#join');
      return;
    }
    let cancelled = false;
    void fetch(`${ACCOUNT_URL}/me`, { headers: { authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 401) {
          /*
           * A token the server refuses must not linger looking signed-in: the
           * nav and every product surface read these keys, and a stale one
           * keeps doors half-open. Clear both -- as an EXPIRY, so the join
           * page that follows can say why -- then join the flow.
           */
          expireSession();
          setState('signed-out');
          window.location.replace('/#join');
          return;
        }
        if (!response.ok) {
          setState('error');
          return;
        }
        const bootstrap = (await response.json()) as Bootstrap;
        setMe(bootstrap);
        setSelected(bootstrap.workspaces[0]?.workspaceId ?? null);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const current = me?.workspaces.find((workspace) => workspace.workspaceId === selected) ?? null;

  useEffect(() => {
    const token = readSessionToken();
    const organizationId = current?.organizationId;
    if (token === null || organizationId === undefined) {
      setOrganization(null);
      return;
    }
    let cancelled = false;
    void fetch(`${ACCOUNT_URL}/organizations/${organizationId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (cancelled) return;
        // A 404 here is the correct answer for a workspace this account is not
        // in — the server refuses identically whether it exists or not.
        setOrganization(response.ok ? ((await response.json()) as OrganizationDetail) : null);
      })
      .catch(() => {
        if (!cancelled) setOrganization(null);
      });
    return () => {
      cancelled = true;
    };
  }, [current?.organizationId]);

  if (state === 'loading') {
    return (
      <section className="app-gate">
        <div className="shell app-gate-shell">
          <p className="section-lede">Loading your C7 account…</p>
        </div>
      </section>
    );
  }

  if (state === 'signed-out') return <SignedOut navigate={navigate} />;

  if (state === 'error' || me === null) {
    return (
      <section className="app-gate">
        <div className="shell app-gate-shell">
          <h1 className="app-title">C7 is not reachable right now</h1>
          <p className="section-lede">Please try again in a moment.</p>
        </div>
      </section>
    );
  }

  /*
   * THE SERVER'S OWN ANSWER, not a re-derivation. `capabilities` comes from
   * grantedCapabilities on /me; gating the product grid on full verification
   * here is exactly how the dashboard became a verification nag -- an
   * email-verified account could host calls and was shown a checklist instead.
   */
  const canHost = me.capabilities.includes('session.host');
  const emailVerified = me.trust.email === 'verified';
  const restricted =
    me.trust.state === 'restricted' ||
    me.trust.state === 'suspended' ||
    me.trust.state === 'rejected';

  return (
    <section className="app">
      <div className="shell">
        {incomingRings.map((ring) => (
          <div key={ring.callId} className="ring-banner" role="alert">
            <span className="ring-banner-text">
              <strong>{ring.fromName}</strong> is calling you
            </span>
            <span className="contact-actions">
              <button
                type="button"
                className="button button-primary button-small"
                onClick={() => answerRing(ring, true)}
              >
                Join call
              </button>
              <button type="button" className="button button-small" onClick={() => answerRing(ring, false)}>
                Dismiss
              </button>
            </span>
          </div>
        ))}
        <header className="app-head">
          <div>
            <p className="hero-eyebrow">Your C7 account</p>
            <h1 className="app-title">{me.email}</h1>
          </div>
          <div className="app-workspace">
            <span className="app-workspace-label">Workspace</span>
            {/*
              Only workspaces the SERVER confirmed. Changing this selection can
              never create access: the next request is authorized against the
              membership list, not against what the page is showing.
            */}
            <select
              className="app-workspace-select"
              value={selected ?? ''}
              onChange={(event) => setSelected(event.target.value)}
            >
              {me.workspaces.map((workspace) => (
                <option key={workspace.workspaceId} value={workspace.workspaceId}>
                  {workspace.displayName}
                </option>
              ))}
            </select>
          </div>
        </header>

        {restricted ? (
          <div className="app-notice app-notice-restricted">
            <h2 className="app-notice-title">This account is restricted</h2>
            <p>
              You can review your verification status and contact support. Product access is
              paused while this is resolved.
            </p>
          </div>
        ) : null}

        {/*
          THE SHELL'S OWN ROOMS. Overview is the dashboard -- products and
          standing. Profile is identity. Verification is the checklist, visited
          on purpose. One page trying to be all three is what made signing in
          land on what read as a settings form.
        */}
        <nav className="app-tabs" aria-label="Account sections">
          {(
            [
              ['overview', 'Overview'],
              ['messages', 'Messages'],
              ['contacts', 'Contacts'],
              ['profile', 'Profile'],
              ['verification', 'Verification'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`app-tab${view === key ? ' app-tab-active' : ''}`}
              onClick={() => setView(key)}
            >
              {label}
              {key === 'verification' && !emailVerified ? (
                <span className="app-tab-dot" aria-label="action needed" />
              ) : null}
            </button>
          ))}
        </nav>

        {view === 'overview' && !emailVerified ? (
          <div className="app-notice">
            <p className="app-card-body">
              Verify your email to start calls, conferences and organizations. You can already
              join calls and message contacts.{' '}
              <button type="button" className="app-inline-link" onClick={() => setView('verification')}>
                Verify now
              </button>
            </p>
          </div>
        ) : null}

        {view === 'overview' ? (
          current?.kind === 'organization' ? (
            <div className="app-grid">
              <article className="app-card app-card-lead">
                <p className="domain-field">Organization</p>
                <h2 className="app-card-title">
                  {organization?.displayName ?? current.displayName}
                </h2>
                <p className="app-card-body">
                  {organization ? (
                    <>
                      {organization.packageId === 'enterprise' ? 'Enterprise' : 'Corporate'} ·{' '}
                      {organization.state === 'verified' ? 'Verified' : 'Verification required'}
                      {current.role ? ` · You are ${ROLE_LABEL[current.role] ?? current.role}` : ''}
                    </>
                  ) : (
                    'Loading…'
                  )}
                </p>
              </article>

              {organization?.seats ? <SeatPanel seats={organization.seats} /> : null}

              <article className="app-card">
                <p className="domain-field">Requires attention</p>
                {organization && organization.state !== 'verified' ? (
                  <p className="app-card-body">
                    Complete organization verification to invite staff and activate products.
                  </p>
                ) : (
                  <p className="app-empty">Nothing right now.</p>
                )}
              </article>
            </div>
          ) : (
            <div className="app-grid">
              <article className="app-card app-card-lead">
                <p className="domain-field">Available to you</p>
                <h2 className="app-card-title">VIDEOFY-LIVE</h2>
                <p className="app-card-body">
                  Real-time multilingual communication for calls, conferences and live
                  programmes.
                </p>
                <div className="hero-actions">
                  {canHost ? (
                    <a className="button button-primary" href="/call/">
                      Start a call
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={() => setView('verification')}
                    >
                      Verify email to start calls
                    </button>
                  )}
                  <a className="button button-ghost" href="/call/">
                    Join a call
                  </a>
                  <a className="button button-ghost" href="/listen/">
                    Programme viewer
                  </a>
                </div>
              </article>

              <article className="app-card">
                <p className="domain-field">Run a programme</p>
                <p className="app-card-body">
                  Broadcast with live translated audio for your audience.
                </p>
                <div className="hero-actions">
                  <a className="button button-ghost" href="/operator/">
                    Operator console
                  </a>
                </div>
              </article>

              <article className="app-card">
                <p className="domain-field">Recent activity</p>
                {/* An honest empty state. Inventing activity to fill a panel is
                    how a dashboard starts lying on its first day. */}
                <p className="app-empty">No recent activity yet.</p>
              </article>
            </div>
          )
        ) : null}

        {view === 'contacts' ? (
          <ContactsPanel
            accountUrl={ACCOUNT_URL}
            token={readSessionToken() ?? ''}
            onMessage={(person) => {
              setChatPartner(person);
              setView('messages');
            }}
            onCall={callContact}
          />
        ) : null}
        {callNotice !== null ? <p className="contact-notice">{callNotice}</p> : null}

        {view === 'messages' ? (
          <MessagesPanel
            accountUrl={ACCOUNT_URL}
            token={readSessionToken() ?? ''}
            selfId={me.accountId}
            initialPartner={chatPartner}
            onCall={callContact}
          />
        ) : null}

        {view === 'profile' ? (
          <ProfilePanel
            token={readSessionToken() ?? ''}
            accountId={me.accountId}
            profile={me.profile}
            onChanged={() => setRefreshKey((key) => key + 1)}
          />
        ) : null}

        {view === 'verification' ? (
          <div className="app-verify">
            <h2 className="app-notice-title">Verification</h2>
            <p className="section-lede">
              Your account exists. These steps establish that it belongs to you.
            </p>
            <VerificationPanel
              token={readSessionToken() ?? ''}
              email={me.email}
              emailState={me.trust.email}
              phoneState={me.trust.phone}
              identityState={me.trust.identity}
              // Re-read from the server after every step. The client never
              // decides it has become verified; it asks again.
              onChanged={() => setRefreshKey((key) => key + 1)}
            />
            <p className="app-note">
              Verifying your email unlocks starting calls, conferences and organizations. Phone
              and identity checks unlock commercial products. You can already join calls and
              manage your account.
            </p>
          </div>
        ) : null}

      </div>
    </section>
  );
}
