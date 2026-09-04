/** @author masterzee001 */
/**
 * ONE VOCABULARY FOR A DIRECT CALL, IN EVERY PLACE THAT NAMES ONE.
 *
 * The gateway's DirectCallLifecycle decides the transitions, so its list is the
 * authority. Three other files spell the same twelve words out, and until now
 * nothing checked that they agreed:
 *
 *   the wire type          was `state: string`
 *   the client snapshot    was `state: string`
 *   the mobile app         had its own union in callPhase.ts
 *
 * That mobile union carried `dialing` and `failed`, which the server never
 * sends, and lacked `ringing`, `reconnecting`, `busy`, `declined`, `no_answer`
 * and `network`, which it does. It survived because `string` accepts anything
 * and because nothing imported it except its own test -- an orphan
 * implementation with a contradictory enum, which is the worst of both.
 *
 * The unions are now real, and this compares them by TEXT because they live in
 * packages that deliberately do not depend on one another. A word added on one
 * side and forgotten on another fails here rather than in front of a caller.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERMINAL_STATES, type DirectCallState } from '../direct-call-lifecycle.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Line endings are checkout representation, not meaning. */
function read(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8').split('\r\n').join('\n');
}

/** The quoted members of a `export type NAME = | 'a' | 'b';` declaration. */
function unionMembers(source: string, name: string): string[] {
  const start = source.indexOf(`export type ${name} =`);
  expect(start, `no union named ${name}`).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf(';', start));
  return [...body.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!);
}

const AUTHORITY = unionMembers(
  read('services', 'realtime-gateway', 'src', 'direct-call-lifecycle.ts'),
  'DirectCallState',
);

describe('the gateway is the authority, and it says twelve things', () => {
  it('lists exactly the twelve states', () => {
    expect(AUTHORITY).toEqual([
      'calling', 'ringing', 'answered', 'connecting', 'connected', 'reconnecting',
      'busy', 'declined', 'no_answer', 'unavailable', 'network', 'ended',
    ]);
  });

  it('marks six of them terminal, and no others', () => {
    const terminal = AUTHORITY.filter((state) =>
      TERMINAL_STATES.has(state as DirectCallState));
    expect(terminal).toEqual(['busy', 'declined', 'no_answer', 'unavailable', 'network', 'ended']);
  });
});

describe('every other declaration matches it word for word', () => {
  it('the wire type', () => {
    const wire = unionMembers(
      read('packages', 'call-wire', 'src', 'wire-types.ts'),
      'DirectCallWireState',
    );
    expect(wire).toEqual(AUTHORITY);
  });

  it('the client snapshot type', () => {
    const snapshot = unionMembers(
      read('packages', 'call-client-core', 'src', 'callTypes.ts'),
      'DirectCallSnapshotState',
    );
    expect(snapshot).toEqual(AUTHORITY);
  });

  it('the mobile words the caller actually reads', () => {
    /*
     * `directStateWords` is the one place a state becomes a sentence. A state
     * the server can send but this switch does not name falls through to its
     * default and shows the operator a raw identifier.
     */
    const mobile = read('apps', 'mobile', 'src', 'call', 'directCallApi.ts');
    const cases = [...mobile.matchAll(/case '([a-z_]+)':/gu)].map((m) => m[1]!);
    for (const state of AUTHORITY) {
      expect(cases, `mobile has no words for "${state}"`).toContain(state);
    }
  });

  it('the mobile terminal set', () => {
    const mobile = read('apps', 'mobile', 'src', 'call', 'directCallApi.ts');
    const start = mobile.indexOf('TERMINAL_DIRECT_STATES');
    const body = mobile.slice(start, mobile.indexOf(']', start));
    const listed = [...body.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!).sort();
    const authoritative = AUTHORITY
      .filter((state) => TERMINAL_STATES.has(state as DirectCallState))
      .sort();
    // A client that thinks a terminal state is still live leaves somebody on a
    // call screen after the call is over.
    expect(listed).toEqual(authoritative);
  });
});

describe('the orphan vocabulary is gone', () => {
  it('callPhase.ts no longer exists', () => {
    // Imported only by its own test, and contradicting the server. Two state
    // systems for one call is one more than can ever be right.
    expect(() => read('apps', 'mobile', 'src', 'call', 'callPhase.ts')).toThrow();
  });

  it('no client invents a state the server cannot send', () => {
    const mobile = read('apps', 'mobile', 'src', 'call', 'directCallApi.ts');
    for (const invented of ['dialing', 'failed']) {
      expect(mobile, `"${invented}" is not a server state`).not.toMatch(
        new RegExp(`'${invented}'`, 'u'),
      );
    }
  });
});
