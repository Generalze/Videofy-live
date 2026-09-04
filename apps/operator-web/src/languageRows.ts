/** @author masterzee001 */
/**
 * Language rows and their search: pure, so the select components stay
 * components (fast refresh) and the filtering is testable on its own.
 */
export type CapabilityState = 'available' | 'qualified' | 'limited' | 'unavailable';

export interface LanguageRow {
  readonly code: string;
  readonly label: string;
  readonly nativeName?: string | undefined;
  /** The conservative word: the weakest of the three chain stages. */
  readonly state: CapabilityState;
  /**
   * The same evidence read one direction at a time.
   *
   * Gating a TARGET list on `state` is what made the console refuse Igbo:
   * no recogniser transcribes Igbo, which says nothing about whether a
   * listener can hear it. Absent on an older ingest, and never invented.
   */
  readonly sourceState?: CapabilityState | undefined;
  readonly targetState?: CapabilityState | undefined;
  /** Translation with no voice on the chain. Offerable, and labelled. */
  readonly captionsOnly?: boolean | undefined;
  /**
   * A Nigerian language being served by a general voice vendor instead of the
   * 9jaLingo specialist: audio plays, and a speaker can hear it is wrong.
   */
  readonly degraded?: boolean | undefined;
  /** Captions only: translation without a voice. */
  readonly textOnly?: boolean | undefined;
  readonly reason?: string | undefined;
}

export const STATE_WORDS: Record<CapabilityState, string> = {
  qualified: 'Qualified',
  available: 'Available',
  limited: 'Limited · beta',
  unavailable: 'Unavailable',
};

/** What each capability word means, for the legend; the same facts the old inline note carried. */
export const CAPABILITY_MEANINGS: readonly { state: CapabilityState; meaning: string }[] = [
  { state: 'qualified', meaning: 'Live evidence on this chain' },
  { state: 'available', meaning: 'Every stage declares it' },
  { state: 'limited', meaning: 'Beta or partial' },
  { state: 'unavailable', meaning: 'A stage has no provider' },
];

/** The word beside a degraded row. Short enough for a chip, plain enough to act on. */
export const DEGRADED_WORD = 'Degraded voice';

/**
 * May the operator ADD this language as a target?
 *
 * The question is about MT and TTS, never about recognition. A language with a
 * voice, or one that can at least be captioned, is offerable; one no engine
 * translates is not. Falls back to the conservative state for a catalogue from
 * an older ingest that does not send the per-direction words.
 */
export function isAddableTarget(row: LanguageRow): boolean {
  if (row.captionsOnly === true) return true;
  const target = row.targetState ?? row.state;
  return target !== 'unavailable';
}

/** May it be chosen as the language somebody SPEAKS? STT and MT. */
export function isSelectableSource(row: LanguageRow): boolean {
  return (row.sourceState ?? row.state) !== 'unavailable';
}

/** The two-letter tag the masters print beside a language: "EN", "PT" for pt-BR. */
export function languageTag(code: string): string {
  const base = code.split(/[-_]/)[0] ?? code;
  return base.slice(0, 2).toUpperCase();
}

function normalise(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function filterLanguages(rows: readonly LanguageRow[], query: string, limit = 12): readonly LanguageRow[] {
  const q = normalise(query.trim());
  const matches = q.length === 0
    ? rows
    : rows.filter((row) =>
        normalise(row.label).includes(q) ||
        (row.nativeName !== undefined && normalise(row.nativeName).includes(q)) ||
        row.code.toLowerCase().startsWith(q),
      );
  return matches.slice(0, limit);
}

