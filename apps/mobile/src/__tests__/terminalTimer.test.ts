/** @author masterzee001 */
/**
 * T1 — the clocks that must stop when the call does.
 *
 * A call runs two timers. The screen's own stops on the terminal state. The
 * system's belongs to the self-managed Telecom connection, which an ANSWERED
 * call deliberately keeps alive -- IncomingCallService only ends it when the
 * reason is not "answered" -- so it is closed later, by `reportCallEnded`.
 *
 * That chain runs across three files and no single one of them shows it, which
 * is why it is written down here: terminal state -> the screen leaves ->
 * App.tsx ends the Telecom connection. Breaking any link leaves the system
 * counting behind a screen that has already said the call is over.
 *
 * Evidence for T1 alone. Nothing here is evidence about video, ringing,
 * notifications, or the hangup paint (T2), each of which is tested separately.
 */
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TERMINAL_DIRECT_STATES } from '../call/directCallApi';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/gu, '\n');

const screen = read('../screens/CallScreen.tsx');
// The root component sits OUTSIDE src/, which is where the wiring lives.
const app = read('../../App.tsx');

describe('every terminal state the server can send is terminal here', () => {
  it.each(['busy', 'declined', 'no_answer', 'unavailable', 'network', 'ended'])(
    '%s ends the call',
    (state) => {
      expect(TERMINAL_DIRECT_STATES.has(state)).toBe(true);
    },
  );

  it('holds nothing else, so a live call is never mistaken for a dead one', () => {
    for (const live of ['calling', 'ringing', 'answered', 'connecting', 'connected', 'reconnecting']) {
      expect(TERMINAL_DIRECT_STATES.has(live)).toBe(false);
    }
  });
});

describe("the screen's own timer stops", () => {
  it('ticks only while there is an origin and the call has not ended', () => {
    expect(screen).toContain('if (connectedAtMs === null || terminal) return undefined;');
  });

  it('derives terminal from the server state, not the timer, roster or socket', () => {
    expect(screen).toContain(
      'const terminal = serverState !== null && TERMINAL_DIRECT_STATES.has(serverState);',
    );
  });
});

describe("the system's timer stops too, through the whole chain", () => {
  it('a terminal state leaves the call screen without anyone tapping', () => {
    expect(screen).toContain('if (!terminal) return undefined;');
    expect(screen).toContain('const timer = setTimeout(() => onLeave(), 2500);');
  });

  it('leaving ends the Telecom connection', () => {
    // Without this the connection outlives the call: the OS keeps counting,
    // and the native module warns an un-ended one blocks every later call.
    expect(app).toContain('videofyCall.reportCallEnded(activeCall.callId);');
  });

  it('declining ends it as well, since that call was never answered', () => {
    expect(app).toContain('videofyCall.reportCallEnded(ringing.callId);');
  });
});
