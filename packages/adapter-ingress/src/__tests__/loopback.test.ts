/** @author masterzee001 */
/**
 * Client and server, against each other, with no fake on either side.
 *
 * This is why the two halves were built separately. Each earned its tests
 * against a fake counterpart written from the contract, so a disagreement here
 * is a disagreement about the CONTRACT — not two implementations of the same
 * misunderstanding nodding at one another, which is what you get when both
 * sides are written together and tested only end to end.
 *
 * Still no real socket: the two are wired directly, so every ordering is
 * deterministic and a failure is reproducible rather than a weather report.
 */
import { describe, expect, it } from 'vitest';
import type { AdapterWireOutcome, CreateSessionResponse } from '@videofy-live/adapter-wire';
import { adapterSessionRef, type AdapterAudioFrame } from '@videofy-live/media-adapter-port';
import {
  AdapterConnection,
  RemoteMediaAdapterPort,
  type AdapterSocket,
  type AdapterSocketHandlers,
  type ControlPlaneClient,
} from '@videofy-live/media-adapter-remote';
import {
  AdapterIngressConnection,
  type AdapterMediaSink,
  type IngressMediaFrame,
  type StreamResolver,
} from '../ingress-server.js';

const REF = adapterSessionRef('sc_loop');
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 24; turn += 1) await Promise.resolve();
};
/**
 * Reconnection is driven by a real timer, and `flush` only drains microtasks.
 * The delay is 1 ms here so this stays a wait for a scheduled event rather than
 * a hopeful pause.
 */
const settleTimers = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await flush();
};

function frame(value: number, timestampMs: number, participantId = 'sp_1'): AdapterAudioFrame {
  return {
    participantId,
    samples: Int16Array.from([value, value + 1, value + 2]),
    sampleRate: 16000,
    channelCount: 1,
    platformTimestampMs: timestampMs,
  };
}

class Sink implements AdapterMediaSink {
  readonly frames: IngressMediaFrame[] = [];
  outcome: AdapterWireOutcome = 'accepted';
  async deliver(f: IngressMediaFrame): Promise<AdapterWireOutcome> {
    if (this.outcome === 'accepted') this.frames.push(f);
    return this.outcome;
  }
}

class Resolver implements StreamResolver {
  async resolve(open: { adapterSessionRef: string; participantId: string }) {
    return { adapterSessionRef: open.adapterSessionRef, participantId: open.participantId };
  }
}

class Control implements ControlPlaneClient {
  private next = 1;
  async createSession(): Promise<CreateSessionResponse> {
    return {
      protocolVersion: 1,
      adapterSessionRef: 'sc_loop',
      sessionCapability: `cap_${this.next++}`,
      idempotentReplay: false,
    };
  }
  async announceParticipant(): Promise<void> {}
  async withdrawParticipant(): Promise<void> {}
  async closeSession(): Promise<void> {}
}

interface Loop {
  port: RemoteMediaAdapterPort;
  connection: AdapterConnection;
  sink: Sink;
  servers: AdapterIngressConnection[];
  dropLink: () => void;
}

/** Wire the client's socket straight into the server's `receive`, and back. */
function loopback(): Loop {
  const sink = new Sink();
  const servers: AdapterIngressConnection[] = [];
  let handlers: AdapterSocketHandlers | null = null;
  let live = true;

  const connection = new AdapterConnection({
    adapterInstanceId: 'adapter-loop',
    reconnectDelayMs: 1,
    queueLimits: { maxBytes: 1 << 20, maxFrames: 1000, maxAgeMs: 60_000 },
    sockets: {
      connect(socketHandlers) {
        handlers = socketHandlers;
        const server = new AdapterIngressConnection({
          socket: {
            send: (data) => {
              if (live) handlers?.onMessage(data);
            },
            close: () => {},
          },
          sink,
          resolver: new Resolver(),
          now: () => 9000,
        });
        servers.push(server);
        const socket: AdapterSocket = {
          send: (data) => {
            if (!live) throw new Error('link is down');
            void server.receive(data);
          },
          close: () => {},
        };
        queueMicrotask(() => socketHandlers.onOpen(socket));
        return socket;
      },
    },
  });

  return {
    connection,
    sink,
    servers,
    port: RemoteMediaAdapterPort.forRoute({
      routeRef: 'route_loop',
      connection,
      control: new Control(),
    }),
    dropLink: () => {
      live = false;
      handlers?.onClose('link dropped');
      live = true;
    },
  };
}

async function live(loop: Loop): Promise<void> {
  await loop.port.openSession({ sessionRef: REF, platformSessionRef: 'call-1' });
  await loop.port.participantJoined(REF, 'sp_1', 'Ada');
  await flush();
}

function expectClientLedgerBalances(loop: Loop): void {
  const l = loop.connection.ledger;
  expect({ accepted: l.accepted, accountedFor: l.accountedFor }).toEqual({
    accepted: l.accepted,
    accountedFor: l.accepted,
  });
  expect(l.balanced).toBe(true);
}

describe('client and server over the real protocol', () => {
  it('PIN: audio crosses intact, and every frame is settled', async () => {
    const loop = loopback();
    await live(loop);
    for (let index = 0; index < 5; index += 1) {
      await loop.port.pushAudio(REF, frame(index * 10, index * 20));
    }
    await flush();

    expect(loop.sink.frames.map((f) => f.wireSequence)).toEqual([0, 1, 2, 3, 4]);
    expect(loop.sink.frames.map((f) => f.platformTimestampMs)).toEqual([0, 20, 40, 60, 80]);
    expect(Array.from(loop.sink.frames[2]!.samples)).toEqual([20, 21, 22]);
    // Both sides agree on where the frames ended up, which is the whole point
    // of settlement being a statement rather than an absence.
    expect(loop.connection.ledger.settledAccepted).toBe(5);
    expect(loop.connection.ledger.inFlight).toBe(0);
    expectClientLedgerBalances(loop);
  });

  it('PIN: identity and participant survive the crossing', async () => {
    const loop = loopback();
    await live(loop);
    await loop.port.pushAudio(REF, frame(1, 20));
    await flush();
    expect(loop.sink.frames[0]!.adapterSessionRef).toBe('sc_loop');
    expect(loop.sink.frames[0]!.participantId).toBe('sp_1');
  });

  it('PIN: a gateway refusal is counted as refused on the client', async () => {
    const loop = loopback();
    await live(loop);
    loop.sink.outcome = 'dropped-backpressure';
    await loop.port.pushAudio(REF, frame(1, 20));
    await flush();

    expect(loop.connection.ledger.gatewayRefused).toBe(1);
    expect(loop.connection.ledger.settledAccepted).toBe(0);
    expectClientLedgerBalances(loop);
  });

  it('PIN: two participants multiplex without interleaving', async () => {
    const loop = loopback();
    await live(loop);
    await loop.port.participantJoined(REF, 'sp_2', 'Grace');
    await flush();

    await loop.port.pushAudio(REF, frame(100, 20, 'sp_1'));
    await loop.port.pushAudio(REF, frame(200, 20, 'sp_2'));
    await loop.port.pushAudio(REF, frame(101, 40, 'sp_1'));
    await flush();

    const byParticipant = loop.sink.frames.map((f) => `${f.participantId}:${f.wireSequence}`);
    expect(byParticipant).toEqual(['sp_1:0', 'sp_2:0', 'sp_1:1']);
    expectClientLedgerBalances(loop);
  });

  it('PIN: a reconnect gets a new stream and restarts its numbering', async () => {
    const loop = loopback();
    await live(loop);
    await loop.port.pushAudio(REF, frame(1, 20));
    await flush();

    loop.dropLink();
    await settleTimers();
    await loop.port.pushAudio(REF, frame(2, 40));
    await flush();

    // A second server instance was created for the second connection, and it
    // knows nothing of the first — which is exactly what "reconnection resumes
    // transport, never authority" has to mean in practice.
    expect(loop.servers.length).toBeGreaterThan(1);
    const afterReconnect = loop.sink.frames.at(-1)!;
    expect(afterReconnect.wireSequence).toBe(0);
    expect(afterReconnect.discontinuity).toBe(true);
    expectClientLedgerBalances(loop);
  });

  it('PIN: a closed session is not resurrected across the wire', async () => {
    const loop = loopback();
    await live(loop);
    await loop.port.closeSession(REF, 'caller hung up');
    const before = loop.sink.frames.length;

    loop.dropLink();
    await settleTimers();

    await expect(loop.port.pushAudio(REF, frame(9, 60))).rejects.toThrow();
    expect(loop.sink.frames).toHaveLength(before);
    expectClientLedgerBalances(loop);
  });
});
