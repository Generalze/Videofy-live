/**
 * Who may reprice the platform.
 *
 * Every test here is about a refusal. The happy path is one line; the value of
 * the module is entirely in what it says no to, and in the direction it fails
 * when it is misconfigured.
 */
import { describe, expect, it } from 'vitest';
import { admitPlatformOperator, parseOperatorAllowlist } from '../platform-operator.js';

const OPERATORS = new Set(['acct_zoe', 'acct_ops']);

describe('admission', () => {
  it('admits a verified account on the list', () => {
    const result = admitPlatformOperator({
      accountId: 'acct_zoe',
      verified: true,
      allowlist: OPERATORS,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountId).toBe('acct_zoe');
  });

  /*
   * THE ONE THAT MATTERS. An unconfigured deployment denies everybody. The
   * other default -- treating "no operators listed" as "no restriction" --
   * hands the price list to anyone holding a session, and it is the single
   * most costly way this file could be wrong.
   */
  it('denies everybody when no operators are configured', () => {
    const result = admitPlatformOperator({
      accountId: 'acct_zoe',
      verified: true,
      allowlist: new Set(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-operators-configured');
  });

  it('denies an account that is not on the list', () => {
    const result = admitPlatformOperator({
      accountId: 'acct_stranger',
      verified: true,
      allowlist: OPERATORS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-a-platform-operator');
  });

  it('denies an unauthenticated caller', () => {
    const result = admitPlatformOperator({
      accountId: null,
      verified: true,
      allowlist: OPERATORS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-authenticated');
  });

  it('treats an empty account id as unauthenticated', () => {
    const result = admitPlatformOperator({ accountId: '', verified: true, allowlist: OPERATORS });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-authenticated');
  });

  /*
   * An allowlist entry is a durable grant written months ago; verification is a
   * live fact. An operator who has lost a second factor or tripped a
   * restriction should not still be able to reprice the platform.
   */
  it('denies a listed operator who is no longer verified', () => {
    const result = admitPlatformOperator({
      accountId: 'acct_zoe',
      verified: false,
      allowlist: OPERATORS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-verified');
  });

  /* Case matters: account ids are opaque, not names. */
  it('does not match a different case', () => {
    expect(
      admitPlatformOperator({ accountId: 'ACCT_ZOE', verified: true, allowlist: OPERATORS }).ok,
    ).toBe(false);
  });
});

describe('reading the allowlist out of a deployment', () => {
  it('reads a comma separated list', () => {
    expect(parseOperatorAllowlist('acct_a,acct_b')).toEqual(new Set(['acct_a', 'acct_b']));
  });

  it('reads whitespace and newlines', () => {
    expect(parseOperatorAllowlist('acct_a acct_b\nacct_c')).toEqual(
      new Set(['acct_a', 'acct_b', 'acct_c']),
    );
  });

  /* A trailing comma must not become an empty operator that matches nothing. */
  it('drops empty entries from a trailing separator', () => {
    expect(parseOperatorAllowlist('acct_a, acct_b, ')).toEqual(new Set(['acct_a', 'acct_b']));
  });

  it('reads an unset variable as no operators, not as no restriction', () => {
    expect(parseOperatorAllowlist(undefined).size).toBe(0);
    expect(parseOperatorAllowlist('').size).toBe(0);
    expect(parseOperatorAllowlist('   ').size).toBe(0);
  });
});
