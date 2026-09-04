/** @author masterzee001 */
/**
 * 03 Languages, to the golden master 03-languages-reference.png (founder
 * directive, LOCKED 30 Aug 2026, OPERATOR PREMIUM UI GOLDEN MASTERS).
 *
 * Presentation only. Every value on this page is real state handed in by
 * App.tsx: the source language and its mode, the live source-language
 * control of a running session, the target selection, and the deployment's
 * target-language catalogue -- read from media-ingest's GET
 * /languages/catalogue before any programme exists, and from the processing
 * session or media state once one does. The search, the capability words and
 * the selection rules are the existing pure helpers (languageRows.ts,
 * targetLanguageSelection.ts); nothing here re-implements them.
 *
 * NO EN->ES PRESET. Nothing is selected until the operator adds it; the list
 * is the catalogue, and a language is added only when its capability state
 * says it can be.
 *
 * Every control is classified:
 *   Auto-detect / Select manually   REAL     sourceLanguageMode -> session config + sourceLanguageControl
 *   Current source row              REAL     sourceLanguage; "Detected" only from a live sourceLanguageControl
 *   Confirm / Reject / Lock ...     REAL     POST /sessions/:id/source-language (only while a session runs)
 *   Search source language          REAL     filterLanguages over the catalogue; choosing sets manual mode
 *   Selected chips + remove         REAL     toggleTargetLanguage
 *   Search language catalogue       REAL     filterLanguages
 *   + Add                           REAL     toggleTargetLanguage; disabled when unavailable, added, or locked
 *   Capability legend               REAL     the four CapabilityState words and their meanings
 *   Back / Continue                 REAL     hash navigation (#/source, #/audio)
 *   The (i) beside the eyebrows     FUTURE   no help contract; decorative, hidden from assistive technology
 */
import React, { useMemo, useState } from 'react';
import type { SourceLanguageControlMetadata } from '@videofy-live/shared-types';
import styles from './LanguagesPage.module.css';
import { CAPABILITY_MEANINGS, DEGRADED_WORD, STATE_WORDS, filterLanguages, isAddableTarget, isSelectableSource, languageTag, type CapabilityState, type LanguageRow } from '../languageRows';
import { Button, Chip, Divider, Eyebrow, Panel, type Tone } from '../premium/primitives';
import { ArrowRightIcon, BroadcastIcon, CheckIcon, CloseIcon, HandIcon, InfoIcon, PlusIcon, SearchIcon, SparkleIcon } from '../premium/icons';

export type SourceLanguageMode = 'manual' | 'auto-detect';

/** How the catalogue reached the console, so an empty list can say why it is empty. */
export interface CatalogueState {
  readonly status: 'loading' | 'ready' | 'unavailable';
  /** For 'unavailable': what failed, in words an operator can act on. */
  readonly detail?: string | undefined;
}

export interface LanguagesPageProps {
  readonly rows: readonly LanguageRow[];
  readonly catalogue: CatalogueState;
  readonly sourceLanguage: string;
  readonly sourceLanguageMode: SourceLanguageMode;
  readonly onSourceLanguageChange: (next: { value: string; mode: SourceLanguageMode }) => void;
  /** The running session's source-language control; undefined before a programme. */
  readonly sourceLanguageControl?: SourceLanguageControlMetadata | undefined;
  readonly onSourceLanguageAction?: ((action: 'confirm' | 'reject' | 'override' | 'lock' | 'unlock' | 'detect-again', language?: string) => void) | undefined;
  readonly commandRunning?: boolean | undefined;
  readonly targetLanguages: readonly string[];
  readonly onToggleTarget: (code: string, checked: boolean) => void;
  /** True while a programme session runs: languages are fixed until it ends. */
  readonly locked: boolean;
  readonly lockedReason: string;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}

const STATE_TONE: Record<CapabilityState, Tone> = {
  qualified: 'success',
  available: 'teal',
  limited: 'warn',
  unavailable: 'neutral',
};

function CapabilityChip({ state, reason }: { readonly state: CapabilityState; readonly reason?: string | undefined }): React.ReactElement {
  return (
    <Chip tone={STATE_TONE[state]} size="sm" caps className={styles.stateChip} title={reason ?? STATE_WORDS[state]}>
      {STATE_WORDS[state]}
    </Chip>
  );
}

/*
 * THE ONE THING NOBODY DOWNSTREAM CAN SEE FOR THEMSELVES.
 *
 * A Nigerian language served by a general voice vendor plays perfectly and is
 * wrong, and every automated signal on that path is green (founder-confirmed,
 * 2026-08-26). Only a speaker of the language can tell, so the operator has to
 * be told in words, on the row, before the programme starts.
 */
function DegradedChip({ reason }: { readonly reason?: string | undefined }): React.ReactElement {
  return (
    <Chip tone="warn" size="sm" caps className={styles.stateChip} title={reason ?? DEGRADED_WORD}>
      {DEGRADED_WORD}
    </Chip>
  );
}

/*
 * The name of a language the TARGET catalogue does not carry.
 *
 * The current-source row looked its name up in the target catalogue, so a
 * programme spoken in English showed "EN" where the master shows "English":
 * English is a language this deployment translates FROM, and there is no
 * reason for it to appear in the list of languages it translates INTO. A
 * locale display name is not operational state -- it is the platform's own
 * name for a language tag -- so naming the code here invents nothing, claims
 * no capability, and cannot make an unavailable language look ready.
 */
function localeName(code: string): string | null {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    const name = names.of(code);
    if (name === undefined || name.toLowerCase() === code.toLowerCase()) return null;
    return name;
  } catch {
    return null;
  }
}

function PanelEyebrow({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return (
    <div className={styles.panelEyebrow}>
      <Eyebrow tone="muted" className={styles.panelEyebrowText}>
        {children}
      </Eyebrow>
      {/* FUTURE: no help contract behind the (i); it is the master's mark, not a control. */}
      <span className={styles.infoMark} aria-hidden="true">
        <InfoIcon size={16} />
      </span>
    </div>
  );
}

export function LanguagesPage({
  rows,
  catalogue,
  sourceLanguage,
  sourceLanguageMode,
  onSourceLanguageChange,
  sourceLanguageControl,
  onSourceLanguageAction,
  commandRunning = false,
  targetLanguages,
  onToggleTarget,
  locked,
  lockedReason,
  onBack,
  onContinue,
}: LanguagesPageProps): React.ReactElement {
  const [sourceQuery, setSourceQuery] = useState('');
  const [targetQuery, setTargetQuery] = useState('');

  /*
   * The current source: while a session runs, its control is the truth (the
   * language the chain is actually transcribing); before one, the operator's
   * choice. "Detected" is shown only when a real detection has landed.
   */
  const liveLanguage = sourceLanguageControl?.activeLanguage ?? sourceLanguage;
  const currentRow = rows.find((row) => row.code === liveLanguage);
  const detection = sourceLanguageControl?.status;
  const detected = detection === 'detected' || detection === 'confirmed';
  const sourceState: { label: string; tone: Tone } =
    detected
      ? { label: 'Detected', tone: 'teal' }
      : detection === 'detecting'
        ? { label: 'Detecting', tone: 'info' }
        : // A low-confidence detection has landed and is waiting on the
          // operator. It is not "Awaiting audio": the audio arrived.
          detection === 'needs-confirmation'
          ? { label: 'Confirm source', tone: 'warn' }
          : sourceLanguageMode === 'auto-detect'
            ? { label: 'Awaiting audio', tone: 'neutral' }
            : { label: 'Manual', tone: 'neutral' };

  const currentName = currentRow?.label ?? localeName(liveLanguage);

  const sourceMatches = useMemo(() => filterLanguages(rows, sourceQuery, 8), [rows, sourceQuery]);
  const chosen = useMemo(
    () => targetLanguages.map((code) => rows.find((row) => row.code === code) ?? { code, label: code.toUpperCase(), state: 'available' as const }),
    [rows, targetLanguages],
  );
  const candidates = useMemo(() => filterLanguages(rows, targetQuery, rows.length), [rows, targetQuery]);

  const catalogueEmptyWords =
    catalogue.status === 'loading'
      ? 'Loading the language catalogue from media ingest…'
      : catalogue.status === 'unavailable'
        ? `Language catalogue unavailable: ${catalogue.detail ?? 'media ingest is not reachable.'}`
        : 'This deployment has no target languages in its catalogue.';

  return (
    <div className={styles.page}>
      <div className={styles.columns}>
        {/* ------------------------------------------------ Source language */}
        <Panel padding="none" className={styles.panel} aria-label="Source language">
          <PanelEyebrow>Source language</PanelEyebrow>

          <div className={styles.segmented} role="group" aria-label="Source language mode">
            <button
              type="button"
              className={`${styles.segment} ${sourceLanguageMode === 'auto-detect' ? styles.segmentActive : ''}`}
              aria-pressed={sourceLanguageMode === 'auto-detect'}
              disabled={locked}
              title={locked ? lockedReason : undefined}
              onClick={() => onSourceLanguageChange({ value: sourceLanguage, mode: 'auto-detect' })}
            >
              <BroadcastIcon size={18} />
              <span>Auto-detect</span>
            </button>
            <button
              type="button"
              className={`${styles.segment} ${sourceLanguageMode === 'manual' ? styles.segmentActive : ''}`}
              aria-pressed={sourceLanguageMode === 'manual'}
              disabled={locked}
              title={locked ? lockedReason : undefined}
              onClick={() => onSourceLanguageChange({ value: sourceLanguage, mode: 'manual' })}
            >
              <HandIcon size={18} />
              <span>Select manually</span>
            </button>
          </div>

          <p className={styles.fieldLabel}>Current source</p>
          <div className={styles.currentRow} role="status" aria-label="Current source language">
            <span className={styles.tag}>{languageTag(liveLanguage)}</span>
            <span className={currentName === null ? styles.currentNameUnknown : styles.currentName}>
              {currentName ?? (rows.length === 0 ? 'Name arrives with the catalogue' : liveLanguage.toUpperCase())}
            </span>
            <Chip tone={sourceState.tone} size="md" className={styles.sourceChip}>
              {sourceState.label}
            </Chip>
          </div>

          {sourceLanguageControl !== undefined && onSourceLanguageAction !== undefined && (
            <div className={styles.liveControl}>
              <p className={styles.liveControlWords}>
                {`Live source ${sourceLanguageControl.activeLanguage.toUpperCase()} · ${sourceLanguageControl.status} · rev ${sourceLanguageControl.revision}`}
              </p>
              <div className={styles.liveControlButtons}>
                <Button size="sm" onClick={() => onSourceLanguageAction('confirm')} disabled={commandRunning}>Confirm</Button>
                <Button size="sm" onClick={() => onSourceLanguageAction('reject')} disabled={commandRunning}>Reject</Button>
                <Button size="sm" onClick={() => onSourceLanguageAction('override', sourceLanguage)} disabled={commandRunning}>Override</Button>
                <Button size="sm" onClick={() => onSourceLanguageAction(sourceLanguageControl.locked ? 'unlock' : 'lock')} disabled={commandRunning}>
                  {sourceLanguageControl.locked ? 'Unlock' : 'Lock'}
                </Button>
              </div>
            </div>
          )}

          <Divider className={styles.divider} />

          <label className={styles.fieldLabel} htmlFor="languages-source-search">
            Search source language
          </label>
          <div className={styles.search}>
            <SearchIcon size={18} className={styles.searchIcon} />
            <input
              id="languages-source-search"
              type="search"
              className={styles.searchInput}
              placeholder={rows.length === 0 ? catalogueEmptyWords : 'Search languages'}
              value={sourceQuery}
              onChange={(event) => setSourceQuery(event.target.value)}
              disabled={locked || rows.length === 0}
              title={locked ? lockedReason : undefined}
            />
          </div>
          {sourceQuery.length > 0 && !locked && (
            <ul className={styles.sourceMatches} aria-label="Source language matches">
              {sourceMatches.map((row) => (
                <li key={row.code}>
                  <button
                    type="button"
                    className={styles.sourceMatch}
                    // SOURCE, so the question is STT and MT: a language nothing
                    // can transcribe cannot be spoken into a programme.
                    disabled={!isSelectableSource(row)}
                    title={isSelectableSource(row) ? undefined : (row.reason ?? 'No recogniser on this chain hears this language.')}
                    onClick={() => {
                      onSourceLanguageChange({ value: row.code, mode: 'manual' });
                      setSourceQuery('');
                    }}
                  >
                    <span className={styles.tagSmall}>{languageTag(row.code)}</span>
                    <span>{row.label}</span>
                    {row.nativeName !== undefined && row.nativeName !== row.label && <small>{row.nativeName}</small>}
                  </button>
                </li>
              ))}
              {sourceMatches.length === 0 && <li className={styles.emptyRow}>No language matches that.</li>}
            </ul>
          )}

          {sourceLanguageMode === 'auto-detect' && (
            <div className={styles.note}>
              <SparkleIcon size={18} className={styles.noteIcon} />
              {/*
                * The master's sentence, word for word. What it no longer
                * spells out -- that a low-confidence detection waits on the
                * operator -- the source row now says where it happens, on
                * the chip ("Confirm source") and in the live control row.
                */}
              <p>Auto-detect analyses the audio in real time and updates the source language if needed.</p>
            </div>
          )}
        </Panel>

        {/* ------------------------------------------------ Target languages */}
        <Panel padding="none" className={styles.panel} aria-label="Target languages">
          <PanelEyebrow>Target languages</PanelEyebrow>

          <p className={styles.fieldLabel}>Selected languages ({chosen.length})</p>
          <div className={styles.chips} aria-label="Selected target languages">
            {chosen.length === 0 && <span className={styles.emptyChips}>None yet. Add languages from the catalogue below.</span>}
            {chosen.map((row) => (
              <span key={row.code} className={styles.selectedChip}>
                <span className={styles.tagTeal}>{languageTag(row.code)}</span>
                <span className={styles.selectedName}>{row.label}</span>
                {row.textOnly || row.captionsOnly ? <small className={styles.selectedNote}>captions only</small> : null}
                {row.degraded ? <small className={styles.selectedNote}>degraded voice</small> : null}
                {row.state === 'limited' ? <small className={styles.selectedNote}>beta</small> : null}
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={`Remove ${row.label}`}
                  disabled={locked}
                  title={locked ? lockedReason : `Remove ${row.label}`}
                  onClick={() => onToggleTarget(row.code, false)}
                >
                  <CloseIcon size={14} />
                </button>
              </span>
            ))}
          </div>

          <Divider className={`${styles.divider} ${styles.dividerWide}`} />

          <label className={styles.fieldLabel} htmlFor="languages-target-search">
            Search language catalogue
          </label>
          <div className={styles.search}>
            <SearchIcon size={18} className={styles.searchIcon} />
            <input
              id="languages-target-search"
              type="search"
              className={styles.searchInput}
              placeholder={rows.length === 0 ? catalogueEmptyWords : 'Search languages'}
              value={targetQuery}
              onChange={(event) => setTargetQuery(event.target.value)}
              disabled={rows.length === 0}
            />
          </div>

          <ul className={styles.catalogue} aria-label="Language catalogue" aria-busy={catalogue.status === 'loading'}>
            {rows.length === 0 && (
              <li className={styles.emptyRow} role="status">
                {catalogueEmptyWords}
              </li>
            )}
            {rows.length > 0 && candidates.length === 0 && <li className={styles.emptyRow}>No language matches that.</li>}
            {candidates.map((row) => {
              const added = targetLanguages.includes(row.code);
              // TARGET, so the question is MT and TTS. Recognition has nothing
              // to do with whether a listener can be given this language.
              const offerable = isAddableTarget(row);
              const addable = !added && !locked && offerable;
              const why = locked ? lockedReason : added ? 'Already selected' : !offerable ? (row.reason ?? 'Nothing on this chain translates into this language.') : `Add ${row.label}`;
              return (
                <li key={row.code} className={styles.catalogueRow}>
                  <span className={styles.tagRow}>{languageTag(row.code)}</span>
                  <span className={styles.rowName}>
                    {row.label}
                    {row.nativeName !== undefined && row.nativeName !== row.label && <small className={styles.rowNative}>{row.nativeName}</small>}
                  </span>
                  {row.captionsOnly === true && <small className={styles.rowNative}>captions only</small>}
                  <CapabilityChip state={row.targetState ?? row.state} reason={row.reason} />
                  {row.degraded === true && <DegradedChip reason={row.reason} />}
                  <button
                    type="button"
                    className={`${styles.add} ${added ? styles.added : ''}`}
                    disabled={!addable}
                    aria-disabled={!addable}
                    title={why}
                    onClick={() => onToggleTarget(row.code, true)}
                  >
                    {added ? <CheckIcon size={16} /> : <PlusIcon size={16} />}
                    <span>{added ? 'Added' : 'Add'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      {/* ------------------------------------------------ Capability legend */}
      <Panel padding="none" className={`${styles.panel} ${styles.legend}`} aria-label="Capability legend">
        <Eyebrow tone="muted" className={styles.legendEyebrow}>
          Capability legend
        </Eyebrow>
        <dl className={styles.legendRow}>
          {CAPABILITY_MEANINGS.map(({ state, meaning }) => (
            <div key={state} className={styles.legendItem}>
              <dt>
                <CapabilityChip state={state} />
              </dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={onContinue} iconAfter={<ArrowRightIcon size={18} />}>
          Continue
        </Button>
      </div>
    </div>
  );
}
