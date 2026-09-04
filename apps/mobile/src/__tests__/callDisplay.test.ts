/** @author masterzee001 */
/**
 * The screen says what the SERVER says.
 *
 * The defect these pin: the connected row rendered whenever `connectedAtMs`
 * existed and read "Connected" for any non-terminal state that was not
 * `reconnecting`. Because `connectedAtMs` is set once and never cleared, a
 * server that moved back to `connecting` -- after a renegotiation, or on the
 * way through `answered` -- still showed Connected. The caller's screen and the
 * call itself disagreed, silently, which is the whole class of bug this wave
 * exists to remove.
 *
 * The distinction that has to survive:
 *   connectedAtMs -> WHEN it first connected. Never moves. Drives the duration.
 *   serverState   -> WHAT it is doing now. Drives every word.
 */
import { describe, expect, it } from 'vitest';
import { connectedRow, isTerminal, liveStateOf, stateLine } from '../call/callDisplay';

const PEER = 'Ada';
const ORIGIN = 1_700_000_000_000;

describe('the row beneath the timer follows the server', () => {
  it('says Connected only when the server says connected', () => {
    const row = connectedRow('connected', ORIGIN, PEER);
    expect(row.show).toBe(true);
    expect(row.words).toBe('Connected');
    expect(row.warn).toBe(false);
  });

  it('does NOT say Connected merely because the call once connected', () => {
    // The exact regression. An origin exists; the server has gone back to
    // connecting. The screen must follow the server.
    const row = connectedRow('connecting', ORIGIN, PEER);
    expect(row.show).toBe(true);
    expect(row.words).toBe('Connecting…');
    expect(row.words).not.toBe('Connected');
    expect(row.warn).toBe(true);
  });

  it('shows the reconnect sentence, and only one of them', () => {
    /*
     * This state read "Network issue — reconnecting…" in one place and
     * "Reconnecting…" in the other, for the identical state. One state, one
     * sentence, from one function.
     */
    const row = connectedRow('reconnecting', ORIGIN, PEER);
    expect(row.words).toBe(stateLine('reconnecting', 'caller', PEER));
    expect(row.warn).toBe(true);
  });

  it('shows nothing before the call has ever connected', () => {
    expect(connectedRow('ringing', null, PEER).show).toBe(false);
  });

  it('shows nothing once the call is over, however long it ran', () => {
    // A running timer under "Call ended" is not something anybody wants.
    for (const state of ['ended', 'declined', 'busy', 'no_answer', 'unavailable', 'network']) {
      expect(connectedRow(state, ORIGIN, PEER).show, state).toBe(false);
    }
  });

  it('warns for every non-connected live state', () => {
    for (const state of ['calling', 'ringing', 'answered', 'connecting', 'reconnecting']) {
      expect(connectedRow(state, ORIGIN, PEER).warn, state).toBe(true);
    }
  });
});

describe('liveStateOf separates "doing now" from "reached the end"', () => {
  it('passes a live state straight through', () => {
    expect(liveStateOf('connecting')).toBe('connecting');
  });

  it('reports no live state once terminal', () => {
    expect(liveStateOf('ended')).toBeNull();
    expect(liveStateOf(null)).toBeNull();
  });

  it('agrees with isTerminal on all twelve states', () => {
    const live = ['calling', 'ringing', 'answered', 'connecting', 'connected', 'reconnecting'];
    const done = ['busy', 'declined', 'no_answer', 'unavailable', 'network', 'ended'];
    for (const state of live) {
      expect(isTerminal(state), state).toBe(false);
      expect(liveStateOf(state), state).toBe(state);
    }
    for (const state of done) {
      expect(isTerminal(state), state).toBe(true);
      expect(liveStateOf(state), state).toBeNull();
    }
  });
});

describe('before the server has said anything', () => {
  it('a caller reads Calling and a callee reads Connecting', () => {
    // The one thing the device knows for certain without the server is which
    // end of the call it is. "Joining" belongs to conferences, never here.
    expect(stateLine(null, 'caller', PEER)).toBe(`Calling ${PEER}…`);
    expect(stateLine(null, 'callee', PEER)).toBe('Connecting…');
    expect(stateLine(null, 'caller', PEER)).not.toMatch(/Joining/u);
  });

  it('defers to the server the moment it speaks', () => {
    expect(stateLine('ringing', 'caller', PEER)).toBe('Ringing…');
    expect(stateLine('declined', 'caller', PEER)).toBe('Call declined');
  });
});
