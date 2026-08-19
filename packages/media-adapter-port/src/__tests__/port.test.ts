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
  it('names no transport and imports nothing', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    const code = source
      .split('\n')
      // Prose may NAME the transports it exists to serve; the contract may not.
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/*'))
      .join('\n');
    for (const transport of ['Zoom', 'zoom', 'LiveKit', 'livekit', 'SIP', 'RTMS', 'RTP', 'WebRTC']) {
      expect(code).not.toContain(transport);
    }
    // A seam that imports has a direction; this one must not.
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\(/);
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
    await port.openSession({ sessionId: 's1', platformSessionRef: 'external-ref' });
    await port.participantJoined('s1', 'p_1', 'Ada');
    await port.pushAudio('s1', frame());
    await port.pushAudio('s1', frame({ platformTimestampMs: 1020 }));
    await port.participantLeft('s1', 'p_1');
    await port.closeSession('s1', 'ended');

    expect(port.sessions).toEqual([{ sessionId: 's1', platformSessionRef: 'external-ref' }]);
    expect(port.joins).toEqual([{ sessionId: 's1', participantId: 'p_1', displayName: 'Ada' }]);
    expect(port.frames.map((f) => f.platformTimestampMs)).toEqual([1000, 1020]);
    expect(port.leaves).toEqual([{ sessionId: 's1', participantId: 'p_1' }]);
    expect(port.closes).toEqual([{ sessionId: 's1', reason: 'ended' }]);
  });

  it('keeps concurrent sessions apart, so one meeting cannot read another', async () => {
    const port = new RecordingMediaAdapterPort();
    await port.openSession({ sessionId: 's1', platformSessionRef: 'a' });
    await port.openSession({ sessionId: 's2', platformSessionRef: 'b' });
    await port.pushAudio('s1', frame({ participantId: 'p_1' }));
    await port.pushAudio('s2', frame({ participantId: 'p_2' }));
    expect(port.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(port.frames.map((f) => f.participantId)).toEqual(['p_1', 'p_2']);
  });
});
