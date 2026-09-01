/** @author masterzee001 */
/**
 * The signed-in Language Specialist portal, at `/specialist/`.
 *
 * IT RENDERS A DIV, NOT A <main>. App.tsx already wraps every route in one
 * `<main id="main">`; a second one nested a landmark inside a landmark and put
 * the same id on two elements, which left the skip link with an ambiguous
 * target. Every other page in this app renders into the shell's main.
 *
 * IT REUSES THE C7 SESSION AND BUILDS NO SECOND ONE. `session.ts` is the only
 * reader and writer of the two session keys on this origin; this shell asks it
 * for a token and hands that token to the API. There is no specialist login,
 * no specialist password and no specialist account table anywhere behind this
 * screen -- a Language Specialist is a role on a C7 account.
 *
 * THE RESTRICTED AREA RESTRICTS, and it restricts the same way the account
 * shell does: arriving without a session sends somebody to the join flow rather
 * than parking them on a static signed-out page. A 401 from any call does the
 * same, because a stored token outlives its lifetime in localStorage
 * indefinitely and only the server can say whether it is still honoured.
 *
 * WHAT IS SHOWN IS A COURTESY; WHAT IS ALLOWED IS RE-DECIDED SERVER-SIDE. The
 * rail hides nothing that would be a security boundary, and every action this
 * shell offers is authorized again at the point it happens. A hidden button is
 * politeness; an unauthorized request is an attack.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROUTE_PATHS, pathLink, usePathname, type Route } from '../router';
import { readSessionToken, expireSession, signOutEverywhere } from '../session';
import { createSpecialistApi, type Me, type ProgrammeLanguage, type SubmissionWire } from './api';
import { Assignments, Dashboard, Languages, Profile, Submissions } from './panels';
import { Qualification } from './Qualification';
import { Review } from './Review';
import { Notice } from './primitives';
import {
  PAGE_TITLES,
  PORTAL_PAGES,
  breadcrumb,
  pathForPage,
  viewFromPath,
  type PortalPage,
} from './route';

const ACCOUNT_URL = (
  (import.meta.env['VITE_ACCOUNT_URL'] as string | undefined) ?? 'http://localhost:3006'
).replace(/[/]$/u, '');

type Phase = 'loading' | 'ready' | 'signed-out' | 'error';

export function SpecialistPortal({
  navigate,
}: {
  readonly navigate: (route: Route, hash?: string) => void;
}) {
  const pathname = usePathname();
  const view = useMemo(() => viewFromPath(pathname), [pathname]);

  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [catalogue, setCatalogue] = useState<readonly ProgrammeLanguage[]>([]);
  const [submissions, setSubmissions] = useState<readonly SubmissionWire[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const token = readSessionToken();
  const api = useMemo(() => createSpecialistApi(ACCOUNT_URL, token), [token]);

  /**
   * Turn a 401 into the sign-in flow, once, from anywhere.
   *
   * `expireSession` clears BOTH session keys, so every other C7 surface on this
   * origin agrees that the session ended. Clearing one leaves the other signed
   * in, which is worse than clearing neither: the person believes they have
   * left while a product surface still holds their credential.
   */
  const signedOut = useCallback((): void => {
    expireSession();
    setPhase('signed-out');
  }, []);

  useEffect(() => {
    if (token === null) {
      /*
       * replace(), not assign(), so Back does not bounce straight back into a
       * page that will redirect again.
       */
      window.location.replace(`${ROUTE_PATHS.c7}#join`);
      return;
    }
    let cancelled = false;
    void (async () => {
      const [meResult, programmeResult, submissionsResult] = await Promise.all([
        api.me(),
        api.programme(),
        api.submissions(),
      ]);
      if (cancelled) return;
      if (!meResult.ok) {
        if ('unauthenticated' in meResult && meResult.unauthenticated) {
          signedOut();
          return;
        }
        setError(meResult.error);
        setPhase('error');
        return;
      }
      setMe(meResult.value);
      if (programmeResult.ok) setCatalogue(programmeResult.value.languages);
      if (submissionsResult.ok) setSubmissions(submissionsResult.value.submissions);
      setPhase('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [api, token, refreshKey, signedOut]);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  if (phase === 'signed-out') {
    return (
      <div className="page sp sp-gate">
        <div className="shell sp-gate-shell">
          <h1 className="sp-page-title">Your session has ended</h1>
          <p className="sp-page-lede">Sign in again to return to the specialist portal.</p>
          <a className="sp-button sp-button-primary" href={`${ROUTE_PATHS.c7}#join`}>
            Sign in
          </a>
        </div>
      </div>
    );
  }

  if (phase === 'loading' || me === null) {
    return (
      <div className="page sp">
        <div className="shell sp-gate-shell">
          <p className="sp-body sp-muted">Loading your specialist profile…</p>
          {error === null ? null : <Notice>{error}</Notice>}
        </div>
      </div>
    );
  }

  /**
   * Somebody who has not applied yet sees the application first.
   *
   * Not a redirect: a redirect would fight the URL they typed. The rail is still
   * there and every page is still reachable; the dashboard simply is not the
   * useful screen for a person with no profile, and pretending otherwise would
   * greet them with four empty tiles.
   */
  const effective = !me.applied && view.page === 'dashboard' ? { page: 'profile' as const } : view;

  const trail = breadcrumb(effective);

  return (
    <div className="page sp">
      <div className="sp-shell">
        <aside className="sp-rail" aria-label="Specialist">
          <p className="sp-rail-brand">
            <span className="sp-rail-mark">C7</span>
            <span className="sp-rail-title">Language Specialist</span>
          </p>
          <nav className="sp-rail-nav">
            {PORTAL_PAGES.map((page) => (
              <a
                key={page}
                className={`sp-rail-link${effective.page === page ? ' sp-rail-link-on' : ''}`}
                aria-current={effective.page === page ? 'page' : undefined}
                {...pathLink(pathForPage(page))}
              >
                <span>{PAGE_TITLES[page]}</span>
                {page === 'assignments' && pendingCount(me) > 0 ? (
                  <span className="sp-rail-count">{pendingCount(me)}</span>
                ) : null}
              </a>
            ))}
          </nav>
          <div className="sp-rail-foot">
            <a className="sp-rail-link" href="mailto:languages@consummate7.com">
              Help &amp; guidelines
            </a>
            {/* `pathLink` supplies the href; a second one here would be dead code
                that silently loses to the spread. */}
            <a className="sp-rail-link" {...pathLink(ROUTE_PATHS['language-specialists'])}>
              About the programme
            </a>
            <button
              className="sp-rail-link sp-rail-signout"
              type="button"
              onClick={() => void signOutEverywhere(ACCOUNT_URL)}
            >
              Sign out
            </button>
          </div>
        </aside>

        <div className="sp-main">
          <nav className="sp-crumbs" aria-label="Breadcrumb">
            <a {...pathLink(pathForPage('dashboard'))}>c7</a>
            {trail.map((crumb, index) => (
              <span key={`${crumb}-${index}`}>
                <span className="sp-crumb-sep">/</span>
                {crumb}
              </span>
            ))}
          </nav>

          {error === null ? null : <Notice>{error}</Notice>}

          {effective.page === 'dashboard' ? <Dashboard me={me} /> : null}

          {effective.page === 'profile' ? (
            <Profile
              me={me}
              busy={busy === 'profile'}
              error={error}
              onApply={(input) => {
                setBusy('profile');
                setError(null);
                void api
                  .apply({
                    motivation: input.motivation,
                    ...(input.country.length === 0 ? {} : { country: input.country }),
                    ...(input.timeZone.length === 0 ? {} : { timeZone: input.timeZone }),
                  })
                  .then((result) => {
                    setBusy(null);
                    if (result.ok) {
                      refresh();
                      return;
                    }
                    if ('unauthenticated' in result && result.unauthenticated) signedOut();
                    else setError(result.error);
                  });
              }}
            />
          ) : null}

          {effective.page === 'languages' ? (
            <Languages
              me={me}
              catalogue={catalogue}
              busy={busy}
              error={error}
              onApplyForLanguage={(language) => {
                setBusy(language);
                setError(null);
                void api.applyForLanguage(language).then((result) => {
                  setBusy(null);
                  if (result.ok) {
                    refresh();
                    return;
                  }
                  if ('unauthenticated' in result && result.unauthenticated) signedOut();
                  else setError(result.error);
                });
              }}
            />
          ) : null}

          {effective.page === 'qualification' ? (
            'language' in effective ? (
              <Qualification
                api={api}
                language={effective.language}
                track={me.tracks.find((track) => track.language === effective.language)}
                onChanged={refresh}
              />
            ) : (
              <QualificationOverview me={me} />
            )
          ) : null}

          {effective.page === 'assignments' ? (
            'assignmentId' in effective ? (
              <Review api={api} assignmentId={effective.assignmentId} onChanged={refresh} />
            ) : (
              <Assignments assignments={me.assignments} />
            )
          ) : null}

          {effective.page === 'submissions' ? <Submissions submissions={submissions} /> : null}
        </div>
      </div>
    </div>
  );
}

function pendingCount(me: Me): number {
  return me.assignments.filter((assignment) => assignment.state !== 'SUBMITTED').length;
}

/**
 * Qualification, across every language at once.
 *
 * Its own screen rather than a section of the dashboard, because "where do I
 * stand, in each language, and what is the next thing to do" is the question
 * this programme is most often asked and it deserves an address.
 */
function QualificationOverview({ me }: { readonly me: Me }) {
  return (
    <>
      <header className="sp-page-head">
        <h1 className="sp-page-title">Qualification</h1>
        <p className="sp-page-lede">
          Every language is assessed on its own. Qualifying in one says nothing about another.
        </p>
      </header>
      {me.tracks.length === 0 ? (
        <p className="sp-body sp-muted">
          No languages yet. Choose one on the{' '}
          <a className="sp-link" {...pathLink(pathForPage('languages'))}>
            Languages
          </a>{' '}
          page.
        </p>
      ) : (
        <div className="sp-language-grid">
          {me.tracks.map((track) => (
            <article className="sp-card" key={track.language}>
              <h2 className="sp-language-native">{track.nativeName}</h2>
              <p className="sp-language-english">{track.englishName}</p>
              <dl className="sp-facts">
                <div>
                  <dt>Status</dt>
                  <dd>{track.state.replace(/_/gu, ' ').toLowerCase()}</dd>
                </div>
                <div>
                  <dt>Attempt</dt>
                  <dd>{track.attempt}</dd>
                </div>
                <div>
                  <dt>Source messages</dt>
                  <dd>
                    {track.requiresSourceElicitation
                      ? `${track.elicitation.answered} / ${track.elicitation.total}`
                      : 'Not required'}
                  </dd>
                </div>
                <div>
                  <dt>Blind review</dt>
                  <dd>{track.review.unlocked ? 'Open' : 'Locked'}</dd>
                </div>
              </dl>
              {track.review.message === null ? null : (
                <p className="sp-body sp-muted">{track.review.message}</p>
              )}
              {track.requiresSourceElicitation && !track.elicitation.frozen ? (
                <a
                  className="sp-button sp-button-primary"
                  {...pathLink(`/specialist/qualification/${track.language}/elicitation/`)}
                >
                  {track.elicitation.answered === 0 ? 'Start elicitation' : 'Continue elicitation'}
                </a>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </>
  );
}

/** The tab title for the portal. Exported so App.tsx has one source for it. */
export function portalTitle(pathname: string): string {
  const view = viewFromPath(pathname);
  const page: PortalPage = view.page;
  return `${PAGE_TITLES[page]} — C7 Language Specialist`;
}
