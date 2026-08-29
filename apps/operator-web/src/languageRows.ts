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
  readonly state: CapabilityState;
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

