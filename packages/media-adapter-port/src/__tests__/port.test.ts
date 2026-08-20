/** @author masterzee001 */
/**
 * The seam's own suite. It has no transport to exercise, so what it pins is
 * the thing that actually matters about a shared contract: that it stays
 * transport-neutral, and that the reference port records faithfully enough for
 * every adapter's tests to trust it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RecordingMediaAdapterPort, type AdapterAudioFrame } from '../index.js';

function frame(overrides: Partial<AdapterAudioFrame> = {}): AdapterAudioFrame {
  return {
    participantId: 'p_1',
    samples: new Int16Array([0, 1, -1]),
    sampleRate: 16000,
    channelCount: 1,
    platformTimestampMs: 1000,
    ...overrides,
  };
}

describe('the seam stays transport-neutral', () => {
  it('names no transport, and depends on nothing outside itself', () => {
    // ADAPTED. This read one file and forbade the word `import` outright.
    //
    // The property it was protecting is stated in its own comment: "a seam that
    // imports has a direction; this one must not." A direction means pointing
    // at something ELSE — the seam being downstream of a transport, an engine,
    // a framework. A relative import between two files of this package is not
    // a direction; it is a file boundary, and the package still depends on
    // nothing.
    //
    // The package now has to be more than one file, because the authority
    // boundary requires it: `platform-identity.ts` is reachable only through
    // its own entry point, so an adapter importing this package does not find
    // the constructor for platform identity sitting next to the one it should
    // be using. Forbidding all imports would have forced that boundary back
    // into a single file and made the brand cosmetic.
    //
    // So the pin now checks the accurate invariant — nothing leaves the
    // package — across EVERY source file rather than just the entry point,
    // which makes it stricter than what it replaces.
    const sources = ['../index.ts', '../identity.ts', '../platform-identity.ts'];
    for (const relative of sources) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      const code = source
        .split('\n')
        // Prose may NAME the transports it exists to serve; the contract may not.
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/*'))
        .join('\n');

      for (const transport of ['Zoom', 'zoom', 'LiveKit', 'livekit', 'SIP', 'RTMS', 'RTP', 'WebRTC']) {
        expect(code, `${relative} names ${transport}`).not.toContain(transport);
      }

      expect(code, `${relative} uses require()`).not.toMatch(/\brequire\(/);
      // Every module specifier must be relative. A bare specifier is a
      // dependency, and a dependency is a direction.
      for (const match of code.matchAll(/from\s+'([^']+)'/g)) {
        expect(match[1], `${relative} imports outside the package`).toMatch(/^\.\.?\//);
      }
    }
  });

  it('carries only what the engine needs: who, what, when', () => {
    const audio = frame();
    expect(Object.keys(audio).sort()).toEqual([
      'channelCount',
      'participantId',
      'platformTimestampMs',
      'sampleRate',
      'samples',
    ]);
    // The engine's format is fixed at the seam, not negotiated across it.
    expect(audio.sampleRate).toBe(16000);
    expect(audio.channelCount).toBe(1);
  });
});

describe('RecordingMediaAdapterPort', () => {
  it('records a whole session in order', async () => {
    const port = new RecordingMediaAdapterPort();
    await port.openSession({ sessionRef: 's1', platformSessionRef: 'external-ref' });
    await port.participantJoined('s1', 'p_1', 'Ada');
    await port.pushAudio('s1', frame());
    await port.pushAudio('s1', frame({ platformTimestampMs: 1020 }));
    await port.participantLeft('s1', 'p_1');
    await port.closeSession('s1', 'ended');

    expect(port.sessions).toEqual([{ sessionRef: 's1', platformSessionRef: 'external-ref' }]);
    expect(port.joins).toEqual([{ sessionRef: 's1', participantId: 'p_1', displayName: 'Ada' }]);
    expect(port.frames.map((f) => f.platformTimestampMs)).toEqual([1000, 1020]);
    expect(port.leaves).toEqual([{ sessionRef: 's1', participantId: 'p_1' }]);
    expect(port.closes).toEqual([{ sessionRef: 's1', reason: 'ended' }]);
  });

  it('keeps concurrent sessions apart, so one meeting cannot read another', async () => {
    const port = new RecordingMediaAdapterPort();
    await port.openSession({ sessionRef: 's1', platformSessionRef: 'a' });
    await port.openSession({ sessionRef: 's2', platformSessionRef: 'b' });
    await port.pushAudio('s1', frame({ participantId: 'p_1' }));
    await port.pushAudio('s2', frame({ participantId: 'p_2' }));
    expect(port.sessions.map((s) => s.sessionRef)).toEqual(['s1', 's2']);
    expect(port.frames.map((f) => f.participantId)).toEqual(['p_1', 'p_2']);
  });
});
