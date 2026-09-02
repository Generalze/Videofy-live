/** @author masterzee001 */
/**
 * THE PRODUCTION LOAD PATH, ACTUALLY EXECUTED.
 *
 * Every other test of these gates injects `loadRegistry`, which is right for
 * testing the DECISIONS -- and it meant the default loader, the only one a
 * deployment ever uses, was never run by anything.
 *
 * It was broken in two ways at once, and staging found them, not the suite:
 *
 *   `require(...)` IN AN ESM SERVICE. Both services declare `type: module`, so
 *   `require` is not defined at runtime. The load threw, the builder caught it,
 *   and every gate failed closed. Which is the SAFE direction -- and exactly
 *   why nobody noticed: a gate refusing everything is indistinguishable from a
 *   deployment with no approved routes.
 *
 *   `{ documentPath }` INSTEAD OF `{ path }`. That option does not exist on
 *   LoadOptions, so an explicitly configured document was ignored and the
 *   loader fell through to the environment variable -- which names the same
 *   file, so the wrong argument was masked by a fallback that agreed with it.
 *
 * A test that mocks the seam it is protecting protects nothing. This one calls
 * the real thing, with no injection, and asserts it comes back loaded.
 */
import { describe, expect, it } from 'vitest';
import { createCallLiveRouteAuthority } from '../call-live-route-authority.js';

describe('the call-live authority loads a real document with no injection', () => {
  it('does NOT fail closed on the shipped seed', () => {
    // No loadRegistry: this is the path a deployment takes.
    const authority = createCallLiveRouteAuthority();
    expect(
      authority.description,
      'the default loader failed; a deployment would refuse every route',
    ).not.toMatch(/FAILED CLOSED/u);
    expect(authority.description).toMatch(/route document loaded/u);
  });

  it('answers from the document rather than refusing blindly', () => {
    /*
     * The shipped seed approves NOTHING, so the answer is still no -- but for
     * the right reason. The two are distinguished by the explanation: a loaded
     * registry names the direction and the scope, a failed load says it could
     * not read the document at all.
     */
    const authority = createCallLiveRouteAuthority();
    expect(authority.approved('en', 'fr')).toBe(false);
    expect(authority.explain('en', 'fr')).not.toMatch(/could not be read/u);
  });

  it('still allows a same-language pair through the real loader', () => {
    expect(createCallLiveRouteAuthority().approved('en', 'en')).toBe(true);
  });

  it('an explicitly named document is actually read', () => {
    /*
     * The `documentPath`/`path` mix-up meant an explicit path was discarded.
     * Pointing at a file that does not exist must therefore FAIL CLOSED -- if
     * the argument were still being ignored, the seed would load and this would
     * report success.
     */
    const authority = createCallLiveRouteAuthority({
      documentPath: '/nonexistent/route-document-that-is-not-there.json',
    });
    expect(authority.description).toMatch(/FAILED CLOSED/u);
  });
});
