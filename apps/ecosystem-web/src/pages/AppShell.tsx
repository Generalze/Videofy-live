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
import { clearSessionKeys } from '../session';

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

/** The token the sign-in flow stored. Absent means "not signed in here". */
function storedToken(): string | null {
  try {
    return window.localStorage.getItem('c7.session') ?? null;
  } catch {
    return null;
  }
}

/**
 * Sign out of this browser.
 *
 * LOCAL FIRST, AND UNCONDITIONALLY. The server is told so the session is
 * revoked everywhere, but that is best effort: somebody who taps sign out on a
 * flaky connection must end up signed out HERE regardless. A sign-out that can
 * fail is a sign-out people stop trusting.
 *
 * BOTH KEYS, because a browser session currently lives under two of them --
 * `c7.session` for this app and `videofy-account:session` for the call app.
 * Clearing one would leave the other signed in, which is worse than not
 * clearing at all: the person believes they have left and the call app still
 * holds their credential. Unifying the two is the recorded follow-up; until
 * then, anything that clears one MUST clear both.
 */
async function signOut(accountUrl: string, token: string | null): Promise<void> {
  try {
    window.localStorage.removeItem('c7.session');
    window.localStorage.removeItem('videofy-account:session');
  } catch {
    /* storage unavailable; there was nothing persisted to clear */
  }

  if (token !== null) {
    try {
      await fetch(`${accountUrl}/sessions`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      // Already signed out locally. The server session ages out on its own.
    }
  }

  window.location.assign('/');
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
  const [me, setMe] = useState<Bootstrap | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [organization, setOrganization] = useState<OrganizationDetail | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const token = storedToken();
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
           * keeps doors half-open. Clear both, then join the flow.
           */
          clearSessionKeys();
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
    const token = storedToken();
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

  const verified = me.trust.state === 'verified';
  const restricted =
    me.trust.state === 'restricted' ||
    me.trust.state === 'suspended' ||
    me.trust.state === 'rejected';

  return (
    <section className="app">
      <div className="shell">
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
            <button
              className="button button-small app-signout"
              type="button"
              onClick={() => void signOut(ACCOUNT_URL, storedToken())}
            >
              Sign out
            </button>
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

        {current?.kind === 'organization' ? (
          <div className="app-grid">
            <article className="app-card app-card-lead">
              <p className="domain-field">Organization</p>
              <h2 className="app-card-title">{organization?.displayName ?? current.displayName}</h2>
              <p className="app-card-body">
                {/* Package and standing, stated plainly. An unverified
                    organization says so rather than looking finished. */}
                {organization ? (
                  <>
                    {organization.packageId === 'enterprise' ? 'Enterprise' : 'Corporate'} ·{' '}
                    {organization.state === 'verified'
                      ? 'Verified'
                      : 'Verification required'}
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
        ) : verified ? (
          <div className="app-grid">
            <article className="app-card app-card-lead">
              <p className="domain-field">Available to you</p>
              <h2 className="app-card-title">VIDEOFY-LIVE</h2>
              <p className="app-card-body">
                Real-time multilingual communication for calls, conferences and live programmes.
              </p>
              <div className="hero-actions">
                <a className="button button-primary" href="/call/">
                  Start a call
                </a>
                <a className="button button-ghost" href="/listen/">
                  Programme viewer
                </a>
              </div>
            </article>

            <article className="app-card">
              <p className="domain-field">Recent activity</p>
              {/* An honest empty state. Inventing activity to fill a panel is
                  how a dashboard starts lying on its first day. */}
              <p className="app-empty">No recent activity yet.</p>
            </article>

            <article className="app-card">
              <p className="domain-field">Early access</p>
              <p className="app-empty">Nothing open right now.</p>
            </article>
          </div>
        ) : (
          <div className="app-verify">
            <h2 className="app-notice-title">Complete verification to activate C7 products</h2>
            <p className="section-lede">
              Your account exists. These three steps establish that it belongs to you.
            </p>
            <VerificationPanel
              token={storedToken() ?? ''}
              email={me.email}
              emailState={me.trust.email}
              phoneState={me.trust.phone}
              identityState={me.trust.identity}
              // Re-read from the server after every step. The client never
              // decides it has become verified; it asks again.
              onChanged={() => setRefreshKey((key) => key + 1)}
            />
            <p className="app-note">
              {/*
                The REAL rule, per trustCapabilities: email alone unlocks
                hosting and organizations; phone and identity gate commercial
                products. The previous copy claimed all three were needed to
                host a call, which sent verified people hunting for checks that
                gate nothing they wanted.
              */}
              Verifying your email unlocks starting calls, conferences and organizations. Phone
              and identity checks unlock commercial products. You can already join calls and
              manage your account.
            </p>
          </div>
        )}

        {/*
          * Shown whatever the verification state is. Your identity is not a
          * reward for finishing verification -- it is the thing you arrive
          * wanting to see, and the handle is what you hand out to be added.
          */}
        <ProfilePanel
          token={storedToken() ?? ''}
          profile={me.profile}
          onChanged={() => setRefreshKey((key) => key + 1)}
        />
      </div>
    </section>
  );
}
