/** @author masterzee001 */
/**
 * A fake socket and a fake control plane, so every test here is deterministic.
 *
 * Nothing in this package's suite binds a port. A concurrency pin that depends
 * on real network timing is a pin that fails on a loaded machine and passes on
 * a quiet one, which teaches the reader to re-run rather than to investigate.
 */
import {
  MessageType,
  decodeFrame,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonPayload,
  helloSchema,
  streamOpenSchema,
  type WireFrame,
} from '@videofy-live/adapter-wire';
import type {
  AdapterSocket,
  AdapterSocketFactory,
  AdapterSocketHandlers,
  ConnectionTimers,
} from '../connection.js';
import type {
  CloseSessionInput,
  ControlPlaneClient,
  CreateSessionInput,
  ParticipantInput,
} from '../control-client.js';
import type { CreateSessionResponse } from '@videofy-live/adapter-wire';

export class FakeSocketFactory implements AdapterSocketFactory {
  handlers: AdapterSocketHandlers | null = null;
  readonly sent: WireFrame[] = [];
  connectCount = 0;
  /** Set to make every send throw, standing in for a socket that has died. */
  failSend = false;
  private nextStreamId = 1;
  /** Set false to withhold STREAM_OPEN_ACK, so a test can hold a stream unopened. */
  autoAckStreams = true;

  connect(handlers: AdapterSocketHandlers): AdapterSocket {
    this.connectCount += 1;
    this.handlers = handlers;
    const socket: AdapterSocket = {
      send: (data) => {
        if (this.failSend) throw new Error('socket is dead');
        const frame = decodeFrame(data);
        this.sent.push(frame);
        this.autoRespond(frame);
      },
      close: () => {},
    };
    // Deferred, as a real WebSocket defers 'open'.
    queueMicrotask(() => handlers.onOpen(socket));
    return socket;
  }

  private autoRespond(frame: WireFrame): void {
    if (frame.messageType === MessageType.HELLO) {
      decodeJsonPayload(frame.payload, helloSchema);
      this.deliver(MessageType.HELLO_ACK, { protocolVersion: 1, connectionId: 'conn_1' });
      return;
    }
    if (frame.messageType === MessageType.STREAM_OPEN && this.autoAckStreams) {
      decodeJsonPayload(frame.payload, streamOpenSchema);
      this.deliver(MessageType.STREAM_OPEN_ACK, { streamId: this.nextStreamId++ });
    }
  }

  /** Push a server-originated message into the client. */
  deliver(messageType: number, body: unknown, streamId = 0): void {
    this.handlers?.onMessage(
      encodeFrame({
        messageType: messageType as never,
        streamId,
        wireSequence: 0,
        platformTimestampMs: 0,
        payload: encodeJsonPayload(body),
      }),
    );
  }

  drop(reason = 'connection reset'): void {
    this.handlers?.onClose(reason);
  }

  media(): WireFrame[] {
    return this.sent.filter((frame) => frame.messageType === MessageType.MEDIA);
  }

  controlOf(messageType: number): WireFrame[] {
    return this.sent.filter((frame) => frame.messageType === messageType);
  }
}

/** Timers a test drives by hand, so nothing waits on the wall clock. */
export class ManualTimers implements ConnectionTimers {
  private readonly pending = new Map<number, { handler: () => void; dueAtMs: number }>();
  private nextHandle = 1;
  nowMs = 1000;

  setTimer(handler: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.pending.set(handle, { handler, dueAtMs: this.nowMs + delayMs });
    return handle;
  }

  clearTimer(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Advance the clock and run whatever is due. */
  advance(ms: number): void {
    this.nowMs += ms;
    for (const [handle, timer] of [...this.pending]) {
      if (timer.dueAtMs <= this.nowMs) {
        this.pending.delete(handle);
        timer.handler();
      }
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

export class FakeControlPlane implements ControlPlaneClient {
  readonly created: CreateSessionInput[] = [];
  readonly announced: ParticipantInput[] = [];
  readonly withdrawn: Array<Omit<ParticipantInput, 'displayName'>> = [];
  readonly closed: CloseSessionInput[] = [];
  /** Keyed by idempotency key, so a retry gets the same capability back. */
  private readonly bindings = new Map<string, string>();
  private nextCapability = 1;
  failCreate: Error | null = null;
  failAnnounce: Error | null = null;
  /** Resolves announce only when released, so a test can hold it in flight. */
  holdAnnounce: (() => void) | null = null;

  async createSession(input: CreateSessionInput): Promise<CreateSessionResponse> {
    this.created.push(input);
    if (this.failCreate) throw this.failCreate;
    const existing = this.bindings.get(input.idempotencyKey);
    if (existing !== undefined) {
      return {
        protocolVersion: 1,
        adapterSessionRef: input.adapterSessionRef,
        sessionCapability: existing,
        idempotentReplay: true,
      };
    }
    const capability = `cap_${this.nextCapability++}`;
    this.bindings.set(input.idempotencyKey, capability);
    return {
      protocolVersion: 1,
      adapterSessionRef: input.adapterSessionRef,
      sessionCapability: capability,
      idempotentReplay: false,
    };
  }

  async announceParticipant(input: ParticipantInput): Promise<void> {
    if (this.failAnnounce) throw this.failAnnounce;
    if (this.holdAnnounce !== null) {
      await new Promise<void>((resolve) => {
        const release = this.holdAnnounce!;
        this.holdAnnounce = () => {
          release();
          resolve();
        };
      });
    }
    this.announced.push(input);
  }

  async withdrawParticipant(input: Omit<ParticipantInput, 'displayName'>): Promise<void> {
    this.withdrawn.push(input);
  }

  async closeSession(input: CloseSessionInput): Promise<void> {
    this.closed.push(input);
  }
}

export const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};
