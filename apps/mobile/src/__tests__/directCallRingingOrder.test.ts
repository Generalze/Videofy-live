/** @author masterzee001 */
/**
 * Regression for Android calls that never reached ringing.
 *
 * Native microphone acquisition can prompt, stall or fail before the call is
 * created. Direct callers must create the gateway call and dispatch the ring
 * before media setup is allowed to block.
 */
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/gu, '\n');

const connection = read('../call/callConnection.ts');
const screen = read('../screens/CallScreen.tsx');

describe('direct caller ringing order', () => {
  it('does not acquire microphone before the initial join emit', () => {
    const joinStart = connection.indexOf('async join({ startMedia = true }');
    const joinEmit = connection.indexOf('CALL_EVENTS.JOIN', joinStart);
    const beforeJoinEmit = connection.slice(joinStart, joinEmit);

    expect(joinStart).toBeGreaterThanOrEqual(0);
    expect(joinEmit).toBeGreaterThan(joinStart);
    expect(beforeJoinEmit).not.toContain('openLocalMedia');
  });

  it('lets direct callers ring before media startup is awaited', () => {
    const join = screen.indexOf(
      'const ack = await link.join({ startMedia: onRing === undefined });',
    );
    const media = screen.indexOf('void link.startMedia();', join);
    const ring = screen.indexOf('const dispatch = await onRing(callId);', join);

    expect(join).toBeGreaterThanOrEqual(0);
    expect(media).toBeGreaterThan(join);
    expect(ring).toBeGreaterThan(media);
  });
});
