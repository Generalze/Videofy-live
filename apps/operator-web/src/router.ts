/** @author masterzee001 */
/**
 * The console's pages, addressed by hash.
 *
 * HASH ROUTES, NOT PATHS. The console is served under /operator/ by the
 * static stager; a path route would depend on an SPA fallback for that
 * prefix that nothing has verified, and the shell cache lesson (index.html
 * with no Cache-Control) says not to add a second way for a route to break.
 * `#/languages` needs nothing from the proxy.
 *
 * TEN PAGES (founder ruling 29 Aug): dense configuration split into steps
 * rather than one crowded screen. Languages owns source + targets;
 * Preflight owns readiness; Live Control stays about the active programme.
 */
export const OPERATOR_PAGES = [
  'overview',
  'source',
  'languages',
  'audio',
  'vocabulary',
  'quality',
  'advertising',
  'access',
  'preflight',
  'live',
] as const;

export type OperatorPage = (typeof OPERATOR_PAGES)[number];

export const PAGE_TITLES: Record<OperatorPage, string> = {
  overview: 'Overview',
  source: 'Source',
  languages: 'Languages',
  audio: 'Audio & Voices',
  vocabulary: 'Programme Vocabulary',
  quality: 'Quality / Delay',
  advertising: 'Advertising',
  access: 'Access',
  preflight: 'Preflight',
  live: 'Live Control',
};

export function pageFromHash(hash: string): OperatorPage {
  const slug = hash.replace(/^#\/?/, '').split(/[/?#]/)[0]?.toLowerCase() ?? '';
  return (OPERATOR_PAGES as readonly string[]).includes(slug) ? (slug as OperatorPage) : 'overview';
}

export function hashForPage(page: OperatorPage): string {
  return `#/${page}`;
}

export function navigate(page: OperatorPage, target: { location: { hash: string } } = window): void {
  target.location.hash = hashForPage(page);
}

/** Subscribe to hash changes; returns the unsubscribe. */
export function watchPage(
  onChange: (page: OperatorPage) => void,
  target: { location: { hash: string }; addEventListener: Window['addEventListener']; removeEventListener: Window['removeEventListener'] } = window,
): () => void {
  const handler = (): void => onChange(pageFromHash(target.location.hash));
  target.addEventListener('hashchange', handler);
  return () => target.removeEventListener('hashchange', handler);
}
