/** @author masterzee001 */
/**
 * Page-level facts that are not components: how the ten pages are grouped
 * and numbered on the rail, which are reserved, and the hook that follows
 * the hash. Kept apart from ConsoleShell.tsx so that file exports components
 * only (fast refresh).
 *
 * The grouping and numbering follow the golden masters (founder directive,
 * LOCKED 30 Aug 2026, OPERATOR PREMIUM UI GOLDEN MASTERS): "Setup & prepare"
 * carries 01 Overview to 07 Advertising; "Access & control" carries 08 Access,
 * 09 Preflight and 10 Live Control. The order is OPERATOR_PAGES' order; the
 * sections only cut it in two.
 */
import { useEffect, useState } from 'react';
import type { IconName } from './premium/icons';
import { OPERATOR_PAGES, pageFromHash, watchPage, type OperatorPage } from './router';

/**
 * Reserved pages: honest 'not yet' copy, no controls.
 *
 * EMPTY, AND THAT IS THE POINT. This held 'vocabulary', 'quality' and
 * 'advertising' long after all three shipped, so the navigation rail carried
 * `data-not-yet` on them and announced "(not yet available)" to screen readers
 * about pages that fetch live route evidence and accept durable edits. A test
 * asserting the count matched the set size passed happily throughout, which is
 * how the wrong answer stayed locked in.
 *
 * Sighted operators saw working pages; anyone using assistive technology was
 * told not to bother. Add a page here only while it genuinely has no controls,
 * and take it out in the same commit that gives it some.
 */
export const NOT_YET_PAGES: ReadonlySet<OperatorPage> = new Set<OperatorPage>();

export interface ConsoleSection {
  readonly id: 'setup' | 'access';
  /** The rail eyebrow, as the masters print it. */
  readonly label: string;
  readonly pages: readonly OperatorPage[];
}

export const CONSOLE_SECTIONS: readonly ConsoleSection[] = [
  { id: 'setup', label: 'Setup & prepare', pages: ['overview', 'source', 'languages', 'audio', 'vocabulary', 'quality', 'advertising'] },
  { id: 'access', label: 'Access & control', pages: ['access', 'preflight', 'live'] },
];

/** "01" to "10": the page's position in OPERATOR_PAGES, zero-padded as the masters show it. */
export const PAGE_NUMBERS: Readonly<Record<OperatorPage, string>> = Object.fromEntries(
  OPERATOR_PAGES.map((page, index) => [page, String(index + 1).padStart(2, '0')]),
) as Record<OperatorPage, string>;

/** The line icon beside each page on the rail. */
export const PAGE_ICONS: Readonly<Record<OperatorPage, IconName>> = {
  overview: 'home',
  source: 'camera',
  languages: 'globe',
  audio: 'waveform',
  vocabulary: 'book',
  quality: 'clock',
  advertising: 'megaphone',
  access: 'users',
  preflight: 'shield',
  live: 'broadcast',
};

/**
 * The console's release line, shown in the rail footer. The premium console
 * is the second generation of the operator surface; this is its line, not
 * the package version (0.1.0), which nobody reads.
 */
export const CONSOLE_RELEASE = 'v2.0';

export function useOperatorPage(): OperatorPage {
  const [page, setPage] = useState<OperatorPage>(() =>
    typeof window === 'undefined' ? 'overview' : pageFromHash(window.location.hash),
  );
  useEffect(() => watchPage(setPage), []);
  return page;
}
