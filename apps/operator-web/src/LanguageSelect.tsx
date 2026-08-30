/** @author masterzee001 */
/**
 * Languages, chosen from a catalogue -- never from a preset.
 *
 * THE CATALOGUE IS SHOWN; NOTHING IS ENABLED BY BEING IN IT (founder
 * clarification, 29 Aug). The operator searches ~80 languages, picks the
 * targets one by one, and sees each one's capability state for the
 * programme's chain: available / qualified / limited / unavailable. An
 * unavailable language is visible and not selectable; a limited one is
 * selectable with its state on the chip, so nothing is advertised as
 * production-ready because a provider nominally lists it.
 *
 * The rows come from the session's target-language catalogue (media-ingest
 * builds it from the shared catalogue and the capability resolver), so the
 * console shows what THIS deployment can do, not what a vendor page says.
 */
import React, { useMemo, useState } from 'react';
import styles from './LanguageSelect.module.css';
import { DEGRADED_WORD, STATE_WORDS, filterLanguages, isAddableTarget, isSelectableSource, type CapabilityState, type LanguageRow } from './languageRows';

export type { CapabilityState, LanguageRow } from './languageRows';

export function StateBadge({ state }: { readonly state: CapabilityState }): React.ReactElement {
  return <span className={`${styles.badge} ${styles[`badge_${state}`]}`}>{STATE_WORDS[state]}</span>;
}

/** Searchable multi-select for target languages. */
export function TargetLanguageSelect({
  rows,
  selected,
  disabled = false,
  disabledReason,
  onToggle,
}: {
  readonly rows: readonly LanguageRow[];
  readonly selected: readonly string[];
  readonly disabled?: boolean;
  readonly disabledReason?: string | undefined;
  readonly onToggle: (code: string, checked: boolean) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const chosen = useMemo(() => selected.map((code) => rows.find((row) => row.code === code) ?? { code, label: code.toUpperCase(), state: 'available' as const }), [rows, selected]);
  const candidates = useMemo(() => filterLanguages(rows.filter((row) => !selected.includes(row.code)), query), [rows, selected, query]);

  return (
    <div className={styles.wrap}>
      <div className={styles.chips} aria-label="Selected target languages">
        {chosen.length === 0 && <span className={styles.empty}>No target languages yet. Search below to add one.</span>}
        {chosen.map((row) => (
          <span key={row.code} className={styles.chip}>
            {row.label}
            {row.textOnly || row.captionsOnly ? <small> · captions only</small> : null}
            {row.degraded ? <small> · {DEGRADED_WORD.toLowerCase()}</small> : null}
            {(row.targetState ?? row.state) === 'limited' ? <small> · beta</small> : null}
            <button type="button" className={styles.chipRemove} aria-label={`Remove ${row.label}`} disabled={disabled} onClick={() => onToggle(row.code, false)}>
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        type="search"
        className={styles.search}
        placeholder={rows.length === 0 ? 'Language catalogue is loading…' : 'Search languages (name, native name or code)'}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        disabled={disabled || rows.length === 0}
        aria-label="Search target languages"
      />
      {disabled && disabledReason !== undefined && <p className={styles.note}>{disabledReason}</p>}
      {!disabled && rows.length > 0 && (
        <ul className={styles.list} aria-label="Language catalogue">
          {candidates.map((row) => (
            <li key={row.code} className={styles.row}>
              <button
                type="button"
                className={styles.rowButton}
                disabled={!isAddableTarget(row)}
                title={row.reason ?? STATE_WORDS[row.targetState ?? row.state]}
                onClick={() => onToggle(row.code, true)}
              >
                <span className={styles.rowLabel}>
                  {row.label}
                  {row.nativeName !== undefined && row.nativeName !== row.label ? <small> {row.nativeName}</small> : null}
                  {row.degraded ? <small> · {DEGRADED_WORD.toLowerCase()}</small> : null}
                </span>
                <StateBadge state={row.targetState ?? row.state} />
              </button>
            </li>
          ))}
          {candidates.length === 0 && <li className={styles.empty}>No language matches that.</li>}
        </ul>
      )}
    </div>
  );
}

/** Source language: auto-detect, or one language chosen from the catalogue. */
export function SourceLanguageSelect({
  rows,
  value,
  mode,
  disabled = false,
  onChange,
}: {
  readonly rows: readonly LanguageRow[];
  readonly value: string;
  readonly mode: 'manual' | 'auto-detect';
  readonly disabled?: boolean;
  readonly onChange: (next: { value: string; mode: 'manual' | 'auto-detect' }) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const current = rows.find((row) => row.code === value);
  const candidates = useMemo(() => filterLanguages(rows, query, 10), [rows, query]);
  return (
    <div className={styles.wrap}>
      <div className={styles.modeRow} role="group" aria-label="Source language mode">
        <button type="button" className={mode === 'auto-detect' ? styles.modeActive : styles.mode} aria-pressed={mode === 'auto-detect'} disabled={disabled} onClick={() => onChange({ value, mode: 'auto-detect' })}>
          Auto-detect
        </button>
        <span className={styles.or}>or</span>
        <button type="button" className={mode === 'manual' ? styles.modeActive : styles.mode} aria-pressed={mode === 'manual'} disabled={disabled} onClick={() => onChange({ value, mode: 'manual' })}>
          Select manually
        </button>
      </div>
      {mode === 'manual' && (
        <>
          <p className={styles.current}>
            Source: <strong>{current?.label ?? value.toUpperCase()}</strong>
          </p>
          <input
            type="search"
            className={styles.search}
            placeholder="Search source language"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={disabled || rows.length === 0}
            aria-label="Search source language"
          />
          {query.length > 0 && (
            <ul className={styles.list} aria-label="Source language matches">
              {candidates.map((row) => (
                <li key={row.code} className={styles.row}>
                  <button type="button" className={styles.rowButton} disabled={!isSelectableSource(row)} title={isSelectableSource(row) ? undefined : row.reason} onClick={() => { onChange({ value: row.code, mode: 'manual' }); setQuery(''); }}>
                    <span className={styles.rowLabel}>{row.label}{row.nativeName !== undefined && row.nativeName !== row.label ? <small> {row.nativeName}</small> : null}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {mode === 'auto-detect' && (
        <p className={styles.note}>Auto-detect is beta: low-confidence detections ask for confirmation once the programme is running.</p>
      )}
    </div>
  );
}
