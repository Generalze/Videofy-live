import { describe, expect, it } from 'vitest';
import { buildInviteLink, callCodeFromLocation } from './callInvite';

describe('buildInviteLink', () => {
  it('builds a link the recipient can click instead of typing a code', () => {
    expect(buildInviteLink('calm-river-42', 'http://localhost:5175')).toBe(
      'http://localhost:5175/?call=calm-river-42',
    );
  });

  it('keeps the app path, so it works when served under a subpath', () => {
    expect(buildInviteLink('calm-river-42', 'https://videofy.example', '/call')).toBe(
      'https://videofy.example/call?call=calm-river-42',
    );
  });

  it('escapes the code rather than trusting it into a URL', () => {
    expect(buildInviteLink('a b&c', 'https://x.test')).toBe('https://x.test/?call=a%20b%26c');
  });

  it('has nothing to share when there is no code yet', () => {
    expect(buildInviteLink('   ', 'https://x.test')).toBe('');
  });
});

describe('callCodeFromLocation', () => {
  it('reads the code out of an invite link', () => {
    expect(callCodeFromLocation('?call=calm-river-42')).toBe('calm-river-42');
    expect(callCodeFromLocation('call=calm-river-42')).toBe('calm-river-42');
  });

  it('ignores a link that is not an invite', () => {
    expect(callCodeFromLocation('')).toBeNull();
    expect(callCodeFromLocation('?other=1')).toBeNull();
    expect(callCodeFromLocation('?call=')).toBeNull();
  });

  it('returns the raw value so the caller normalises it like a typed code', () => {
    // A link must not be able to smuggle in a shape the form would reject.
    expect(callCodeFromLocation('?call=Calm%20River%2042')).toBe('Calm River 42');
  });
});
