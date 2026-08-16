/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import { isDiagnosticsRequested } from './viewerDiagnostics';

describe('isDiagnosticsRequested', () => {
  it('is off for an ordinary viewer arriving from a shared link', () => {
    // The case that matters: this is how essentially every real viewer opens
    // the page, and none of them should see engineering surfaces.
    expect(isDiagnosticsRequested('')).toBe(false);
    expect(isDiagnosticsRequested('?session=abc123')).toBe(false);
  });

  it('opens only on an explicit affirmative flag', () => {
    expect(isDiagnosticsRequested('?diagnostics=1')).toBe(true);
    expect(isDiagnosticsRequested('?diagnostics=true')).toBe(true);
    expect(isDiagnosticsRequested('?session=abc&diagnostics=on')).toBe(true);
  });

  it('treats a bare or negative flag as off', () => {
    // ?diagnostics with no value is far more likely to be a stray character in
    // a pasted link than a request for internals.
    expect(isDiagnosticsRequested('?diagnostics')).toBe(false);
    expect(isDiagnosticsRequested('?diagnostics=0')).toBe(false);
    expect(isDiagnosticsRequested('?diagnostics=false')).toBe(false);
  });

  it('does not expose diagnostics because a query string was malformed', () => {
    expect(isDiagnosticsRequested('?%%%')).toBe(false);
  });

  it('accepts a search string with or without its leading question mark', () => {
    expect(isDiagnosticsRequested('diagnostics=1')).toBe(true);
  });
});
