/** @author masterzee001 */
/**
 * The read-mostly screens: dashboard, profile, languages, submissions.
 *
 * EVERYTHING RENDERED HERE IS DECIDED BY THE SERVER. The states, the lock
 * messages, the counts and the language names all arrive in the payload. What
 * these components decide is arrangement — which is the same rule the account
 * shell states: what to SHOW is a courtesy, what is ALLOWED is re-decided at
 * the point of every action.
 *
 * NO SEAT ARITHMETIC OF ANY KIND. The dashboard counts qualified languages by
 * reading the states the server sent; it never computes whether somebody is
 * eligible for something, because a frontend that computes eligibility is a
 * frontend that will confidently offer a button the server refuses.
 */
import { useState } from 'react';
import { pathLink } from '../router';
import { Card, Chip, Empty, Notice, Progress, StatTile } from './primitives';
import { pathForElicitation, pathForPage, pathForReview } from './route';
import { dayWord, stateTone, stateWord, type Me, type ProgrammeLanguage, type SubmissionWire, type TrackWire } from './api';

/* -------------------------------------------------------------- dashboard */

export function Dashboard({ me }: { readonly me: Me }) {
  const qualified = me.tracks.filter((track) => track.state === 'QUALIFIED');
  const pending = me.assignments.filter((assignment) => assignment.state !== 'SUBMITTED');
  const nextStep = me.tracks.find(
    (track) => track.requiresSourceElicitation && !track.elicitation.frozen,
  );

  return (
    <>
      <header className="sp-page-head">
        <h1 className="sp-page-title">Welcome back</h1>
        <p className="sp-page-lede">
          Thank you for helping C7 improve multilingual communication.
        </p>
      </header>

      <div className="sp-stats">
        <StatTile
          label="Application"
          value={me.applied ? stateWord(me.applicationState ?? 'UNDER_REVIEW') : 'Not started'}
          detail={me.applied ? `Applied ${dayWord(me.appliedAtMs)}` : 'Tell us about your languages'}
          tone={me.applied ? 'caution' : 'neutral'}
        />
        <StatTile label="Languages" value={String(me.tracks.length)} detail="Applied for" />
        <StatTile
          label="Qualified"
          value={String(qualified.length)}
          detail={qualified.length === 0 ? 'None yet' : qualified.map((t) => t.englishName).join(', ')}
          tone={qualified.length > 0 ? 'positive' : 'neutral'}
        />
        <StatTile
          label="Pending tasks"
          value={String(pending.length)}
          detail={pending.length === 0 ? 'Nothing waiting' : 'Assignments'}
          tone={pending.length > 0 ? 'accent' : 'neutral'}
        />
      </div>

      <div className="sp-columns">
        <Card
          title="Language overview"
          action={
            <a className="sp-link" {...pathLink(pathForPage('languages'))}>
              Manage
            </a>
          }
        >
          {me.tracks.length === 0 ? (
            <Empty
              title="No languages yet"
              body="Choose the languages you speak and write fluently to begin."
              action={
                <a className="sp-button sp-button-primary" {...pathLink(pathForPage('languages'))}>
                  Choose languages
                </a>
              }
            />
          ) : (
            <ul className="sp-rows">
              {me.tracks.map((track) => (
                <li className="sp-row" key={track.language}>
                  <div className="sp-row-main">
                    <span className="sp-row-name">{track.nativeName}</span>
                    <span className="sp-row-sub">{track.englishName}</span>
                  </div>
                  <Chip tone={stateTone(track.state)}>{stateWord(track.state)}</Chip>
                  <span className="sp-row-meta">
                    {track.state === 'QUALIFIED'
                      ? `Qualified ${dayWord(track.decidedAtMs)}`
                      : `Applied ${dayWord(track.appliedAtMs)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="sp-column-side">
          <Card
            title="Pending assignments"
            action={
              <a className="sp-link" {...pathLink(pathForPage('assignments'))}>
                View all
              </a>
            }
          >
            {pending.length === 0 ? (
              <Empty
                title="Nothing waiting"
                body="Assignments appear here once a qualification step is ready for you."
              />
            ) : (
              <ul className="sp-rows">
                {pending.slice(0, 3).map((assignment) => (
                  <li className="sp-row" key={assignment.assignmentId}>
                    <div className="sp-row-main">
                      <span className="sp-row-name">
                        {assignment.kind === 'BLIND_TRANSLATION_REVIEW'
                          ? 'Blind translation review'
                          : 'Source elicitation'}
                      </span>
                      <span className="sp-row-sub">{assignment.englishName}</span>
                    </div>
                    <Chip tone={assignment.state === 'NEW' ? 'accent' : 'caution'}>
                      {assignment.state === 'NEW' ? 'New' : 'In progress'}
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {nextStep === undefined ? null : (
            <Card title="Your next step">
              {/*
                The sentence already says what the lock message would say, and
                printing both read as the page repeating itself: "write and
                submit your fifteen messages" twice, in two voices.
              */}
              <p className="sp-body">
                {nextStep.englishName} qualification begins with fifteen short messages you write
                yourself. Review opens for {nextStep.englishName} once they are submitted.
              </p>
              <Progress
                done={nextStep.elicitation.answered}
                total={nextStep.elicitation.total}
                label={`${nextStep.englishName} messages written`}
              />
              <a
                className="sp-button sp-button-primary"
                {...pathLink(pathForElicitation(nextStep.language))}
              >
                {nextStep.elicitation.answered === 0 ? 'Start' : 'Continue'}
              </a>
            </Card>
          )}

          {/*
            Stated, not assumed. A contributor should be able to see in the
            product that nothing about their voice has been agreed to.
          */}
          <Card title="Voice participation">
            <p className="sp-body">
              Not invited. The permission you give covers the text you write. Any future voice
              participation would be a separate invitation with its own agreement.
            </p>
            <Chip tone="neutral">{stateWord(me.voice.state)}</Chip>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- profile */

export function Profile({
  me,
  onApply,
  busy,
  error,
}: {
  readonly me: Me;
  readonly onApply: (input: { motivation: string; country: string; timeZone: string }) => void;
  readonly busy: boolean;
  readonly error: string | null;
}) {
  const [motivation, setMotivation] = useState('');
  const [country, setCountry] = useState(me.country ?? '');
  const [timeZone, setTimeZone] = useState(me.timeZone ?? '');

  return (
    <>
      <header className="sp-page-head">
        <h1 className="sp-page-title">Profile</h1>
        <p className="sp-page-lede">
          Tell us about your language experience. We ask for as little as we can.
        </p>
      </header>

      <div className="sp-columns">
        <Card title="About you">
          <form
            className="sp-form"
            onSubmit={(event) => {
              event.preventDefault();
              onApply({ motivation, country, timeZone });
            }}
          >
            <label className="sp-field">
              <span className="sp-field-label">Why do you want to be a C7 Language Specialist?</span>
              <textarea
                className="sp-textarea"
                rows={5}
                value={motivation}
                onChange={(event) => setMotivation(event.target.value)}
                placeholder="A sentence or two about the languages you speak and write."
                required
              />
            </label>
            <div className="sp-field-pair">
              <label className="sp-field">
                <span className="sp-field-label">Country of residence (optional)</span>
                <input
                  className="sp-input"
                  value={country}
                  onChange={(event) => setCountry(event.target.value)}
                />
              </label>
              <label className="sp-field">
                <span className="sp-field-label">Time zone (optional)</span>
                <input
                  className="sp-input"
                  value={timeZone}
                  onChange={(event) => setTimeZone(event.target.value)}
                  placeholder="(GMT+0100) West Africa Time"
                />
              </label>
            </div>
            {error === null ? null : <Notice>{error}</Notice>}
            <button className="sp-button sp-button-primary" type="submit" disabled={busy}>
              {me.applied ? 'Save' : 'Submit application'}
            </button>
          </form>
        </Card>

        <div className="sp-column-side">
          {/*
            Said on the page rather than in a policy nobody opens. The reason
            these fields are absent is a decision worth showing.
          */}
          <Card title="What we do not ask for">
            <ul className="sp-list">
              <li>No home address</li>
              <li>No government identification</li>
              <li>No demographic details</li>
            </ul>
            <p className="sp-body">
              None of it helps decide whether you can tell a good translation from a bad one.
            </p>
          </Card>
          <Card title="Your C7 account">
            <p className="sp-body">
              Being a Language Specialist is a role on the C7 account you already have. There is no
              separate specialist login and no second password.
            </p>
            <p className="sp-mono">{me.accountId}</p>
          </Card>
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------- languages */

export function Languages({
  me,
  catalogue,
  onApplyForLanguage,
  busy,
  error,
}: {
  readonly me: Me;
  readonly catalogue: readonly ProgrammeLanguage[];
  readonly onApplyForLanguage: (language: string) => void;
  readonly busy: string | null;
  readonly error: string | null;
}) {
  const opened = new Map(me.tracks.map((track) => [track.language, track]));
  return (
    <>
      <header className="sp-page-head">
        <h1 className="sp-page-title">Languages</h1>
        <p className="sp-page-lede">
          Qualification is decided for each language on its own. Applying in one says nothing about
          another.
        </p>
      </header>
      {error === null ? null : <Notice>{error}</Notice>}
      <div className="sp-language-grid">
        {catalogue.map((language) => {
          const track = opened.get(language.language);
          return (
            <Card className="sp-language-card" key={language.language}>
              <div className="sp-language-head">
                <div>
                  <h2 className="sp-language-native">{language.nativeName}</h2>
                  <p className="sp-language-english">{language.englishName}</p>
                </div>
                {/*
                  "Not assessed" is the ABSENCE of a record, which is why this
                  reads the map rather than a state field: there is no stored
                  NOT_ASSESSED and inventing one here would be a tenth state
                  that only the browser knows about.
                */}
                <Chip tone={track === undefined ? 'neutral' : stateTone(track.state)}>
                  {track === undefined ? stateWord('NOT_ASSESSED') : stateWord(track.state)}
                </Chip>
              </div>
              <p className="sp-body">
                {language.requiresSourceElicitation
                  ? 'Qualification begins with fifteen short messages you write yourself.'
                  : 'Qualification begins with a blind translation review.'}
              </p>
              {track === undefined ? (
                <button
                  className="sp-button sp-button-primary"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => onApplyForLanguage(language.language)}
                >
                  {busy === language.language ? 'Applying…' : 'Apply for this language'}
                </button>
              ) : (
                <LanguageProgress track={track} />
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}

function LanguageProgress({ track }: { readonly track: TrackWire }) {
  if (!track.requiresSourceElicitation) {
    return (
      <p className="sp-body sp-muted">
        {track.review.unlocked
          ? 'Review is open for this language.'
          : (track.review.message ?? '')}
      </p>
    );
  }
  return (
    <>
      <Progress
        done={track.elicitation.answered}
        total={track.elicitation.total}
        label={`${track.englishName} messages written`}
      />
      {track.elicitation.frozen ? (
        <p className="sp-body sp-muted">
          Submitted and locked.{' '}
          <span className="sp-mono sp-hash">{track.elicitation.sha256?.slice(0, 16)}…</span>
        </p>
      ) : (
        <a className="sp-button" {...pathLink(pathForElicitation(track.language))}>
          {track.elicitation.answered === 0 ? 'Start' : 'Continue'}
        </a>
      )}
    </>
  );
}

/* ------------------------------------------------------------ assignments */

export function Assignments({
  assignments,
}: {
  readonly assignments: readonly {
    assignmentId: string;
    language: string;
    englishName: string;
    kind: string;
    state: string;
    createdAtMs: number;
    dueAtMs: number | null;
    unlocked?: boolean;
    lockMessage?: string | null;
  }[];
}) {
  return (
    <>
      <header className="sp-page-head">
        <h1 className="sp-page-title">Assignments</h1>
        <p className="sp-page-lede">
          Translation reviews are blind: you are never told which system produced which translation.
        </p>
      </header>
      {assignments.length === 0 ? (
        <Card>
          <Empty
            title="No assignments yet"
            body="An assignment appears here when a qualification step is ready for you. For languages that begin with source elicitation, that is after your fifteen messages are submitted."
          />
        </Card>
      ) : (
        <Card>
          <ul className="sp-rows">
            {assignments.map((assignment) => (
              <li className="sp-row" key={assignment.assignmentId}>
                <div className="sp-row-main">
                  <span className="sp-row-name">
                    {assignment.kind === 'BLIND_TRANSLATION_REVIEW'
                      ? 'Blind translation review'
                      : 'Source elicitation'}
                  </span>
                  <span className="sp-row-sub">
                    {assignment.englishName} · created {dayWord(assignment.createdAtMs)}
                    {assignment.dueAtMs === null ? '' : ` · due ${dayWord(assignment.dueAtMs)}`}
                  </span>
                </div>
                <Chip
                  tone={
                    assignment.state === 'SUBMITTED'
                      ? 'positive'
                      : assignment.state === 'NEW'
                        ? 'accent'
                        : 'caution'
                  }
                >
                  {assignment.state === 'SUBMITTED'
                    ? 'Submitted'
                    : assignment.state === 'NEW'
                      ? 'New'
                      : 'In progress'}
                </Chip>
                {assignment.unlocked === false ? (
                  /*
                    The server's sentence, not one written here. The rule that
                    produced the lock lives on the server, and a second copy of
                    the wording would eventually say "locked" when it is open.
                  */
                  <span className="sp-row-meta sp-muted">{assignment.lockMessage}</span>
                ) : (
                  <a
                    className="sp-button sp-button-small"
                    {...pathLink(pathForReview(assignment.assignmentId))}
                  >
                    Open
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/* ------------------------------------------------------------ submissions */

export function Submissions({
  submissions,
}: {
  readonly submissions: readonly SubmissionWire[];
}) {
  return (
    <>
      <header className="sp-page-head">
        <h1 className="sp-page-title">Submissions</h1>
        <p className="sp-page-lede">
          What you have sent, exactly as it was locked. Nothing here can be edited — a correction is
          a new submission, never a change to this one.
        </p>
      </header>
      {submissions.length === 0 ? (
        <Card>
          <Empty title="Nothing submitted yet" body="Your submitted work appears here." />
        </Card>
      ) : (
        submissions.map((submission, index) => (
          <Card
            key={`${submission.kind}-${submission.language}-${index}`}
            eyebrow={submission.englishName}
            title={
              submission.kind === 'SOURCE_ELICITATION'
                ? `Source messages · revision ${submission.revision}`
                : 'Blind translation review'
            }
          >
            {submission.kind === 'SOURCE_ELICITATION' ? (
              <>
                <dl className="sp-facts">
                  <div>
                    <dt>Messages</dt>
                    <dd>{submission.sourceCount}</dd>
                  </div>
                  <div>
                    <dt>Submitted</dt>
                    <dd>{dayWord(submission.frozenAtMs)}</dd>
                  </div>
                  <div>
                    <dt>Permission</dt>
                    <dd className="sp-mono">{submission.consentVersion}</dd>
                  </div>
                  <div>
                    {/*
                      Shown to the contributor, not hidden as an internal
                      detail. It is the fingerprint of exactly what was locked,
                      and it is what every later result cites.
                    */}
                    <dt>Fingerprint (SHA-256)</dt>
                    <dd className="sp-mono sp-hash">{submission.sha256}</dd>
                  </div>
                </dl>
                <ol className="sp-submission-items">
                  {(submission.items ?? []).map((item) => (
                    <li key={item.item}>
                      <p className="sp-eyebrow">{item.purpose}</p>
                      <p className="sp-submission-native">{item.nativeMessage}</p>
                      <p className="sp-submission-english">{item.englishSemanticReference}</p>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <dl className="sp-facts">
                <div>
                  <dt>Translations judged</dt>
                  <dd>{submission.judged}</dd>
                </div>
                <div>
                  <dt>Submitted</dt>
                  <dd>{dayWord(submission.submittedAtMs)}</dd>
                </div>
              </dl>
            )}
          </Card>
        ))
      )}
    </>
  );
}
