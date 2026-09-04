/** @author masterzee001 */
/**
 * Source validation: check C7's sentences BEFORE anything is translated.
 *
 * THE ORDER IS THE POINT, and the portal enforces it by having nowhere else to
 * go. For French, Spanish and Portuguese C7 can obtain source and cannot judge
 * it; a reviewer handed a translation of a malformed sentence is being asked
 * two questions at once, and their answer gets filed as an answer to the
 * second. So:
 *
 *     source only -> validate/correct -> freeze -> sha256
 *       -> both engines rerun -> blind review
 *
 * THERE IS NO CANDIDATE TRANSLATION ON THIS SCREEN and none in the payload that
 * feeds it. A person who has read two translations of a sentence has an opinion
 * about the sentence that came from the translations. The server builds this
 * packet with `validationPacket`, which names the fields it copies, so a
 * candidate could not appear here even if one were stored alongside.
 *
 * A CORRECTION MEANS BOTH ENGINES ARE RERUN, and the screen says so before the
 * submission rather than after. Scoring engine A on the original and engine B
 * on the correction is two measurements of different things reported as one.
 */
import { useEffect, useState } from 'react';
import { pathLink } from '../router';
import { Card, Chip, Notice, Progress } from './primitives';
import { pathForPage } from './route';
import type { SourceJudgementWire, SourceValidationState, SpecialistApi, TrackWire } from './api';

type Verdict = SourceJudgementWire['verdict'];

const VERDICT_WORDS: Readonly<Record<Verdict, string>> = {
  ACCEPT: 'Correct as it is',
  CORRECT: 'Needs a correction',
  REJECT: 'Not usable at all',
};

const VERDICT_HELP: Readonly<Record<Verdict, string>> = {
  ACCEPT: 'A real sentence somebody would write in this language.',
  CORRECT: 'Nearly right. Write what it should say.',
  REJECT: 'Not a sentence in this language. It will be dropped, not translated.',
};

export function SourceValidation({
  api,
  language,
  track,
  onChanged,
}: {
  readonly api: SpecialistApi;
  readonly language: string;
  readonly track: TrackWire | undefined;
  readonly onChanged: () => void;
}) {
  const [state, setState] = useState<SourceValidationState | null>(null);
  const [judgements, setJudgements] = useState<Record<number, SourceJudgementWire>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.sourceValidation(language).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(
          'unauthenticated' in result && result.unauthenticated
            ? 'Your session has ended. Sign in again.'
            : result.error,
        );
        return;
      }
      setState(result.value);
      setJudgements(
        Object.fromEntries(result.value.judgements.map((entry) => [entry.ordinal, entry])),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, language]);

  if (state === null) {
    return (
      <>
        <p className="sp-body sp-muted">Loading…</p>
        {error === null ? null : <Notice>{error}</Notice>}
      </>
    );
  }

  const languageName = track?.nativeName ?? state.nativeName;
  const judged = state.items.filter((item) => judgements[item.ordinal] !== undefined).length;
  const complete = state.items.every((item) => {
    const judgement = judgements[item.ordinal];
    if (judgement === undefined) return false;
    /* A correction with no text is a verdict that cannot say what changed. */
    return judgement.verdict !== 'CORRECT' || (judgement.correctedText ?? '').trim().length > 0;
  });
  const corrections = state.items.filter(
    (item) => judgements[item.ordinal]?.verdict === 'CORRECT',
  ).length;
  const frozen = state.frozen;

  const set = (ordinal: number, patch: Partial<SourceJudgementWire>): void =>
    setJudgements((current) => ({
      ...current,
      [ordinal]: {
        ordinal,
        verdict: current[ordinal]?.verdict ?? 'ACCEPT',
        ...(current[ordinal]?.correctedText === undefined
          ? {}
          : { correctedText: current[ordinal]?.correctedText }),
        ...(current[ordinal]?.note === undefined ? {} : { note: current[ordinal]?.note }),
        ...patch,
      },
    }));

  const failure = (result: { unauthenticated?: boolean; error?: string }): string =>
    result.unauthenticated === true
      ? 'Your session has ended. Sign in again.'
      : (result.error ?? 'Something went wrong.');

  const save = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    const result = await api.saveSourceJudgements(language, Object.values(judgements));
    setBusy(false);
    if (!result.ok) {
      setError(failure(result));
      return;
    }
    setSaved(new Date().toLocaleTimeString());
    onChanged();
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    /*
     * SAVED THEN FROZEN, in two calls. The freeze reads what is STORED rather
     * than what the browser is holding, so the hash is over the bytes the
     * server has -- the only copy that means anything.
     */
    const stored = await api.saveSourceJudgements(language, Object.values(judgements));
    if (!stored.ok) {
      setBusy(false);
      setError(failure(stored));
      return;
    }
    const result = await api.freezeSourceValidation(language);
    setBusy(false);
    if (!result.ok) {
      setError(failure(result));
      return;
    }
    const refreshed = await api.sourceValidation(language);
    if (refreshed.ok) setState(refreshed.value);
    onChanged();
  };

  return (
    <>
      <header className="sp-page-head">
        <h1 className="sp-page-title">{languageName} source check</h1>
        <p className="sp-page-lede">
          These are sentences C7 holds. Before anything is translated, somebody who speaks the
          language needs to say whether each one is right.
        </p>
      </header>

      {error === null ? null : <Notice>{error}</Notice>}

      <div className="sp-columns sp-columns-wizard">
        <div className="sp-wizard">
          {frozen !== null ? (
            <Card>
              <h2 className="sp-card-title">Submitted and locked</h2>
              <p className="sp-body">
                Your check of {frozen.sourceCount} sentence{frozen.sourceCount === 1 ? '' : 's'} was
                locked on {new Date(frozen.frozenAtMs).toLocaleString()}. Blind translation review
                is now open for this language.
              </p>
              {frozen.corrected ? (
                <p className="sp-body sp-muted">
                  You corrected at least one sentence, so both translation engines are being run
                  again against your corrected text. Nothing produced from the original is used.
                </p>
              ) : null}
              <dl className="sp-facts">
                <div>
                  <dt>Sentences</dt>
                  <dd>{frozen.sourceCount}</dd>
                </div>
                <div>
                  <dt>Revision</dt>
                  <dd>{frozen.revision}</dd>
                </div>
                <div>
                  <dt>Fingerprint (SHA-256)</dt>
                  <dd className="sp-mono sp-hash">{frozen.sha256}</dd>
                </div>
              </dl>
              <a className="sp-button sp-button-primary" {...pathLink(pathForPage('assignments'))}>
                Go to assignments
              </a>
            </Card>
          ) : state.items.length === 0 ? (
            <Card>
              <h2 className="sp-card-title">Nothing to check yet</h2>
              <p className="sp-body">
                We have not sent you any {state.englishName} sentences yet. This page will fill in
                when we do.
              </p>
            </Card>
          ) : (
            <Card>
              <h2 className="sp-card-title">The sentences</h2>
              <p className="sp-body sp-muted">
                You are not being shown any translation of these. Judge the sentence itself: would a
                person actually write this?
              </p>
              <ol className="sp-items">
                {state.items.map((item) => {
                  const judgement = judgements[item.ordinal];
                  return (
                    <li className="sp-item" key={item.ordinal}>
                      <div className="sp-item-head">
                        <span className="sp-row-index">{item.ordinal}</span>
                        <p className="sp-item-purpose">{item.suppliedText}</p>
                        {item.category.length === 0 ? null : (
                          <Chip tone="neutral">{item.category.replace(/-/gu, ' ')}</Chip>
                        )}
                      </div>
                      <div className="sp-choice">
                        {(['ACCEPT', 'CORRECT', 'REJECT'] as const).map((verdict) => (
                          <button
                            key={verdict}
                            type="button"
                            className={`sp-choice-option${judgement?.verdict === verdict ? ' sp-choice-on' : ''}`}
                            aria-pressed={judgement?.verdict === verdict}
                            title={VERDICT_HELP[verdict]}
                            onClick={() => set(item.ordinal, { verdict })}
                          >
                            {VERDICT_WORDS[verdict]}
                          </button>
                        ))}
                      </div>
                      {judgement?.verdict === 'CORRECT' ? (
                        <label className="sp-field">
                          <span className="sp-field-label">What it should say</span>
                          <textarea
                            className="sp-textarea sp-textarea-short"
                            rows={2}
                            value={judgement.correctedText ?? ''}
                            onChange={(event) =>
                              set(item.ordinal, { correctedText: event.target.value })
                            }
                          />
                        </label>
                      ) : null}
                      {judgement?.verdict === 'REJECT' ? (
                        <label className="sp-field">
                          <span className="sp-field-label">What is wrong with it (optional)</span>
                          <textarea
                            className="sp-textarea sp-textarea-short"
                            rows={2}
                            value={judgement.note ?? ''}
                            onChange={(event) => set(item.ordinal, { note: event.target.value })}
                          />
                        </label>
                      ) : null}
                    </li>
                  );
                })}
              </ol>

              <div className="sp-actions">
                <button className="sp-button" type="button" disabled={busy} onClick={save}>
                  Save draft
                </button>
                <button
                  className="sp-button sp-button-primary"
                  type="button"
                  disabled={busy || !complete}
                  onClick={submit}
                >
                  Submit and lock
                </button>
                {saved === null ? null : <span className="sp-body sp-muted">Saved {saved}</span>}
              </div>
              {complete ? (
                <p className="sp-body sp-muted">
                  Submitting locks these sentences.
                  {corrections > 0
                    ? ' Because you corrected some, both translation engines will be run again against your corrected text.'
                    : ''}
                </p>
              ) : (
                <p className="sp-body sp-muted">
                  Every sentence needs a judgement, and a correction needs its text, before you can
                  submit.
                </p>
              )}
            </Card>
          )}
        </div>

        <div className="sp-column-side">
          <Card title="Your progress">
            <Progress done={judged} total={state.items.length} label="Sentences checked" />
            <ul className="sp-rows sp-rows-tight">
              {(['ACCEPT', 'CORRECT', 'REJECT'] as const).map((verdict) => (
                <li className="sp-row sp-row-tight" key={verdict}>
                  <span className="sp-row-main">
                    <span className="sp-row-name">{VERDICT_WORDS[verdict]}</span>
                  </span>
                  <Chip tone={verdict === 'REJECT' ? 'negative' : 'neutral'}>
                    {state.items.filter((item) => judgements[item.ordinal]?.verdict === verdict).length}
                  </Chip>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Why this comes first">
            <p className="sp-body">
              A translation of a sentence that was wrong to begin with tells us nothing about the
              translation. Checking the source first is the only way the review that follows means
              anything.
            </p>
            <a className="sp-link" {...pathLink(pathForPage('languages'))}>
              Back to languages
            </a>
          </Card>
        </div>
      </div>
    </>
  );
}
