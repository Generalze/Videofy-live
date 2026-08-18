/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_CALL_ID_PREFIX,
  PublicCallIdSchema,
  createPublicCallId,
  parsePublicCallId,
} from '../index.js';

describe('public call ids', () => {
  it('accepts vc_ plus exactly 16 alphanumerics, mixed case included', () => {
    for (const candidate of ['vc_0123456789abcdef', 'vc_ABCDEFabcdef0123', 'vc_aA0bB1cC2dD3eE4f']) {
      expect(PublicCallIdSchema.safeParse(candidate).success).toBe(true);
      expect(parsePublicCallId(candidate)).toBe(candidate);
    }
  });

  it('refuses everything that is not the locked shape', () => {
    const rejected = [
      '',
      'vc_',
      'vc_0123456789abcde', // 15
      'vc_0123456789abcdef0', // 17
      'vc_0123456789abcde-', // non-alphanumeric
      'vc_0123456789abcde_',
      'VC_0123456789abcdef', // prefix is case-sensitive
      '0123456789abcdef', // no prefix
      'acct_0123456789abcdef', // a different id family is not a call id
      42,
      null,
      undefined,
      { callId: 'vc_0123456789abcdef' },
    ];
    for (const candidate of rejected) {
      expect(PublicCallIdSchema.safeParse(candidate).success).toBe(false);
      expect(parsePublicCallId(candidate)).toBeNull();
    }
  });

  it('mints via injected randomness', () => {
    const minted = createPublicCallId(() => 'deadbeef00112233');
    expect(minted).toBe(`${PUBLIC_CALL_ID_PREFIX}deadbeef00112233`);
  });

  it('refuses a generator that does not produce the locked shape', () => {
    expect(() => createPublicCallId(() => 'short')).toThrow(/16 alphanumeric/);
    expect(() => createPublicCallId(() => 'deadbeef0011223344')).toThrow(/16 alphanumeric/);
    expect(() => createPublicCallId(() => 'deadbeef0011223!')).toThrow(/16 alphanumeric/);
  });
});
