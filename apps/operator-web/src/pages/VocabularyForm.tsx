/** @author masterzee001 */
/**
 * The control that actually creates and edits a term.
 *
 * WHY IT IS ITS OWN FILE. Page 05 shipped with a table, consumer chips, a
 * Remove button and a Reload button -- and no way to add anything. `onSave`
 * reached the component and nothing in the component reached `onSave`. That is
 * the same defect as an unreachable page, one level down, and it made the whole
 * feature untestable from the surface an operator actually uses.
 *
 * EDIT PRESERVES THE ENTRY ID. An edit implemented as delete-then-create would
 * be two revisions, two conflict windows, and a moment where the term does not
 * exist -- during which a running session could take a snapshot without it.
 * One entry, one id, one PUT.
 *
 * THE REVISION IS THE ONE ON SCREEN. Passed in, never read from anywhere else,
 * so a submit built from a stale view is refused by the server rather than
 * silently overwriting somebody.
 */
import React, { useEffect, useState } from 'react';
import styles from './VocabularyPage.module.css';
import type { VocabularyEntryView } from './VocabularyPage';

/** The kinds the API accepts. An unknown one is a 400, so the UI cannot make one. */
export const VOCABULARY_KINDS = [
  'person', 'place', 'organisation', 'programme-term', 'code',
] as const;

export interface VocabularyFormProps {
  /** The entry being edited, or null to create a new one. */
  readonly editing: VocabularyEntryView | null;
  readonly revision: number;
  readonly saving: boolean;
  readonly onSave: (entry: VocabularyEntryView, expectedRevision: number) => void;
  readonly onCancelEdit?: () => void;
}

const BLANK: VocabularyEntryView = {
  id: '', term: '', canonicalRendering: '', language: '*',
  pronunciationHint: '', doNotTranslate: false, sttKeyterm: false,
  kind: 'programme-term', notes: '', enabled: true,
};

/** A stable id for a new term. Existing entries keep the one they have. */
function newEntryId(term: string): string {
  const slug = term.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '');
  return `${slug.slice(0, 40) || 'term'}-${Date.now().toString(36)}`;
}

export function VocabularyForm(props: VocabularyFormProps): React.ReactElement {
  const [draft, setDraft] = useState<VocabularyEntryView>(props.editing ?? BLANK);

  useEffect(() => {
    setDraft(props.editing ?? BLANK);
  }, [props.editing]);

  const isEdit = props.editing !== null;
  // A blank term cannot submit. The server refuses it too; refusing here saves
  // an operator a round trip to be told something obvious.
  const canSubmit = draft.term.trim() !== '' && !props.saving;

  const set = <K extends keyof VocabularyEntryView>(
    key: K, value: VocabularyEntryView[K],
  ): void => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <form
      className={styles.form}
      data-testid="vocabulary-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        props.onSave(
          {
            ...draft,
            term: draft.term.trim(),
            // An edit KEEPS its id; a create gets one. Never delete-and-recreate.
            id: isEdit ? draft.id : newEntryId(draft.term),
          },
          // The revision currently on screen.
          props.revision,
        );
      }}
    >
      <h3 className={styles.formTitle}>{isEdit ? 'Edit term' : 'Add term'}</h3>

      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>Term</span>
          <input
            name="term"
            value={draft.term}
            required
            onChange={(e) => set('term', e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span>Kind</span>
          {/* A closed list, so the UI cannot generate a kind the API refuses. */}
          <select name="kind" value={draft.kind}
                  onChange={(e) => set('kind', e.target.value)}>
            {VOCABULARY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>

        <label className={styles.field}>
          <span>Language</span>
          {/* Explicit, never inferred: `*` is a choice an operator makes. */}
          <input
            name="language"
            value={draft.language}
            placeholder="* for every language"
            onChange={(e) => set('language', e.target.value.trim() || '*')}
          />
        </label>

        <label className={styles.field}>
          <span>Agreed spelling</span>
          <input
            name="canonicalRendering"
            value={draft.canonicalRendering}
            onChange={(e) => set('canonicalRendering', e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span>Pronunciation hint</span>
          <input
            name="pronunciationHint"
            value={draft.pronunciationHint}
            onChange={(e) => set('pronunciationHint', e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span>Note</span>
          <input
            name="notes"
            value={draft.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </label>
      </div>

      <div className={styles.formToggles}>
        <label className={styles.toggle}>
          <input type="checkbox" name="doNotTranslate" checked={draft.doNotTranslate}
                 onChange={(e) => set('doNotTranslate', e.target.checked)} />
          <span>Do not translate</span>
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" name="sttKeyterm" checked={draft.sttKeyterm}
                 onChange={(e) => set('sttKeyterm', e.target.checked)} />
          <span>Offer to speech recognition</span>
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" name="enabled" checked={draft.enabled}
                 onChange={(e) => set('enabled', e.target.checked)} />
          <span>Enabled</span>
        </label>
      </div>

      <div className={styles.formActions}>
        <button type="submit" className={styles.save} disabled={!canSubmit}>
          {/* Disabled while saving, so one submit cannot become two writes. */}
          {props.saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add term'}
        </button>
        {isEdit && props.onCancelEdit ? (
          <button type="button" className={styles.cancel} onClick={props.onCancelEdit}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
