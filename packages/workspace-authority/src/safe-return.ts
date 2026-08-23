/**
 * `returnTo` — sending somebody back where they came from, safely.
 *
 * This parameter is the classic open redirect. A sign-in page that forwards to
 * whatever it was handed becomes a credible phishing launcher: the link starts
 * on a domain the victim trusts, they sign in for real, and the redirect lands
 * them somewhere else entirely. The URL bar said the right thing the whole way.
 *
 * The rule here is ALLOW-LIST, not deny-list. Blocking `javascript:` and
 * `//evil.example` is a game of remembering every encoding; requiring a value
 * to look exactly like an internal path is a rule with one answer.
 *
 * Anything that fails returns the default, never an error — a malformed
 * `returnTo` should quietly drop somebody at their home page, not show them a
 * stack trace about a parameter they never typed.
 */

export const DEFAULT_RETURN_TO = '/app/';

/** Prefixes a returnTo may land on. Everything else is refused. */
const ALLOWED_PREFIXES: readonly string[] = ['/app/', '/call/', '/listen/', '/operator/'];

/**
 * Control characters and spaces, written as ESCAPE SEQUENCES.
 *
 * A literal control character in a source file compiles, passes every test,
 * and makes the file undiffable - the hygiene gate refuses them for exactly
 * that reason.
 */
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

function decodeFully(value: string): string | null {
  // Decode repeatedly: `%252f` decodes to `%2f`, which decodes to `/`. Checking
  // a single-decoded string lets a double-encoded payload through.
  //
  // An UNDECODABLE value returns null rather than falling back to the raw
  // string. A malformed escape is something this code cannot reason about, and
  // different parsers disagree about what it means -- which is exactly the gap
  // a payload lives in. If it cannot be judged, it is not allowed.
  let current = value;
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

export function safeReturnTo(raw: unknown, fallback: string = DEFAULT_RETURN_TO): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return fallback;

  const decoded = decodeFully(raw);
  if (decoded === null) return fallback;

  // Control characters and whitespace are stripped by some parsers and honoured
  // by others; a value containing them cannot be reasoned about at all.
  if (CONTROL_OR_SPACE.test(decoded)) return fallback;

  // Must be a path. This one test removes every absolute URL, every scheme
  // (`javascript:`, `data:`, `http:`), and every protocol-relative `//host`.
  if (!decoded.startsWith('/')) return fallback;
  if (decoded.startsWith('//')) return fallback;
  // Backslash: some browsers normalise `/\evil.example` into `//evil.example`.
  if (decoded.includes('\\')) return fallback;
  // A scheme anywhere is a smell no legitimate internal path has.
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return fallback;
  // Traversal cannot help an absolute internal path and can only be an attempt
  // to escape the allow-list.
  if (decoded.includes('..')) return fallback;

  const path = decoded.split(/[?#]/)[0] ?? '';
  const allowed = ALLOWED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix) || `${path}/` === prefix,
  );
  if (!allowed) return fallback;

  // The ORIGINAL is returned once the decoded form has been judged, so a
  // legitimately encoded query string survives intact.
  return raw;
}

/** Whether a value would be accepted, for tests and for logging decisions. */
export function isSafeReturnTo(raw: unknown): boolean {
  const sentinel = 'rejected-sentinel';
  return safeReturnTo(raw, sentinel) !== sentinel;
}
