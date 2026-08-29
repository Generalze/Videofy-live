/** @author masterzee001 */
/**
 * Page-level facts that are not components: which pages are reserved, and
 * the hook that follows the hash. Kept apart from ConsoleShell.tsx so that
 * file exports components only (fast refresh).
 */
import { useEffect, useState } from 'react';
import { pageFromHash, watchPage, type OperatorPage } from './router';

/** Reserved pages: honest 'not yet' copy, no controls. */
export const NOT_YET_PAGES: ReadonlySet<OperatorPage> = new Set<OperatorPage>(['vocabulary', 'quality', 'advertising']);

export function useOperatorPage(): OperatorPage {
  const [page, setPage] = useState<OperatorPage>(() =>
    typeof window === 'undefined' ? 'overview' : pageFromHash(window.location.hash),
  );
  useEffect(() => watchPage(setPage), []);
  return page;
}
