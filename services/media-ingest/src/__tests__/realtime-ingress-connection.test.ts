/** @author masterzee001 */
/**
 * C-AI1.1D pins for the realtime ingress state machine. No socket is bound:
 * every property here is about the contract, not about the network.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeIngressFrame,
  encodeAbort,
  encodeAudio,
  encodeError,
  encodeFinish,
  encodeOpen,
  encodeReady,
  IngressLimits,
  type IngressAudio,
} from '@videofy-live/media-ingress-wire';
import {
  RealtimeIngressConnection,
  type IngressStreamHandler,
} from '../realtime-ingress-connection.js';

function rig(options: { refuse?: boolean } = {}) {
  const audio: IngressAudio[] = [];
  const endings: string[] = [];
  const sent: Buffer[] = [];
  const closes: string[] = [];
  const handler: IngressStreamHandler = {
    onAudio: (frame) => { audio.push(frame); },
    finish: (reason) => { endings.push(`finish:${reason}`); },
    abort: (reason) => { endings.push(`abort:${reason}`); },
    disconnected: (reason) => { endings.push(`disconnected:${reason}`); },
  };
  const connection = new RealtimeIngressConnection({
    openStream: async () => (options.refuse === true ? null : handler),
    send: (frame) => { sent.push(frame); },
    close: (reason) => { closes.push(reason); },
  });
  const codes = (): string[] =>
    sent
      .map((frame) => decodeIngressFrame(frame))
      .flatMap((r) => (r.ok && r.frame.kind === 'error' ? [r.frame.code] : []));
  return { connection, audio, endings, sent, closes, codes };
}

const OPEN = encodeOpen({ sessionId: 'cs_1', streamId: 'st_1', serviceCategory: 'call' });

function pcm(sequence: number, platformTimestampMs: number, discontinuity = false): Buffer {
  return encodeAudio({
    sequence,
    platformTimestampMs,
    discontinuity,
    samples: Int16Array.from([sequence, sequence]),
  });
}

describe('a stream has to be opened before it can carry anything', () => {
  it('PIN: audio before OPEN is refused rather than inventing a stream', async () => {
    const r = rig();
    r.connection.handleMessage(pcm(0, 0));
    await r.connection.drain();
    // The mirror of the delivery rule: a producer cannot create platform state
    // by sending data into it.
    expect(r.audio).toHaveLength(0);
    expect(r.codes()).toEqual(['audio-before-open']);
  });

  it('PIN: a second OPEN is refused, not silently accepted', async () => {
    const r = rig();
    r.connection.handleMessage(OPEN);
    r.connection.handleMessage(OPEN);
    await r.connection.drain();
    // Accepting it would leave audio arriving against a stream identity that
    // had quietly changed underneath the sender.
    expect(r.codes()).toEqual(['stream-already-open']);
    expect(r.connection.openStreamId).toBe('st_1');
  });

  it('a refused stream gets no READY', async () => {
    const r = rig({ refuse: true });
    r.connection.handleMessage(OPEN);
    await r.connection.drain();
    expect(r.connection.openStreamId).toBeNull();
    expect(r.codes()).toEqual(['stream-not-open']);
  });
});

describe('sequence tells the receiver what the sender cannot', () => {
  it('PIN: a gap is reported as a discontinuity even when the flag is clear', async () => {
    const r = rig();
    r.connection.handleMessage(OPEN);
    r.connection.handleMessage(pcm(0, 1000));
    r.connection.handleMessage(pcm(3, 1060)); // 1 and 2 never arrived
    await r.connection.drain();
    // The sender knows about audio IT dropped; only the receiver knows about
    // frames that never arrived. A recogniser told a gap was continuous speech
    // hallucinates across it fluently and wrongly.
    expect(r.audio.map((f) => f.discontinuity)).toEqual([false, true]);
  });

  it('PIN: a replayed sequence is refused, never spliced into a live sentence', async () => {
    const r = rig();
    r.connection.handleMessage(OPEN);
    r.connection.handleMessage(pcm(0, 1000));
    r.connection.handleMessage(pcm(1, 1020));
    r.connection.handleMessage(pcm(1, 1020));
    r.connection.handleMessage(pcm(0, 1000));
    await r.connection.drain();
    expect(r.audio.map((f) => f.sequence)).toEqual([0, 1]);
    expect(r.codes()).toEqual(['sequence-replay', 'sequence-replay']);
  });

  it('PIN: the gateway platform clock arrives unmodified', async () => {
    const r = rig();
    r.connection.handleMessage(OPEN);
    r.connection.handleMessage(pcm(0, 1_756_000_000_123));
    await r.connection.drain();
    // media-ingest must never substitute its own arrival time for media time.
    // Conflating the two is exactly what P6.8 spent three passes separating.
    expect(r.audio[0]!.platformTimestampMs).toBe(1_756_000_000_123);
  });

  it('PIN: audio reaches the consumer in wire order despite async handlers', async () => {
    const seen: number[] = [];
    // A holder rather than a bare `let`: control-flow analysis narrows a
    // local to null when the only assignment happens inside a callback.
    const gate: { release: (() => void) | null } = { release: null };
    const connection = new RealtimeIngressConnection({
      openStream: async () => ({
        onAudio: async (frame) => {
          if (frame.sequence === 0) {
            // The first frame is slow. Without an ordered pump the second
            // would overtake it and a sentence would be transcribed backwards.
            await new Promise<void>((resolve) => { gate.release = resolve; });
          }
          seen.push(frame.sequence);
        },
        finish: () => {}, abort: () => {}, disconnected: () => {},
      }),
      send: () => {}, close: () => {},
    });
    connection.handleMessage(OPEN);
    connection.handleMessage(pcm(0, 0));
    connection.handleMessage(pcm(1, 20));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([]);
    gate.release?.();
    await connection.drain();
    expect(seen).toEqual([0, 1]);
  });
});

describe('the three endings stay distinguishable', () => {
  it('PIN: finish, abort and a dropped transport are three different things', async () => {
    for (const [act, expected] of [
      [(c: RealtimeIngressConnection) => c.handleMessage(encodeFinish({ streamId: 'st_1', reason: 'hangup' })), 'finish:hangup'],
      [(c: RealtimeIngressConnection) => c.handleMessage(encodeAbort({ streamId: 'st_1', reason: 'superseded' })), 'abort:superseded'],
      [(c: RealtimeIngressConnection) => c.handleDisconnect('socket closed'), 'disconnected:socket closed'],
    ] as const) {
      const r = rig();
      r.connection.handleMessage(OPEN);
      r.connection.handleMessage(pcm(0, 0));
      act(r.connection);
      await r.connection.drain();
      // Collapsing these would either transcribe audio somebody cancelled or
      // discard a sentence that was only interrupted by a reconnect.
      expect(r.endings).toEqual([expected]);
    }
  });

  it('PIN: a socket dropping before OPEN is processed still ends the stream', async () => {
    const r = rig();
    r.connection.handleMessage(OPEN);
    // The drop arrives while OPEN is still queued. Handled immediately it
    // would find no stream, deliver no ending, and leave a handler that
    // openStream had already built waiting for something that never comes.
    r.connection.handleDisconnect('socket closed');
    await r.connection.drain();
    expect(r.endings).toEqual(['disconnected:socket closed']);
  });

  it('PIN: a stream ends exactly once', async () => {
    const r = rig();
    r.connection.handleMessage(OPEN);
    r.connection.handleMessage(encodeFinish({ streamId: 'st_1', reason: 'hangup' }));
    r.connection.handleMessage(encodeAbort({ streamId: 'st_1', reason: 'late' }));
    r.connection.handleDisconnect('socket closed');
    await r.connection.drain();
    expect(r.endings).toEqual(['finish:hangup']);
  });

  it('PIN: audio after the stream ended is refused', async () => {
    const r = rig();
    r.connection.handleMessage(OPEN);
    r.connection.handleMessage(encodeFinish({ streamId: 'st_1', reason: 'hangup' }));
    r.connection.handleMessage(pcm(0, 0));
    await r.connection.drain();
    expect(r.audio).toHaveLength(0);
    expect(r.codes()).toEqual(['stream-not-open']);
  });

  it('finishing a stream id that is not open is refused', async () => {
    const r = rig();
    r.connection.handleMessage(OPEN);
    r.connection.handleMessage(encodeFinish({ streamId: 'st_other', reason: 'x' }));
    await r.connection.drain();
    expect(r.endings).toEqual([]);
    expect(r.codes()).toEqual(['stream-not-open']);
  });
});

describe('a peer that cannot speak the protocol is eventually hung up on', () => {
  it('PIN: repeated refusals close the connection rather than looping forever', async () => {
    const r = rig();
    r.connection.handleMessage(OPEN);
    for (let i = 0; i < IngressLimits.MALFORMED_MESSAGES_BEFORE_CLOSE + 4; i += 1) {
      r.connection.handleMessage(Buffer.from([0x7e, 0x00]));
    }
    await r.connection.drain();
    // Otherwise a confused or hostile peer retries forever on our budget.
    expect(r.closes).toHaveLength(1);
    expect(r.codes()).toHaveLength(IngressLimits.MALFORMED_MESSAGES_BEFORE_CLOSE);
  });

  it('PIN: server frames arriving inbound are refused, not acted on', async () => {
    const r = rig();
    r.connection.handleMessage(encodeReady('st_1'));
    r.connection.handleMessage(encodeError('internal-failure', 'x'));
    await r.connection.drain();
    expect(r.codes()).toEqual(['malformed-frame', 'malformed-frame']);
  });

  it('PIN: a handler that throws does not take the connection down', async () => {
    const connection = new RealtimeIngressConnection({
      openStream: async () => ({
        onAudio: () => { throw new Error('consumer exploded'); },
        finish: () => {}, abort: () => {}, disconnected: () => {},
      }),
      send: () => {}, close: () => {},
    });
    connection.handleMessage(OPEN);
    connection.handleMessage(pcm(0, 0));
    // One failed frame must not end a call that is still running.
    await expect(connection.drain()).resolves.toBeUndefined();
  });
});
