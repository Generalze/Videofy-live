/** @author masterzee001 */
/**
 * Source elicitation: the permission, the instructions, the fifteen messages,
 * and the submission that locks them.
 *
 * THE ORDER OF THE FOUR STEPS IS THE EVIDENCE RULE, not a wizard convention.
 * The permission comes before the form because contributor text is not C7's to
 * handle by default. The submission comes before review unlocks because the
 * whole value of native source is that it was written WITHOUT knowledge of how
 * the engines behave -- a contributor who has read thirty machine translations
 * will write toward the failures they saw, and their messages would then test
 * what C7 already knew rather than what it did not. That property cannot be
 * restored once lost and nothing about the data looks different afterwards.
 *
 * THE UI DOES NOT ENFORCE ANY OF IT. The server refuses a draft without consent,
 * refuses a freeze without consent, refuses an incomplete freeze and refuses a
 * second freeze outright. These steps exist so a person is not asked to do
 * things in a confusing order, not so the rule holds -- a rule that lives in a
 * React component is a rule that ends the moment somebody uses a different
 * client.
 *
 * THE ENGLISH COLUMN IS LABELLED AS MEANING, EVERYWHERE IT APPEARS. It is not a
 * model answer and never a wording to match. This project's automatic checker
 * has been wrong four times for exactly that confusion, and the label is the
 * cheapest place to keep it from happening a fifth.
 */
import { useEffect, useState } from 'react';
import { pathLink } from '../router';
import { Card, Chip, Notice, Progress } from './primitives';
import { pathForPage } from './route';
import type {
  ConsentState,
  ElicitationState,
  EntryWire,
  FrozenWire,
  SpecialistApi,
  TrackWire,
} from './api';

type Step = 'consent' | 'instructions' | 'elicitation' | 'unlock';

const STEP_NAMES: Readonly<Record<Step, string>> = {
  consent: 'Consent',
  instructions: 'Instructions',
  elicitation: 'Elicitation',
  unlock: 'Review unlock',
};

const STEP_ORDER: readonly Step[] = ['consent', 'instructions', 'elicitation', 'unlock'];

/**
 * The advice from the existing paper instructions, transcribed.
 *
 * Not rewritten. A contributor filling in the web form and a contributor who
 * received the CSV must be answering the same question, or the two corpora are
 * not comparable and every result that mixes them is describing two different
 * elicitations at once.
 */
const GUIDANCE = [
  {
    name: 'Write how you actually type',
    body: 'Not how you would write formally. Short forms and mixed-in English are fine — one row specifically asks for a mixed message.',
  },
  {
    name: 'Keep them short',
    body: 'One or two sentences each. These are messages, not paragraphs.',
  },
  {
    name: 'Do not translate from English',
    body: 'Write the message you would really send, first. Then say what it means.',
  },
  {
    name: 'The English column is the MEANING',
    body: 'It is not a model answer. If a translation engine later says it differently but gets the meaning right, that counts as correct.',
  },
];

export function Qualification({
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
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [form, setForm] = useState<ElicitationState | null>(null);
  const [step, setStep] = useState<Step>('consent');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* Consent inputs. Both are required and neither is pre-set. */
  const [original, setOriginal] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [typed, setTyped] = useState('');

  const [entries, setEntries] = useState<Record<number, EntryWire>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<FrozenWire | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [consentResult, formResult] = await Promise.all([
        api.consent(language),
        api.elicitation(language),
      ]);
      if (cancelled) return;
      if (consentResult.ok) setConsent(consentResult.value);
      if (formResult.ok) {
        setForm(formResult.value);
        setFrozen(formResult.value.frozen);
        setEntries(
          Object.fromEntries(formResult.value.entries.map((entry) => [entry.item, entry])),
        );
        /*
         * Land somebody on the step they are actually at. Sending a person who
         * has already agreed back to the permission page reads as though their
         * acceptance was lost.
         */
        if (formResult.value.frozen !== null) setStep('unlock');
        else if (formResult.value.consentAccepted) setStep('elicitation');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, language]);

  if (form === null || consent === null) {
    return <p className="sp-body sp-muted">Loading…</p>;
  }

  const answered = form.prompts.filter(
    (prompt) => (entries[prompt.item]?.nativeMessage ?? '').trim().length > 0,
  ).length;
  const complete = form.prompts.every((prompt) => {
    const entry = entries[prompt.item];
    const message = (entry?.nativeMessage ?? '').trim();
    if (message.length === 0) return prompt.optional;
    return (entry?.englishSemanticReference ?? '').trim().length > 0;
  });

  const submitConsent = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    const result = await api.acceptConsent(language, {
      accepted,
      typed,
      consentVersion: consent.offer.consentVersion,
    });
    setBusy(false);
    if (!result.ok) {
      setError('unauthenticated' in result && result.unauthenticated ? 'Your session has ended. Sign in again.' : result.error);
      return;
    }
    setConsent({ ...consent, accepted: true });
    setStep('instructions');
    onChanged();
  };

  const save = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    const result = await api.saveElicitation(language, Object.values(entries));
    setBusy(false);
    if (!result.ok) {
      setError('unauthenticated' in result && result.unauthenticated ? 'Your session has ended. Sign in again.' : result.error);
      return;
    }
    setSaved(new Date().toLocaleTimeString());
    onChanged();
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    /*
     * SAVED THEN FROZEN, in two calls. The freeze reads what is stored rather
     * than what the browser is holding, so a person cannot submit a corpus that
     * differs from the draft the server accepted -- and the hash is over the
     * bytes the server has, which is the only copy that means anything.
     */
    const stored = await api.saveElicitation(language, Object.values(entries));
    if (!stored.ok) {
      setBusy(false);
      setError('unauthenticated' in stored && stored.unauthenticated ? 'Your session has ended. Sign in again.' : stored.error);
      return;
    }
    const result = await api.freezeElicitation(language);
    setBusy(false);
    if (!result.ok) {
      setError('unauthenticated' in result && result.unauthenticated ? 'Your session has ended. Sign in again.' : result.error);
      return;
    }
    setFrozen(result.value);
    setStep('unlock');
    onChanged();
  };

  /*
   * The track first, the form's own answer second, the bare subtag never. A
   * person reaching this page by link may have no track loaded yet, and `yo` is
   * not what this language is called.
   */
  const languageName = track?.nativeName ?? form.nativeName ?? language;

  return (
    <>
      <header className="sp-page-head">
        <h1 className="sp-page-title">{languageName} source messages</h1>
        <p className="sp-page-lede">
          About twenty minutes. Fifteen short messages of the kind you would really send, and what
          each one means in English.
        </p>
      </header>

      <div className="sp-columns sp-columns-wizard">
        <div className="sp-wizard">
          <ol className="sp-steps">
            {STEP_ORDER.map((entry, index) => {
              const reached = STEP_ORDER.indexOf(step) >= index;
              return (
                <li
                  key={entry}
                  className={`sp-step${entry === step ? ' sp-step-current' : ''}${reached ? ' sp-step-reached' : ''}`}
                >
                  <span className="sp-step-index">{index + 1}</span>
                  <span className="sp-step-name">{STEP_NAMES[entry]}</span>
                </li>
              );
            })}
          </ol>

          <Card>
            {error === null ? null : <Notice>{error}</Notice>}

            {step === 'consent' ? (
              <ConsentStep
                consent={consent}
                original={original}
                accepted={accepted}
                typed={typed}
                busy={busy}
                onOriginal={setOriginal}
                onAccepted={setAccepted}
                onTyped={setTyped}
                onContinue={submitConsent}
              />
            ) : null}

            {step === 'instructions' ? (
              <>
                <h2 className="sp-card-title">Before you start</h2>
                <ul className="sp-guidance">
                  {GUIDANCE.map((entry) => (
                    <li key={entry.name}>
                      <p className="sp-guidance-name">{entry.name}</p>
                      <p className="sp-body">{entry.body}</p>
                    </li>
                  ))}
                </ul>
                <p className="sp-body sp-muted">
                  Your fifteen messages are locked before any software touches them. You will not
                  see any machine translation of them until after you have submitted — that is
                  deliberate, so that what you write is not shaped by what you have already seen.
                </p>
                <button
                  className="sp-button sp-button-primary"
                  type="button"
                  onClick={() => setStep('elicitation')}
                >
                  Start writing
                </button>
              </>
            ) : null}

            {step === 'elicitation' ? (
              <ElicitationStep
                form={form}
                entries={entries}
                frozen={frozen !== null}
                busy={busy}
                saved={saved}
                complete={complete}
                onChange={(item, patch) =>
                  setEntries((current) => ({
                    ...current,
                    [item]: {
                      item,
                      nativeMessage: current[item]?.nativeMessage ?? '',
                      englishSemanticReference: current[item]?.englishSemanticReference ?? '',
                      ...patch,
                    },
                  }))
                }
                onSave={save}
                onSubmit={submit}
              />
            ) : null}

            {step === 'unlock' ? <UnlockStep frozen={frozen} languageName={languageName} /> : null}
          </Card>
        </div>

        <div className="sp-column-side">
          {/*
            GROUPED, NOT FIFTEEN ROWS. A column of fifteen "to do" chips answers
            "how much is left" by making somebody count them, and it was taller
            than the form beside it. Five counted groups is the same information
            at a glance. The grouping comes from the server with the prompts, so
            there is no second copy of which item belongs where.
          */}
          <Card title="Your progress">
            <Progress done={answered} total={form.prompts.length} label="Messages written" />
            <ul className="sp-rows sp-rows-tight">
              {form.groups.map((group) => {
                const done = group.items.filter((item) => {
                  const message = (entries[item]?.nativeMessage ?? '').trim();
                  const meaning = (entries[item]?.englishSemanticReference ?? '').trim();
                  return message.length > 0 && meaning.length > 0;
                }).length;
                return (
                  <li className="sp-row sp-row-tight" key={group.name}>
                    <span className="sp-row-main">
                      <span className="sp-row-name">{group.name}</span>
                    </span>
                    <Chip tone={done === group.items.length ? 'positive' : 'caution'}>
                      {done} / {group.items.length}
                    </Chip>
                  </li>
                );
              })}
              <li className="sp-row sp-row-tight sp-row-total">
                <span className="sp-row-main">
                  <span className="sp-row-name">Total</span>
                </span>
                <Chip tone={complete ? 'positive' : 'neutral'}>
                  {answered} / {form.prompts.length}
                </Chip>
              </li>
            </ul>
          </Card>

          <Card title="Need help?">
            <p className="sp-body">
              Write to <a className="sp-link" href="mailto:languages@consummate7.com">languages@consummate7.com</a>{' '}
              if anything is unclear. Your submission lives here on the platform, not in email.
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

/* ---------------------------------------------------------------- consent */

function ConsentStep({
  consent,
  original,
  accepted,
  typed,
  busy,
  onOriginal,
  onAccepted,
  onTyped,
  onContinue,
}: {
  readonly consent: ConsentState;
  readonly original: boolean;
  readonly accepted: boolean;
  readonly typed: string;
  readonly busy: boolean;
  readonly onOriginal: (value: boolean) => void;
  readonly onAccepted: (value: boolean) => void;
  readonly onTyped: (value: string) => void;
  readonly onContinue: () => void;
}) {
  if (consent.accepted) {
    return (
      <>
        <h2 className="sp-card-title">Permission accepted</h2>
        <p className="sp-body">
          You accepted this permission on {new Date(consent.acceptedAtMs ?? 0).toLocaleDateString()}.
        </p>
        <p className="sp-mono">{consent.acceptedVersion}</p>
      </>
    );
  }

  /*
   * BOTH BOXES AND THE TYPED WORD. The server requires the tick and the word;
   * the first box -- "these are my original words" -- is the claim the licence
   * itself rests on, and asking for it separately is what makes it a statement
   * rather than something buried in a paragraph somebody scrolled past.
   */
  const ready = original && accepted && typed.trim().toUpperCase() === consent.offer.affirmation;

  return (
    <>
      <h2 className="sp-card-title">Contributor permission</h2>
      <p className="sp-consent-text">{consent.offer.text}</p>
      <p className="sp-body sp-consent-retained">{consent.offer.retainedRights}</p>

      <div className="sp-consent-grants">
        <div>
          <p className="sp-eyebrow">This permission covers</p>
          <ul className="sp-list">
            {consent.offer.grantedUses.map((use) => (
              <li key={use}>{use.replace(/-/gu, ' ')}</li>
            ))}
          </ul>
        </div>
        <div>
          {/*
            Shown, not merely absent. A person deciding whether to contribute is
            entitled to see what they are NOT agreeing to, in a list, rather
            than to infer it from silence.
          */}
          <p className="sp-eyebrow">It does not cover</p>
          <ul className="sp-list sp-list-withheld">
            {consent.offer.withheldUses.map((use) => (
              <li key={use}>{use.replace(/-/gu, ' ')}</li>
            ))}
          </ul>
        </div>
      </div>

      <label className="sp-check">
        <input
          type="checkbox"
          checked={original}
          onChange={(event) => onOriginal(event.target.checked)}
        />
        <span>I confirm that these will be my own original words.</span>
      </label>
      <label className="sp-check">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => onAccepted(event.target.checked)}
        />
        <span>I accept the contributor permission above.</span>
      </label>

      <label className="sp-field sp-field-narrow">
        <span className="sp-field-label">
          Type {consent.offer.affirmation} to confirm
        </span>
        <input
          className="sp-input"
          value={typed}
          onChange={(event) => onTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <button
        className="sp-button sp-button-primary"
        type="button"
        disabled={!ready || busy}
        onClick={onContinue}
      >
        Continue
      </button>
      {ready ? null : (
        <p className="sp-body sp-muted">You must accept the permission to continue.</p>
      )}
      <p className="sp-mono sp-muted">{consent.offer.consentVersion}</p>
    </>
  );
}

/* ------------------------------------------------------------ elicitation */

function ElicitationStep({
  form,
  entries,
  frozen,
  busy,
  saved,
  complete,
  onChange,
  onSave,
  onSubmit,
}: {
  readonly form: ElicitationState;
  readonly entries: Record<number, EntryWire>;
  readonly frozen: boolean;
  readonly busy: boolean;
  readonly saved: string | null;
  readonly complete: boolean;
  readonly onChange: (item: number, patch: Partial<EntryWire>) => void;
  readonly onSave: () => void;
  readonly onSubmit: () => void;
}) {
  return (
    <>
      <h2 className="sp-card-title">Your fifteen messages</h2>
      <p className="sp-body sp-muted">
        The English column is what the message <strong>means</strong>. It is not a model answer.
      </p>

      <ol className="sp-items">
        {form.prompts.map((prompt) => (
          <li className="sp-item" key={prompt.item}>
            <div className="sp-item-head">
              <span className="sp-row-index">{prompt.item}</span>
              <p className="sp-item-purpose">{prompt.purpose}</p>
              {prompt.optional ? <Chip tone="neutral">Optional</Chip> : null}
            </div>
            <div className="sp-item-fields">
              <label className="sp-field">
                <span className="sp-field-label">Your message</span>
                <textarea
                  className="sp-textarea sp-textarea-short"
                  rows={2}
                  disabled={frozen}
                  value={entries[prompt.item]?.nativeMessage ?? ''}
                  onChange={(event) => onChange(prompt.item, { nativeMessage: event.target.value })}
                />
              </label>
              <label className="sp-field">
                <span className="sp-field-label">What it means in English</span>
                <textarea
                  className="sp-textarea sp-textarea-short"
                  rows={2}
                  disabled={frozen}
                  value={entries[prompt.item]?.englishSemanticReference ?? ''}
                  onChange={(event) =>
                    onChange(prompt.item, { englishSemanticReference: event.target.value })
                  }
                />
              </label>
            </div>
          </li>
        ))}
      </ol>

      <div className="sp-actions">
        <button className="sp-button" type="button" disabled={busy || frozen} onClick={onSave}>
          Save draft
        </button>
        <button
          className="sp-button sp-button-primary"
          type="button"
          disabled={busy || frozen || !complete}
          onClick={onSubmit}
        >
          Submit and lock
        </button>
        {saved === null ? null : <span className="sp-body sp-muted">Saved {saved}</span>}
      </div>
      {complete ? (
        <p className="sp-body sp-muted">
          Submitting locks these messages. They cannot be edited afterwards, and review opens.
        </p>
      ) : (
        <p className="sp-body sp-muted">
          Every message needs its English meaning before you can submit. The optional row may be
          left blank.
        </p>
      )}
    </>
  );
}

/* ----------------------------------------------------------------- unlock */

function UnlockStep({
  frozen,
  languageName,
}: {
  readonly frozen: FrozenWire | null;
  readonly languageName: string;
}) {
  if (frozen === null) {
    return <p className="sp-body">Nothing has been submitted for {languageName} yet.</p>;
  }
  return (
    <>
      <h2 className="sp-card-title">Submitted and locked</h2>
      <p className="sp-body">
        Your {frozen.sourceCount} messages were locked on{' '}
        {new Date(frozen.frozenAtMs).toLocaleString()}. They cannot be changed. Blind translation
        review is now open for this language.
      </p>
      <dl className="sp-facts">
        <div>
          <dt>Messages</dt>
          <dd>{frozen.sourceCount}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>{frozen.revision}</dd>
        </div>
        <div>
          {/*
            The contributor sees the fingerprint too. It is the thing every
            later result cites, and it is how they can tell that what was locked
            is what they wrote.
          */}
          <dt>Fingerprint (SHA-256)</dt>
          <dd className="sp-mono sp-hash">{frozen.sha256}</dd>
        </div>
      </dl>
      <a className="sp-button sp-button-primary" {...pathLink(pathForPage('assignments'))}>
        Go to assignments
      </a>
    </>
  );
}
