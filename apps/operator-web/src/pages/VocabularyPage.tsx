/** @author masterzee001 */
/**
 * Programme Vocabulary.
 *
 * WHAT THIS PAGE REFUSES TO SAY. It never reports a term as "active" because a
 * write succeeded. Saving a row and changing the output are different events,
 * and a console that conflates them teaches an operator to trust a claim
 * nobody verified. Every actionable field shows one of three observed states --
 * consumed, unconsumed, unsupported -- and names the thing that consumes it.
 *
 * CONSUMPTION IS CONTEXTUAL. `sttKeyterm` reads `consumed` only when the
 * selected source-language recognition route actually accepts keyterms:
 * Deepgram nova-3 does, nova-2 does not, and "Deepgram exists somewhere" is not
 * an answer. The capability comes from the server alongside the entries so this
 * page cannot form its own opinion and drift from what is really sent.
 *
 * A CONFLICT IS NOT RECOVERED FOR YOU. If somebody else saved while this page
 * was open, the save is refused and the operator is told to reload. No retry,
 * no merge, no silently discarding the other person's work -- the software
 * cannot know which of two people is right.
 */
import React from 'react';
import styles from './VocabularyPage.module.css';

export type ConsumerState = 'consumed' | 'unconsumed' | 'unsupported';

export interface VocabularyEntryView {
  readonly id: string;
  readonly term: string;
  readonly canonicalRendering: string;
  readonly language: string;
  readonly pronunciationHint: string;
  readonly doNotTranslate: boolean;
  readonly sttKeyterm: boolean;
  readonly kind: string;
  readonly notes: string;
  readonly enabled: boolean;
}

/** What this deployment's selected providers can actually do. */
export interface RouteCapabilities {
  readonly sttKeyterms: boolean;
  readonly sttRouteName: string;
  readonly pronunciationHints: boolean;
  readonly synthesisRouteName: string;
}

export interface VocabularySnapshotView {
  readonly programmeId: string;
  readonly revision: number;
  readonly entries: readonly VocabularyEntryView[];
  readonly capabilities: RouteCapabilities;
}

export interface VocabularyPageProps {
  /** Null while loading; `unavailable` when there is no durable storage. */
  readonly snapshot: VocabularySnapshotView | null;
  readonly unavailable?: boolean;
  readonly conflict?: { expectedRevision: number; currentRevision: number } | null;
  readonly saving?: boolean;
  readonly onReload: () => void;
  readonly onSave: (entry: VocabularyEntryView, expectedRevision: number) => void;
  readonly onDelete: (entryId: string, expectedRevision: number) => void;
}

/** The consumer each field actually has, named for the operator. */
const CONSUMERS = {
  doNotTranslate: 'Translation protection',
  canonicalRendering: 'Translation matched-span restore',
  sttKeyterm: 'Speech recognition',
  pronunciationHint: 'Speech synthesis',
} as const;

export function describeConsumerStates(
  entry: VocabularyEntryView,
  capabilities: RouteCapabilities,
): Record<keyof typeof CONSUMERS, ConsumerState> {
  const set = (used: boolean, supported: boolean): ConsumerState =>
    !used || !entry.enabled ? 'unconsumed' : supported ? 'consumed' : 'unsupported';

  return {
    doNotTranslate: set(entry.doNotTranslate, true),
    canonicalRendering: set(entry.canonicalRendering.trim() !== '', true),
    // CONTEXTUAL: depends on the selected recognition route, not on the mere
    // existence of a provider.
    sttKeyterm: set(entry.sttKeyterm, capabilities.sttKeyterms),
    pronunciationHint: set(
      entry.pronunciationHint.trim() !== '', capabilities.pronunciationHints),
  };
}

function StateChip({ state, consumer, detail }: {
  readonly state: ConsumerState;
  readonly consumer: string;
  readonly detail?: string;
}): React.ReactElement {
  return (
    <span className={`${styles.chip} ${styles[state]}`} data-state={state}>
      <span className={styles.chipState}>{state}</span>
      <span className={styles.chipConsumer}>
        {consumer}
        {detail ? ` · ${detail}` : ''}
      </span>
    </span>
  );
}

export function VocabularyPage(props: VocabularyPageProps): React.ReactElement {
  const { snapshot, unavailable, conflict, saving } = props;

  if (unavailable) {
    return (
      <section className={styles.page} aria-label="Programme Vocabulary">
        <h2 className={styles.title}>Programme Vocabulary</h2>
        <p className={styles.unavailable}>
          Vocabulary is unavailable on this deployment because durable storage is
          not configured. Terms are not accepted here rather than being held
          somewhere they would be lost.
        </p>
      </section>
    );
  }

  if (snapshot === null) {
    return (
      <section className={styles.page} aria-label="Programme Vocabulary">
        <h2 className={styles.title}>Programme Vocabulary</h2>
        <p className={styles.loading}>Loading…</p>
      </section>
    );
  }

  const { capabilities } = snapshot;

  return (
    <section className={styles.page} aria-label="Programme Vocabulary">
      <header className={styles.header}>
        <h2 className={styles.title}>Programme Vocabulary</h2>
        <p className={styles.revision} data-testid="revision">
          Revision <strong>{snapshot.revision}</strong>
        </p>
      </header>

      {/* Effective time, stated rather than implied. */}
      <p className={styles.effective}>
        Changes apply to the <strong>next processing session</strong>. A session
        already running keeps the vocabulary it started with.
      </p>

      {conflict ? (
        <div className={styles.conflict} role="alert" data-testid="conflict">
          <p>
            Vocabulary changed since you opened this page. Reload the latest
            revision before saving.
          </p>
          <p className={styles.conflictDetail}>
            You were editing revision {conflict.expectedRevision}; the current
            revision is {conflict.currentRevision}. Nothing was saved, and no
            other change was overwritten.
          </p>
          <button type="button" onClick={props.onReload} className={styles.reload}>
            Reload revision {conflict.currentRevision}
          </button>
        </div>
      ) : null}

      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Term</th>
            <th scope="col">Language</th>
            <th scope="col">Agreed spelling</th>
            <th scope="col">What reads it</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {snapshot.entries.map((entry) => {
            const states = describeConsumerStates(entry, capabilities);
            return (
              <tr key={entry.id} data-testid={`entry-${entry.id}`}
                  className={entry.enabled ? '' : styles.disabled}>
                <td>
                  <span className={styles.term}>{entry.term}</span>
                  <span className={styles.kind}>{entry.kind}</span>
                  {entry.notes ? (
                    <span className={styles.notes} title="Operator memo; nothing reads it">
                      {entry.notes}
                    </span>
                  ) : null}
                </td>
                <td>
                  {/* Language is shown, so a French-scoped term is never taken
                      for a global one. */}
                  <span className={styles.language}>
                    {entry.language === '*' ? 'every language' : entry.language}
                  </span>
                </td>
                <td>{entry.canonicalRendering || <span className={styles.none}>—</span>}</td>
                <td className={styles.states}>
                  <StateChip state={states.doNotTranslate}
                             consumer={CONSUMERS.doNotTranslate} />
                  <StateChip state={states.canonicalRendering}
                             consumer={CONSUMERS.canonicalRendering} />
                  <StateChip state={states.sttKeyterm}
                             consumer={CONSUMERS.sttKeyterm}
                             detail={capabilities.sttRouteName} />
                  <StateChip state={states.pronunciationHint}
                             consumer={CONSUMERS.pronunciationHint}
                             detail={capabilities.synthesisRouteName} />
                </td>
                <td>
                  <button
                    type="button"
                    disabled={saving === true}
                    onClick={() => props.onDelete(entry.id, snapshot.revision)}
                    className={styles.delete}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
          {snapshot.entries.length === 0 ? (
            <tr>
              <td colSpan={5} className={styles.empty}>
                No terms yet. Add the names, places and programme terms a
                translator or recogniser would otherwise get wrong.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <p className={styles.footnote}>
        An agreed spelling replaces the term only where it was actually matched
        in the source. It does not correct a spelling nobody entered.
      </p>
    </section>
  );
}
