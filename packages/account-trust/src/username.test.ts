/**
 * The C7 username, and why it is not the name shown in calls.
 *
 * Zoe's ruling: "c7 username is different from profile name that would appear
 * in calls or else our fraud check in protecting people adding id will be
 * flawed." These tests are that rule made enforceable -- what the username
 * refuses is the whole reason it exists as a separate field.
 */
import { describe, expect, it } from 'vitest';
import {
  checkDisplayName,
  checkUsernameShape,
  DISPLAY_NAME_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  usernameKey,
} from './username.js';

describe('what a username may look like', () => {
  it('accepts an ordinary handle', () => {
    const checked = checkUsernameShape('zoemeak');
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.username).toBe('zoemeak');
  });

  it('accepts dots and underscores between words', () => {
    expect(checkUsernameShape('zoe.meak').ok).toBe(true);
    expect(checkUsernameShape('zoe_meak').ok).toBe(true);
  });

  /* Folded on the way in, so one claim has one stored spelling. */
  it('lowercases rather than refusing a capital', () => {
    const checked = checkUsernameShape('ZoeMeak');
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.username).toBe('zoemeak');
  });

  it('refuses one that does not start with a letter', () => {
    expect(checkUsernameShape('7zoe').ok).toBe(false);
    expect(checkUsernameShape('.zoe').ok).toBe(false);
  });

  it('refuses runs of separators and trailing ones', () => {
    expect(checkUsernameShape('zoe..meak').ok).toBe(false);
    expect(checkUsernameShape('zoe_').ok).toBe(false);
  });

  it('refuses spaces, symbols and anything not plainly typable', () => {
    for (const bad of ['zoe meak', 'zoe@meak', 'zoe/meak', 'zoe-meak', 'zoé']) {
      expect(checkUsernameShape(bad).ok).toBe(false);
    }
  });

  it('holds the length bounds', () => {
    expect(checkUsernameShape('ab').ok).toBe(false);
    expect(checkUsernameShape(`a${'b'.repeat(USERNAME_MAX_LENGTH)}`).ok).toBe(false);
  });

  /*
   * A name that is mostly separators passes the shape test and folds to almost
   * nothing, so the length is checked again after folding.
   */
  it('refuses one that is mostly punctuation', () => {
    expect(checkUsernameShape('a.b').ok).toBe(false);
  });
});

describe('the skeleton, which is what uniqueness is really about', () => {
  /*
   * THE ANTI-IMPERSONATION PROPERTY. If `zoemeak` and `z0emeak` could both
   * exist, adding somebody by id would be exactly as unreliable as adding them
   * by the name shown in a call -- which is the thing the split exists to
   * prevent.
   */
  it('folds a digit substitution onto the letter it imitates', () => {
    expect(usernameKey('z0emeak')).toBe(usernameKey('zoemeak'));
    expect(usernameKey('a1ice')).toBe(usernameKey('alice'));
    expect(usernameKey('b0b')).toBe(usernameKey('bob'));
  });

  it('ignores separators, so punctuation cannot fake a new name', () => {
    expect(usernameKey('zoe.meak')).toBe(usernameKey('zoemeak'));
    expect(usernameKey('z.o.e.m.e.a.k')).toBe(usernameKey('zoemeak'));
  });

  it('folds i and j onto l, which are the pairs actually used', () => {
    expect(usernameKey('alice')).toBe(usernameKey('aljce'));
  });

  it('is case-insensitive', () => {
    expect(usernameKey('ZoeMeak')).toBe(usernameKey('zoemeak'));
  });

  /*
   * The accepted cost, stated as a test so nobody later "fixes" it: two
   * legitimately different names can collide. First come, first served.
   */
  it('collides two innocent names, and that is the trade', () => {
    expect(usernameKey('alice1')).toBe(usernameKey('alicel'));
  });
});

describe('names that claim to be C7', () => {
  it('refuses the obvious ones', () => {
    for (const reserved of ['admin', 'support', 'c7', 'videofy', 'billing', 'verified']) {
      expect(checkUsernameShape(reserved).ok).toBe(false);
    }
  });

  /*
   * Matched on the SKELETON. A reserved list matched literally is a list of the
   * one spelling nobody would have bothered trying.
   */
  it('refuses the spellings somebody would actually attempt', () => {
    for (const dodge of ['supp0rt', 's.u.p.p.o.r.t', 'adm1n', 'b1lling', 'v3rified']) {
      expect(checkUsernameShape(dodge).ok).toBe(false);
    }
  });
});

describe('the display name, which is a label and not an identity', () => {
  it('accepts a real name with spaces, accents and an apostrophe', () => {
    for (const name of ['Zoe Meak', "N'Golo Kanté", '张伟', 'Ami Sweet']) {
      expect(checkDisplayName(name).ok).toBe(true);
    }
  });

  /* Runs of spaces are how a name is padded to sit above another in a list. */
  it('collapses padding rather than preserving it', () => {
    const checked = checkDisplayName('  Zoe    Meak  ');
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.displayName).toBe('Zoe Meak');
  });

  it('refuses an empty name and an overlong one', () => {
    expect(checkDisplayName('   ').ok).toBe(false);
    expect(checkDisplayName('x'.repeat(DISPLAY_NAME_MAX_LENGTH + 1)).ok).toBe(false);
  });

  /*
   * A name may not imitate the interface around it. A bidirectional override
   * REORDERS what follows it, so a name can be made to render as another one
   * entirely; a zero-width joiner hides characters; a tick counterfeits a
   * verification badge nobody granted.
   */
  it('refuses characters that make a name render as something else', () => {
    const bidiOverride = `Zoe${String.fromCodePoint(0x202e)}kaem`;
    const zeroWidth = `Zoe${String.fromCodePoint(0x200b)}Meak`;
    const control = `Zoe${String.fromCodePoint(0x0007)}Meak`;

    expect(checkDisplayName(bidiOverride).ok).toBe(false);
    expect(checkDisplayName(zeroWidth).ok).toBe(false);
    expect(checkDisplayName(control).ok).toBe(false);
  });

  it('refuses a counterfeit verified badge', () => {
    expect(checkDisplayName(`Zoe Meak ${String.fromCodePoint(0x2705)}`).ok).toBe(false);
    expect(checkDisplayName(`Zoe Meak ${String.fromCodePoint(0x2714)}`).ok).toBe(false);
  });

  /*
   * The point of the split, asserted directly: a display name may be anything
   * a person is called, INCLUDING somebody else's username. It is not an
   * identity, so it is not checked against one -- what protects people is that
   * nobody is ever added by it.
   */
  it('allows a display name that copies another username, because it proves nothing', () => {
    expect(checkDisplayName('zoemeak').ok).toBe(true);
  });
});
