/** @author masterzee001 */
/**
 * Blind translation review.
 *
 * WHAT IS NOT ON THIS SCREEN IS THE POINT. No provider, no model, no automatic
 * score, no benchmark position, no hint about which candidate C7 expects to
 * win. Automatic checks have already been run on this material and were wrong
 * three times on Yoruba-adjacent judgements; a reviewer who knows what a machine
 * thought is no longer an independent instrument, and their answers would still
 * look exactly like evidence.
 *
 * The blind is enforced on the SERVER -- `blindCandidate` builds the payload by
 * naming the fields it copies rather than by deleting the ones it must not, and
 * a test asserts the serialised response contains none of them. This component
 * could not display an engine name if it tried, because it is never sent one.
 * That is the correct arrangement: a redaction that depends on a React
 * component remembering not to render a field is not a redaction.
 *
 * QUESTION 2 IS VISUALLY WEIGHTED, because it outranks the other seven. A
 * translation that turns "I have received the money" into "I have NOT received
 * the money" is somebody losing money or missing a warning; beautiful-but-
 * reversed is worse than awkward-but-correct, and the form should say so
 * without a paragraph of explanation.
 */
import { useEffect, useState } from 'react';
import { pathLink } from '../router';
import { Card, Chip, Empty, Notice, Progress } from './primitives';
import { pathForPage } from './route';
import type { BlindCandidateWire, ReviewPacket, SpecialistApi } from './api';

/** The one question whose answer outranks the rest. Named, never inferred. */
const DECISIVE = 'meaningReversed';

type Answers = Record<string, string | number>;

export function Review({
  api,
  assignmentId,
  onChanged,
}: {
  readonly api: SpecialistApi;
  readonly assignmentId: string;
  readonly onChanged: () => void;
}) {
  const [packet, setPacket] = useState<ReviewPacket | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [corrected, setCorrected] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [judged, setJudged] = useState<readonly string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api.packet(assignmentId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setPacket(result.value);
        setJudged(result.value.judgedCandidateIds);
        return;
      }
      /*
       * The server's sentence. A refusal here is usually the review gate --
       * "submit your fifteen messages first" -- and that wording belongs where
       * the rule is, not in a second copy on the client.
       */
      setLocked('unauthenticated' in result && result.unauthenticated ? 'Your session has ended. Sign in again.' : result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [api, assignmentId]);

  if (locked !== null) {
    return (
      <Card title="Review is not open">
        <Empty
          title="Not available yet"
          body={locked}
          action={
            <a className="sp-button" {...pathLink(pathForPage('assignments'))}>
              Back to assignments
            </a>
          }
        />
      </Card>
    );
  }

  if (packet === null) return <p className="sp-body sp-muted">Loading…</p>;

  const remaining = packet.candidates.filter(
    (candidate) => !judged.includes(candidate.candidateId),
  );
  const current =
    packet.candidates.find((candidate) => candidate.candidateId === selected) ?? remaining[0] ?? null;

  /*
   * The observed-language question counts toward completeness where the target
   * asks it. The server requires it; letting Save look enabled and then be
   * refused would teach a reviewer to distrust the button.
   */
  const complete =
    current !== null &&
    packet.criteria.every((criterion) => answers[criterion.key] !== undefined) &&
    (packet.observedLanguage === null || answers['observedLanguage'] !== undefined);

  const submit = async (): Promise<void> => {
    if (current === null) return;
    setError(null);
    setBusy(true);
    const result = await api.recordVerdict(assignmentId, {
      candidateId: current.candidateId,
      ...answers,
      ...(corrected.trim().length === 0 ? {} : { correctedTranslation: corrected }),
      ...(note.trim().length === 0 ? {} : { note }),
    });
    setBusy(false);
    if (!result.ok) {
      setError('unauthenticated' in result && result.unauthenticated ? 'Your session has ended. Sign in again.' : result.error);
      return;
    }
    setJudged((done) => [...done, current.candidateId]);
    setAnswers({});
    setCorrected('');
    setNote('');
    setSelected(null);
    onChanged();
  };

  return (
    <>
      <header className="sp-page-head sp-page-head-review">
        <div>
          {/* The language as its speakers write it, never the bare subtag. */}
          <h1 className="sp-page-title">{packet.nativeName} blind review</h1>
          <p className="sp-page-lede">
            You are not told which system produced which translation. That is deliberate.
          </p>
        </div>
        <Progress
          done={judged.length}
          total={packet.candidates.length}
          label="Translations judged"
        />
      </header>

      {error === null ? null : <Notice>{error}</Notice>}

      {current === null ? (
        <Card>
          <Empty
            title="Every translation judged"
            body="Thank you. This assignment is complete and has been submitted."
            action={
              <a className="sp-button" {...pathLink(pathForPage('assignments'))}>
                Back to assignments
              </a>
            }
          />
        </Card>
      ) : (
        <div className="sp-columns sp-columns-review">
          <div className="sp-review-main">
            <Card eyebrow={`Source · ${current.direction}`} title="What was written">
              <p className="sp-source-text">{current.sourceText}</p>
            </Card>

            <Card
              title="Candidate translation"
              action={
                /*
                 * Said out loud. A reviewer who suspects the order encodes
                 * something will start reading the order instead of the text.
                 */
                <Chip tone="neutral">Order is randomised</Chip>
              }
            >
              <p className="sp-candidate-text">{current.candidateText}</p>
              <p className="sp-body sp-muted">
                Translation {current.ordinal} of {packet.candidates.length}
              </p>
            </Card>

            <CandidateList
              candidates={packet.candidates}
              judged={judged}
              currentId={current.candidateId}
              onSelect={(candidateId) => {
                setSelected(candidateId);
                setAnswers({});
                setCorrected('');
                setNote('');
              }}
            />
          </div>

          <div className="sp-column-side">
            <Card title="Review criteria">
              <ul className="sp-criteria">
                {packet.criteria.map((criterion) => (
                  <li
                    className={`sp-criterion${criterion.key === DECISIVE ? ' sp-criterion-decisive' : ''}`}
                    key={criterion.key}
                  >
                    <p className="sp-criterion-question">
                      {criterion.question}
                      {criterion.key === DECISIVE ? (
                        <span className="sp-criterion-flag">Most important</span>
                      ) : null}
                    </p>
                    {criterion.kind === 'yes-no' ? (
                      <div className="sp-choice">
                        {(['yes', 'no'] as const).map((option) => (
                          <button
                            key={option}
                            type="button"
                            className={`sp-choice-option${answers[criterion.key] === option ? ' sp-choice-on' : ''}`}
                            aria-pressed={answers[criterion.key] === option}
                            onClick={() =>
                              setAnswers((current) => ({ ...current, [criterion.key]: option }))
                            }
                          >
                            {option === 'yes' ? 'Yes' : 'No'}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="sp-choice sp-choice-scale">
                        {[1, 2, 3, 4, 5].map((score) => (
                          <button
                            key={score}
                            type="button"
                            className={`sp-choice-option${answers[criterion.key] === score ? ' sp-choice-on' : ''}`}
                            aria-pressed={answers[criterion.key] === score}
                            aria-label={`${criterion.question} ${score} of 5`}
                            onClick={() =>
                              setAnswers((current) => ({ ...current, [criterion.key]: score }))
                            }
                          >
                            {score}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              {packet.observedLanguage === null ? null : (
                /*
                 * A STRUCTURED, REQUIRED OBSERVATION. C7 has already watched an
                 * engine answer Portuguese in Italian. Every other question on
                 * this packet assumes the output is in the target language at
                 * all, so without this a reviewer meeting Italian had nowhere
                 * to put it but the note -- where no result would count it.
                 */
                <div className="sp-criterion sp-criterion-observed">
                  <p className="sp-criterion-question">
                    {packet.observedLanguage.question}
                    <span className="sp-criterion-flag">Required</span>
                  </p>
                  <div className="sp-choice sp-choice-wrap">
                    {packet.observedLanguage.options.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={`sp-choice-option${answers['observedLanguage'] === option ? ' sp-choice-on' : ''}`}
                        aria-pressed={answers['observedLanguage'] === option}
                        onClick={() =>
                          setAnswers((current) => ({ ...current, observedLanguage: option }))
                        }
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <label className="sp-field">
                <span className="sp-field-label">Your corrected translation (optional)</span>
                <textarea
                  className="sp-textarea sp-textarea-short"
                  rows={3}
                  value={corrected}
                  onChange={(event) => setCorrected(event.target.value)}
                  placeholder="Most useful on the ones you marked reversed."
                />
              </label>
              <label className="sp-field">
                <span className="sp-field-label">Note (optional)</span>
                <textarea
                  className="sp-textarea sp-textarea-short"
                  rows={2}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="If it is nonsense, say so plainly."
                />
              </label>

              <div className="sp-actions">
                <button
                  className="sp-button"
                  type="button"
                  onClick={() => {
                    setAnswers({});
                    setCorrected('');
                    setNote('');
                  }}
                >
                  Clear
                </button>
                <button
                  className="sp-button sp-button-primary"
                  type="button"
                  disabled={!complete || busy}
                  onClick={submit}
                >
                  Save review
                </button>
              </div>
              {complete ? null : (
                <p className="sp-body sp-muted">
                  Please answer every question. An unanswered one cannot be told apart from a
                  judgement you made.
                </p>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The other candidates in this packet.
 *
 * Labelled A, B, C by POSITION and nothing else. Numbering them by the order
 * they arrived is the same information the server already randomised away.
 */
function CandidateList({
  candidates,
  judged,
  currentId,
  onSelect,
}: {
  readonly candidates: readonly BlindCandidateWire[];
  readonly judged: readonly string[];
  readonly currentId: string;
  readonly onSelect: (candidateId: string) => void;
}) {
  return (
    <Card title="All translations in this assignment">
      <ul className="sp-rows">
        {candidates.map((candidate, index) => {
          const done = judged.includes(candidate.candidateId);
          return (
            <li className="sp-row" key={candidate.candidateId}>
              <span className="sp-row-index">{String.fromCharCode(65 + (index % 26))}</span>
              <div className="sp-row-main">
                <span className="sp-row-name sp-row-name-quiet">{candidate.candidateText}</span>
              </div>
              {done ? (
                <Chip tone="positive">Judged</Chip>
              ) : (
                <button
                  className={`sp-button sp-button-small${candidate.candidateId === currentId ? ' sp-button-primary' : ''}`}
                  type="button"
                  onClick={() => onSelect(candidate.candidateId)}
                >
                  {candidate.candidateId === currentId ? 'Reviewing' : 'Review'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
