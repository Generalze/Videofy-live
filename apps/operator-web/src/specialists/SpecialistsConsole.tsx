/** @author masterzee001 */
/**
 * `/operator/language-specialists` — applicants, evidence and outcomes.
 *
 * AUTHORIZATION IS NOT DECIDED HERE AND CANNOT BE. Every call goes to
 * `/admin/language-specialists/*`, which admits only an account on the platform
 * operator allowlist that is ALSO currently verified. The console has no
 * allowlist of its own, no role check of its own and no debug flag: it renders
 * whatever the server is willing to answer with, and shows the not-found screen
 * when the server declines. That is the only arrangement in which "reuse the
 * existing authorization" means anything -- a frontend gate beside a backend
 * gate is a second policy, and the two disagree eventually.
 *
 * AN OUTCOME REQUIRES A STATED REASON, and the form refuses without one for the
 * same reason the endpoint does: a qualification that changed because somebody
 * clicked something is not a record anybody can defend to the person it was
 * about.
 *
 * THE EVIDENCE IS BEHIND A DELIBERATE CLICK. The list view carries no applicant
 * writing at all; opening the corpus is a separate request, and the server
 * audits it. Putting the messages in the list would mean every applicant's
 * writing crossed the wire every time anybody opened the console.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { readAccountUrl } from '../premium/channelIdentity';
import { readSession } from '../premium/operatorSession';
import styles from './specialists.module.css';
import {
  createSpecialistAdminApi,
  dayWord,
  stateTone,
  stateWord,
  type ApplicantDetail,
  type ApplicantList,
  type ApplicantRow,
  type Evidence,
} from './api';
import { go, pathForApplicant, pathForApplicants, viewFromPath } from './route';

/** Read the path on every history event; see route.ts on the synthetic popstate. */
function usePathname(): string {
  const [path, setPath] = useState(() =>
    typeof window === 'undefined' ? '/' : window.location.pathname,
  );
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

function Chip({ state }: { readonly state: string }) {
  /* Colour tints; the word carries the meaning. Never colour alone. */
  return <span className={`${styles.chip} ${styles[`chip-${stateTone(state)}`]}`}>{stateWord(state)}</span>;
}

export function SpecialistsConsole() {
  const pathname = usePathname();
  const view = useMemo(() => viewFromPath(pathname), [pathname]);
  const accountUrl = readAccountUrl();
  const token = readSession()?.token ?? null;
  const api = useMemo(
    () => createSpecialistAdminApi(accountUrl, token),
    [accountUrl, token],
  );

  const [forbidden, setForbidden] = useState(false);

  if (forbidden) {
    return (
      <main className={styles.shell}>
        <div className={styles.gate}>
          <h1 className={styles.title}>Not found</h1>
          <p className={styles.lede}>
            This console is available to platform operators. If you believe you should have access,
            write to languages@consummate7.com — the reason for a refusal is in the service audit
            log, not on this page.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <a
          href={pathForApplicants()}
          onClick={(event) => {
            event.preventDefault();
            go(pathForApplicants());
          }}
        >
          operator
        </a>
        <span className={styles.crumbSep}>/</span>
        <span>language-specialists</span>
        {view.page === 'applicant' ? (
          <>
            <span className={styles.crumbSep}>/</span>
            <span>{view.accountId}</span>
          </>
        ) : null}
      </nav>

      {view.page === 'applicants' ? (
        <Applicants api={api} onForbidden={() => setForbidden(true)} />
      ) : (
        <Applicant
          api={api}
          accountId={view.accountId}
          onForbidden={() => setForbidden(true)}
        />
      )}
    </main>
  );
}

/* ------------------------------------------------------------- applicants */

function Applicants({
  api,
  onForbidden,
}: {
  readonly api: ReturnType<typeof createSpecialistAdminApi>;
  readonly onForbidden: () => void;
}) {
  const [list, setList] = useState<ApplicantList | null>(null);
  const [language, setLanguage] = useState('all');
  const [state, setState] = useState('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    void api.applicants().then((result) => {
      if (cancelled) return;
      if (result.ok) setList(result.value);
      else if (result.forbidden === true) onForbidden();
    });
    return () => {
      cancelled = true;
    };
  }, [api, onForbidden]);

  if (list === null) return <p className={styles.lede}>Loading applicants…</p>;

  const languages = [...new Set(list.applicants.flatMap((a) => a.languages.map((l) => l.language)))];
  const rows = list.applicants.filter((applicant) => {
    if (language !== 'all' && !applicant.languages.some((l) => l.language === language)) return false;
    if (state !== 'all' && !applicant.languages.some((l) => l.state === state)) return false;
    /*
     * Filtered on the ACCOUNT ID, which is the only identifier this view has.
     * It does not fetch names or addresses, and a search box that quietly
     * needed them would be a reason to start collecting them.
     */
    if (query.length > 0 && !applicant.accountId.toLowerCase().includes(query.toLowerCase())) {
      return false;
    }
    return true;
  });

  return (
    <>
      <header className={styles.head}>
        <div>
          <h1 className={styles.title}>Language specialists</h1>
          <p className={styles.lede}>
            {list.applicants.length} applicant{list.applicants.length === 1 ? '' : 's'}. Qualification
            is decided per language.
          </p>
        </div>
      </header>

      <div className={styles.filters}>
        <label className={styles.filter}>
          <span>Language</span>
          <select value={language} onChange={(event) => setLanguage(event.target.value)}>
            <option value="all">All languages</option>
            {languages.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filter}>
          <span>Status</span>
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="all">All statuses</option>
            {/* The server's list, so a state added there appears here. */}
            {list.states.map((entry) => (
              <option key={entry} value={entry}>
                {stateWord(entry)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filter}>
          <span>Search</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Account id"
          />
        </label>
      </div>

      {rows.length === 0 ? (
        <p className={styles.empty}>No applicant matches these filters.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Applicant</th>
                <th scope="col">Languages</th>
                <th scope="col">Applied</th>
                <th scope="col">Last activity</th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((applicant) => (
                <ApplicantRowView key={applicant.accountId} applicant={applicant} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ApplicantRowView({ applicant }: { readonly applicant: ApplicantRow }) {
  return (
    <tr>
      <td>
        <span className={styles.mono}>{applicant.accountId}</span>
        <span className={styles.sub}>
          {applicant.country ?? '—'}
          {applicant.timeZone === null ? '' : ` · ${applicant.timeZone}`}
        </span>
      </td>
      <td>
        <div className={styles.langCell}>
          {applicant.languages.length === 0 ? (
            <span className={styles.sub}>No languages opened</span>
          ) : (
            applicant.languages.map((language) => (
              <span className={styles.langPair} key={language.language}>
                <span className={styles.langName}>{language.englishName}</span>
                <Chip state={language.state} />
              </span>
            ))
          )}
        </div>
      </td>
      <td>{dayWord(applicant.appliedAtMs)}</td>
      <td>{dayWord(applicant.updatedAtMs)}</td>
      <td>
        <a
          className={styles.button}
          href={pathForApplicant(applicant.accountId)}
          onClick={(event) => {
            event.preventDefault();
            go(pathForApplicant(applicant.accountId));
          }}
        >
          Review
        </a>
      </td>
    </tr>
  );
}

/* --------------------------------------------------------------- applicant */

function Applicant({
  api,
  accountId,
  onForbidden,
}: {
  readonly api: ReturnType<typeof createSpecialistAdminApi>;
  readonly accountId: string;
  readonly onForbidden: () => void;
}) {
  const [detail, setDetail] = useState<ApplicantDetail | null>(null);
  const [openLanguage, setOpenLanguage] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    let cancelled = false;
    void api.applicant(accountId).then((result) => {
      if (cancelled) return;
      if (result.ok) setDetail(result.value);
      else if (result.forbidden === true) onForbidden();
      else setNotice(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [api, accountId, onForbidden, refreshKey]);

  useEffect(() => {
    if (openLanguage === null) {
      setEvidence(null);
      return;
    }
    let cancelled = false;
    void api.evidence(accountId, openLanguage).then((result) => {
      if (cancelled) return;
      if (result.ok) setEvidence(result.value);
      else if (result.forbidden === true) onForbidden();
      else setNotice(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [api, accountId, openLanguage, onForbidden]);

  if (detail === null) return <p className={styles.lede}>Loading applicant…</p>;

  return (
    <>
      <header className={styles.head}>
        <div>
          <h1 className={styles.title}>Applicant</h1>
          <p className={`${styles.lede} ${styles.mono}`}>{detail.accountId}</p>
        </div>
      </header>

      {notice === null ? null : <p className={styles.notice}>{notice}</p>}

      <div className={styles.columns}>
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Overview</h2>
          <dl className={styles.facts}>
            <div>
              <dt>Application</dt>
              <dd>{stateWord(detail.progress)}</dd>
            </div>
            <div>
              <dt>Applied</dt>
              <dd>{dayWord(detail.appliedAtMs)}</dd>
            </div>
            <div>
              <dt>Country</dt>
              <dd>{detail.country ?? '—'}</dd>
            </div>
            <div>
              <dt>Time zone</dt>
              <dd>{detail.timeZone ?? '—'}</dd>
            </div>
          </dl>
          <p className={styles.subhead}>In their words</p>
          {/*
            Shown to the operator who is deciding. It is never written to a log
            line — the service emits ids and counts only.
          */}
          <p className={styles.quote}>{detail.motivation}</p>
        </section>

        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Voice participation</h2>
          <p className={styles.lede}>
            {stateWord(detail.voice.state)}. Voice rights granted:{' '}
            {detail.voice.voiceRightsGranted ? 'yes' : 'no'}.
          </p>
          <p className={styles.sub}>
            The permission this applicant gave covers the text they wrote. It grants no voice right
            of any kind, and there is no action on this page that can change that.
          </p>
        </section>
      </div>

      <h2 className={styles.sectionTitle}>Languages</h2>
      {detail.languages.length === 0 ? (
        <p className={styles.empty}>This applicant has not opened a language track.</p>
      ) : (
        detail.languages.map((track) => (
          <section className={styles.panel} key={track.language}>
            <header className={styles.trackHead}>
              <div>
                <h3 className={styles.panelTitle}>{track.englishName}</h3>
                <p className={styles.sub}>
                  attempt {track.attempt} · applied {dayWord(track.appliedAtMs)}
                </p>
              </div>
              <Chip state={track.state} />
            </header>

            <dl className={styles.facts}>
              <div>
                <dt>Attempt</dt>
                {/*
                  Shown because evidence is keyed by it. A fingerprint without
                  the attempt it belongs to cannot be reconciled with anything.
                */}
                <dd>{track.attempt}</dd>
              </div>
              <div>
                <dt>
                  {track.source.kind === 'ELICITATION' ? 'Source messages' : 'Source checked'}
                </dt>
                <dd>
                  {track.source.total === 0
                    ? 'not supplied'
                    : `${track.source.answered} / ${track.source.total}`}
                  {track.source.frozen ? ' · frozen' : ''}
                </dd>
              </div>
              <div>
                <dt>Blind review</dt>
                <dd>{track.reviewUnlocked ? 'Open' : 'Locked'}</dd>
              </div>
              <div>
                <dt>Source fingerprint</dt>
                <dd className={`${styles.mono} ${styles.hash}`}>{track.source.sha256 ?? '—'}</dd>
              </div>
            </dl>

            <div className={styles.actions}>
              <button
                className={styles.button}
                type="button"
                onClick={() =>
                  setOpenLanguage((current) => (current === track.language ? null : track.language))
                }
              >
                {openLanguage === track.language ? 'Hide evidence' : 'Inspect evidence'}
              </button>
            </div>

            {openLanguage === track.language && evidence !== null ? (
              <EvidencePanel evidence={evidence} />
            ) : null}

            {track.reviewUnlocked ? (
              <IssueAssignmentForm
                api={api}
                accountId={accountId}
                language={track.language}
                onDone={(message) => {
                  setNotice(message);
                  load();
                }}
              />
            ) : null}

            <DecisionForm
              api={api}
              accountId={accountId}
              language={track.language}
              currentState={track.state}
              onDone={(message) => {
                setNotice(message);
                load();
              }}
            />

            {track.decisions.length === 0 ? null : (
              <>
                <p className={styles.subhead}>Decision history</p>
                <ul className={styles.history}>
                  {track.decisions.map((decision) => (
                    <li key={decision.decisionId}>
                      <span className={styles.mono}>{dayWord(decision.atMs)}</span>{' '}
                      {decision.fromState === null ? '' : `${stateWord(decision.fromState)} → `}
                      {stateWord(decision.toState)} · {decision.decidedBy}
                      <span className={styles.sub}>{decision.reason}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        ))
      )}
    </>
  );
}

/* ---------------------------------------------------------------- evidence */

function EvidencePanel({ evidence }: { readonly evidence: Evidence }) {
  return (
    <div className={styles.evidence}>
      {evidence.corpora.map((corpus) => (
        <div key={corpus.revision}>
          <p className={styles.subhead}>
            Source corpus · revision {corpus.revision} · {corpus.sourceCount} messages
          </p>
          <p className={`${styles.mono} ${styles.hash}`}>{corpus.sha256}</p>
          <p className={styles.sub}>
            Frozen {dayWord(corpus.frozenAtMs)} under permission {corpus.consentVersion}. The
            English column is what the message MEANS; it is not a wording to score against.
          </p>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Prompt</th>
                <th scope="col">Message</th>
                <th scope="col">Meaning (English)</th>
              </tr>
            </thead>
            <tbody>
              {corpus.items.map((item) => (
                <tr key={item.item}>
                  <td>{item.item}</td>
                  <td className={styles.sub}>{item.purpose}</td>
                  <td>{item.nativeMessage}</td>
                  <td>{item.englishSemanticReference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {evidence.reviews.map((review) => (
        <div key={review.assignmentId}>
          <p className={styles.subhead}>
            Blind review · {review.assignmentId} · {review.state}
          </p>
          <p className={styles.sub}>
            The engine names below were withheld from the reviewer while they judged. They are shown
            here so the result can be interpreted.
          </p>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Source</th>
                <th scope="col">Candidate</th>
                <th scope="col">Engine</th>
              </tr>
            </thead>
            <tbody>
              {review.candidates.map((candidate) => (
                <tr key={candidate.candidateId}>
                  <td>{candidate.ordinal}</td>
                  <td>{candidate.sourceText}</td>
                  <td>{candidate.candidateText}</td>
                  <td className={styles.mono}>
                    {candidate.provider}
                    <span className={styles.sub}>{candidate.model}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={styles.sub}>{review.verdicts.length} verdict(s) recorded.</p>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- decision */

function DecisionForm({
  api,
  accountId,
  language,
  currentState,
  onDone,
}: {
  readonly api: ReturnType<typeof createSpecialistAdminApi>;
  readonly accountId: string;
  readonly language: string;
  readonly currentState: string;
  readonly onDone: (message: string) => void;
}) {
  /*
   * ONLY the states an operator may set. The rest are reached by the applicant
   * doing something, and offering them here would let an operator manufacture a
   * SUBMITTED track for which no corpus was ever frozen.
   */
  const OPERATOR_STATES = [
    'UNDER_REVIEW',
    'QUALIFIED',
    'NOT_QUALIFIED',
    'REASSESSMENT_ALLOWED',
    'SUSPENDED',
  ];
  const [state, setState] = useState(OPERATOR_STATES[0] ?? 'UNDER_REVIEW');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <form
      className={styles.decision}
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void api.decide(accountId, language, { state, reason }).then((result) => {
          setBusy(false);
          if (result.ok) {
            setReason('');
            onDone(`${language}: set to ${stateWord(state)}.`);
            return;
          }
          onDone(result.forbidden === true ? 'That change was refused.' : result.error);
        });
      }}
    >
      <p className={styles.subhead}>Set the outcome</p>
      <div className={styles.decisionRow}>
        <label className={styles.filter}>
          <span>New state</span>
          <select value={state} onChange={(event) => setState(event.target.value)}>
            {OPERATOR_STATES.map((entry) => (
              <option key={entry} value={entry} disabled={entry === currentState}>
                {stateWord(entry)}
              </option>
            ))}
          </select>
        </label>
        <label className={`${styles.filter} ${styles.filterGrow}`}>
          <span>Reason (recorded in the audit trail)</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="What in the evidence decided this?"
            required
          />
        </label>
        <button
          className={`${styles.button} ${styles.buttonPrimary}`}
          type="submit"
          disabled={busy || reason.trim().length === 0}
        >
          Record decision
        </button>
      </div>
      <p className={styles.sub}>
        An outcome with no stated reason is refused. It is the record this person&rsquo;s standing
        rests on.
      </p>
    </form>
  );
}

/* -------------------------------------------------------------- assignment */

/**
 * Issue a blind review packet for one track.
 *
 * PASTED AS JSON, deliberately, and not built by a form. The candidates come
 * out of C7's own benchmark run -- a file of source, output, provider and model
 * -- and asking an operator to retype thirty rows into inputs would guarantee
 * transcription errors in the one dataset whose accuracy is the entire point. A
 * paste is the honest shape of the task.
 *
 * THE PROVIDER AND MODEL ARE REQUIRED. An unattributed candidate produces a
 * verdict nobody can act on: the reviewer is blind on purpose, so if the server
 * does not hold the identity either, the result names nothing. The server
 * refuses without them; this says so before the round trip.
 *
 * THE ORDER PASTED IS NOT THE ORDER REVIEWED. The server shuffles, because the
 * order an operator naturally writes -- best engine first -- would otherwise be
 * a signal the reviewer reads instead of the text.
 */
function IssueAssignmentForm({
  api,
  accountId,
  language,
  onDone,
}: {
  readonly api: ReturnType<typeof createSpecialistAdminApi>;
  readonly accountId: string;
  readonly language: string;
  readonly onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!open) {
    return (
      <div className={styles.actions}>
        <button className={styles.button} type="button" onClick={() => setOpen(true)}>
          Issue blind review
        </button>
      </div>
    );
  }

  return (
    <form
      className={styles.decision}
      onSubmit={(event) => {
        event.preventDefault();
        setProblem(null);
        let candidates: unknown;
        try {
          candidates = JSON.parse(text) as unknown;
        } catch {
          /*
           * Reported here rather than sent. A malformed paste is a typing
           * mistake, and a round trip to learn that is a round trip that also
           * puts a half-written packet in a log line.
           */
          setProblem('That is not valid JSON. Paste an array of candidate objects.');
          return;
        }
        if (!Array.isArray(candidates) || candidates.length === 0) {
          setProblem('Paste a non-empty ARRAY of candidates.');
          return;
        }
        setBusy(true);
        void api
          .issueAssignment(accountId, language, candidates)
          .then((result) => {
            setBusy(false);
            if (result.ok) {
              setText('');
              setOpen(false);
              onDone(`${language}: issued a blind review of ${result.value.candidates} translations.`);
              return;
            }
            setProblem(result.forbidden === true ? 'That request was refused.' : result.error);
          });
      }}
    >
      <p className={styles.subhead}>Issue a blind review</p>
      <p className={styles.sub}>
        An array of{' '}
        <code>
          {'{ sourceText, candidateText, direction, provider, model, category? }'}
        </code>
        . The provider and model are stored server-side and are never sent to the reviewer. The
        order you paste is not the order they will see.
      </p>
      <textarea
        className={styles.paste}
        rows={6}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder='[{"sourceText":"…","candidateText":"…","direction":"yo->en","provider":"opus-mt","model":"…"}]'
        spellCheck={false}
      />
      {problem === null ? null : <p className={styles.notice}>{problem}</p>}
      <div className={styles.actions}>
        <button
          className={`${styles.button} ${styles.buttonPrimary}`}
          type="submit"
          disabled={busy || text.trim().length === 0}
        >
          Issue
        </button>
        <button
          className={styles.button}
          type="button"
          onClick={() => {
            setOpen(false);
            setProblem(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
