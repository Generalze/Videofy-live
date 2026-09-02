/** @author masterzee001 */
/**
 * T1 — the timer must stop when the call does.
 *
 * Two clocks run during a call and only one of them belongs to this app. The
 * screen's own timer stops on the terminal state. The SYSTEM's timer belongs
 * to the self-managed Telecom connection, and an answered call's connection is
 * deliberately left running by IncomingCallService -- `reason != "answered"`
 * -- so `reportCallEnded` is the only thing in the product that ever closes
 * one. Nothing called it. The OS went on counting behind a screen that had
 * already said the call was over, and, in the native module's own words, an
 * un-ended connection blocks every later call.
 *
 * Evidence for T1 alone. Nothing here is evidence about video, ringing,
 * notifications, or the hangup paint (T2), which have their own tests.
 */
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TERMINAL_DIRECT_STATES } from '../call/directCallApi';

const screen = readFileSync(
  fileURLToPath(new URL('../screens/CallScreen.tsx', import.meta.url)),
  'utf8',
).replace(/\r\n/gu, '\n');

describe('every terminal state the server can send is terminal here', () => {
  /*
   * The ruling names these six. A state missing from the set is a state the
   * timer keeps running through, so the list is pinned rather than trusted.
   */
  it.each(['busy', 'declined', 'no_answer', 'unavailable', 'network', 'ended'])(
    '%s stops the call',
    (state) => {
      expect(TERMINAL_DIRECT_STATES.has(state)).toBe(true);
    },
  );

  it('holds nothing else, so a live call is never mistaken for a dead one', () => {
    expect([...TERMINAL_DIRECT_STATES].sort()).toEqual(
      ['busy', 'declined', 'ended', 'network', 'no_answer', 'unavailable'].sort(),
    );
    for (const live of ['calling', 'ringing', 'answered', 'connecting', 'connected', 'reconnecting']) {
      expect(TERMINAL_DIRECT_STATES.has(live)).toBe(false);
    }
  });
});

describe('the screen timer stops on the terminal state', () => {
  it('ticks only while there is an origin and the call has not ended', () => {
    expect(screen).toContain('if (connectedAtMs === null || terminal) return undefined;');
  });

  it('derives terminal from the server state, not from the timer or the socket', () => {
    expect(screen).toContain(
      'const terminal = serverState !== null && TERMINAL_DIRECT_STATES.has(serverState);',
    );
  });
});

describe("the system's own call timer is stopped too", () => {
  it('ends the Telecom connection when the server says the call is over', () => {
    expect(screen).toContain('videofyCall.reportCallEnded(wire.callId)');
    expect(screen).toContain('TERMINAL_DIRECT_STATES.has(wire.state) && !endReported.current');
  });

  it('ends it exactly once, however many times the state repeats', () => {
    expect(screen).toContain('endReported.current = true;');
  });

  it('ends it even when the screen goes away before a terminal state arrives', () => {
    // Navigating back mid-dial must not leave a connection open: the native
    // module warns that one blocks every later call.
    expect(screen).toContain('!endReportedAtStart.current');
    expect(screen).toContain('videofyCall.reportCallEnded(callId)');
  });

  it('does not depend on which side hung up', () => {
    // The trigger is the authoritative server state, so a remote hangup
    // closes the connection exactly as a local one does.
    const accept = screen.slice(screen.indexOf('const acceptDirectState'));
    expect(accept.slice(0, accept.indexOf('setServerState'))).toContain('reportCallEnded');
  });
});
