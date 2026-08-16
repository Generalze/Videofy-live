/**
 * A call code is something you read out; an invite link is something you send.
 *
 * Both address the same call — the link simply carries the code so the person
 * receiving it never has to type anything. The code stays visible because it is
 * what works over a phone call or written on a whiteboard.
 */
const CALL_QUERY_PARAM = 'call';

/** Shareable URL for a call code, based on wherever this app is being served. */
export function buildInviteLink(callCode: string, origin: string, pathname = '/'): string {
  const code = callCode.trim();
  if (!code) return '';
  const base = origin.replace(/\/+$/, '');
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${path}?${CALL_QUERY_PARAM}=${encodeURIComponent(code)}`;
}

/**
 * The call code an invite link is pointing at, or null.
 *
 * Returns the raw value; the caller normalises it exactly as it would a typed
 * code, so a link cannot smuggle in a code shape the form would have rejected.
 */
export function callCodeFromLocation(search: string): string | null {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (!query) return null;
  const value = new URLSearchParams(query).get(CALL_QUERY_PARAM);
  return value && value.trim() !== '' ? value : null;
}
