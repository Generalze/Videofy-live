/**
 * An operator's own channel.
 *
 * The rule that carries the most weight here is the one about a private channel
 * with no code: the gateway refuses everybody in that state, deliberately, and
 * the console has to say so before an operator goes hunting for a bug.
 */
import { describe, expect, it } from 'vitest';
import {
  canShareCodedLink,
  generateJoinCode,
  resolveViewerOrigin,
  shareableViewerLink,
  toSettingsPayload,
  validateSettings,
  VISIBILITY_DESCRIPTIONS,
} from './channelSettings.js';

const draft = (over: Partial<Parameters<typeof validateSettings>[0]> = {}) => ({
  displayName: 'Sunday Service',
  visibility: 'public' as const,
  ...over,
});

describe('checking a settings draft', () => {
  it('accepts a named public channel', () => {
    expect(validateSettings(draft(), false)).toEqual([]);
  });

  it('requires a name viewers will see', () => {
    const problems = validateSettings(draft({ displayName: '   ' }), false);
    expect(problems[0]?.field).toBe('displayName');
  });

  /*
   * THE ONE THAT MATTERS. A private channel with no code refuses every viewer,
   * including its owner. Safe, but baffling if nobody says so.
   */
  it('refuses a private channel with no code at all', () => {
    const problems = validateSettings(draft({ visibility: 'private' }), false);
    expect(problems[0]?.field).toBe('code');
    expect(problems[0]?.message).toContain('including you');
  });

  it('accepts a private channel that already has a code set', () => {
    expect(validateSettings(draft({ visibility: 'private' }), true)).toEqual([]);
  });

  it('accepts a private channel that is being given a code now', () => {
    expect(validateSettings(draft({ visibility: 'private', code: 'good-code' }), false)).toEqual([]);
  });

  it('refuses a private channel whose code is being cleared', () => {
    const problems = validateSettings(draft({ visibility: 'private', code: null }), true);
    expect(problems[0]?.field).toBe('code');
  });

  it('refuses a code short enough to guess', () => {
    const problems = validateSettings(draft({ visibility: 'private', code: 'abc' }), false);
    expect(problems.some((problem) => problem.message.includes('guessable'))).toBe(true);
  });

  it('allows a code on a public channel without complaint', () => {
    expect(validateSettings(draft({ visibility: 'public', code: 'good-code' }), false)).toEqual([]);
  });
});

describe('the payload sent to the gateway', () => {
  it('trims the name', () => {
    expect(toSettingsPayload(draft({ displayName: '  Sunday Service  ' })).displayName).toBe(
      'Sunday Service',
    );
  });

  /*
   * A code goes on the wire only when it changed. Resending it on every rename
   * would put a live join code into every settings round trip.
   */
  it('omits the code when it was not touched', () => {
    expect(toSettingsPayload(draft())).not.toHaveProperty('code');
  });

  it('sends null to clear a code', () => {
    expect(toSettingsPayload(draft({ code: null })).code).toBeNull();
  });

  it('sends a new code when one was set', () => {
    expect(toSettingsPayload(draft({ code: 'good-code' })).code).toBe('good-code');
  });
});

describe('generating a join code', () => {
  const bytes = (...values: number[]) => () => Uint8Array.from(values);

  it('is the length asked for', () => {
    expect(generateJoinCode(() => Uint8Array.from(Array.from({ length: 10 }, () => 0)), 10)).toHaveLength(
      10,
    );
  });

  /* Read aloud, written down, retyped from a photograph. */
  it('leaves out characters that are misread', () => {
    const code = generateJoinCode(() => Uint8Array.from(Array.from({ length: 64 }, (_, i) => i)), 64);
    expect(code).not.toMatch(/[O0Il1]/);
  });

  it('is deterministic given its random source, so this is testable at all', () => {
    expect(generateJoinCode(bytes(0, 1, 2), 3)).toBe(generateJoinCode(bytes(0, 1, 2), 3));
  });

  it('changes when the random source changes', () => {
    expect(generateJoinCode(bytes(0, 1, 2), 3)).not.toBe(generateJoinCode(bytes(9, 8, 7), 3));
  });
});

describe('the link an operator hands out', () => {
  const ORIGIN = 'https://watch.example.com';

  it('points at the viewer app, not the console', () => {
    expect(shareableViewerLink(ORIGIN, 'abc123', 'public', null)).toBe(
      'https://watch.example.com/c/abc123',
    );
  });

  it('carries the code for a private channel', () => {
    expect(shareableViewerLink(ORIGIN, 'abc123', 'private', 'GOODCODE99')).toBe(
      'https://watch.example.com/c/abc123?code=GOODCODE99',
    );
  });

  /* An empty `?code=` would imply there is a code to find. */
  it('adds no code parameter to an unlisted channel', () => {
    expect(shareableViewerLink(ORIGIN, 'abc123', 'unlisted', 'GOODCODE99')).toBe(
      'https://watch.example.com/c/abc123',
    );
  });

  it('drops a trailing slash on the origin', () => {
    expect(shareableViewerLink(`${ORIGIN}/`, 'abc123', 'public', null)).toBe(
      'https://watch.example.com/c/abc123',
    );
  });
});

describe('whether a working link can still be built', () => {
  it('can always share a public or unlisted channel', () => {
    expect(canShareCodedLink('public', null)).toBe(true);
    expect(canShareCodedLink('unlisted', null)).toBe(true);
  });

  it('can share a private channel while the code is still in hand', () => {
    expect(canShareCodedLink('private', 'GOODCODE99')).toBe(true);
  });

  /*
   * The gateway reports that a code EXISTS, never what it is. After a reload
   * the console cannot rebuild a link that carries it, and must say so rather
   * than hand out one that will not work.
   */
  it('cannot share a private channel whose code it no longer holds', () => {
    expect(canShareCodedLink('private', null)).toBe(false);
  });
});

describe('the words shown next to each choice', () => {
  /* The unlisted/private distinction is the one people get wrong. */
  it('says the link alone is enough for unlisted', () => {
    expect(VISIBILITY_DESCRIPTIONS.unlisted).toContain('only thing needed');
  });

  it('says the link is not enough for private', () => {
    expect(VISIBILITY_DESCRIPTIONS.private).toContain('not enough');
  });
});

describe('resolving where the viewer app lives', () => {
  /*
   * Staging configures a PATH, because these bundles deliberately bake in no
   * hostname. The absolute origin comes from the page at runtime.
   */
  it('turns a configured path into an absolute link on the current origin', () => {
    expect(resolveViewerOrigin('/listen', 'https://c7.example.com')).toBe(
      'https://c7.example.com/listen',
    );
  });

  /* Local development runs the viewer on its own port, not its own path. */
  it('passes an absolute origin through unchanged', () => {
    expect(resolveViewerOrigin('http://localhost:5173', 'http://localhost:5174')).toBe(
      'http://localhost:5173',
    );
  });

  it('handles a viewer served at the site root', () => {
    expect(resolveViewerOrigin('/', 'https://c7.example.com')).toBe('https://c7.example.com');
  });

  it('produces a link somebody can actually be sent', () => {
    const origin = resolveViewerOrigin('/listen', 'https://c7.example.com');
    expect(shareableViewerLink(origin, 'abc123', 'public', null)).toBe(
      'https://c7.example.com/listen/c/abc123',
    );
  });
});
