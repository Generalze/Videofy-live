/** @author masterzee001 */
/**
 * The authenticated media channel: a real WebSocket around
 * `AdapterIngressConnection`.
 *
 * AUTHENTICATION HAPPENS ON THE UPGRADE, BEFORE `HELLO`.
 *
 *     HTTP Upgrade
 *          |
 *     service credential checked here
 *          |
 *          +-- refused --> 401, socket destroyed, no WebSocket ever exists
 *          |
 *     WebSocket accepted
 *          |
 *     HELLO ... STREAM_OPEN ... MEDIA   (session capabilities from here on)
 *
 * That ordering is the whole point. A caller without a valid service identity
 * never becomes an adapter connection at all, so none of the protocol state
 * machine is reachable by a stranger — and `HELLO` carries no secret, which is
 * why it does not need to. Long-lived credentials do not belong inside
 * application frames that get logged, buffered and replayed.
 *
 * The two powers stay separate, as they must:
 *
 *     service credential  =  may connect as an adapter
 *     session capability  =  may send media for this session
 *
 * A connection is not permission to speak for anybody. It is only permission to
 * ask.
 *
 * Raw `ws` rather than socket.io, because the wire is already a binary protocol
 * with its own framing, sequencing and versioning. Wrapping it in a second
 * framing layer would add overhead and a second definition of what a message is.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { AdapterIngressConnection } from '@videofy-live/adapter-ingress';
import {
  internalIngressRequestAllowed,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import type { AdapterIngressBinding } from './adapter-ingress-binding.js';

export const ADAPTER_MEDIA_CHANNEL_PATH = '/internal/adapter/v1/media';
export const ADAPTER_SERVICE_TOKEN_HEADER = 'x-videofy-adapter-token';

export interface AdapterMediaChannelDeps {
  readonly server: HttpServer;
  readonly binding: AdapterIngressBinding;
  readonly serviceAuth: InternalIngressAuthResolution;
  readonly path?: string;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
  /** Injectable for tests; ids only ever appear in logs. */
  readonly mintConnectionId?: () => string;
}

export interface AdapterMediaChannel {
  readonly connectionCount: number;
  close(): Promise<void>;
}

export function attachAdapterMediaChannel(deps: AdapterMediaChannelDeps): AdapterMediaChannel {
  const path = deps.path ?? ADAPTER_MEDIA_CHANNEL_PATH;
  const log = deps.log ?? (() => {});
  let counter = 0;
  const mintConnectionId = deps.mintConnectionId ?? (() => `ac_${(counter += 1)}`);

  // `noServer` so the upgrade is ours to refuse. Letting `ws` own the listener
  // would mean the WebSocket exists before anything has authenticated it.
  const sockets = new WebSocketServer({ noServer: true });
  const live = new Set<WebSocket>();

  function refuse(socket: Duplex, status: number, reason: string): void {
    // A caller that cannot authenticate is not owed a description of what it
    // failed to present.
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Other upgrade handlers (socket.io) share this server, so anything not
    // addressed to us is left strictly alone rather than refused.
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://placeholder').pathname;
    } catch {
      return;
    }
    if (pathname !== path) return;

    const presented = request.headers[ADAPTER_SERVICE_TOKEN_HEADER];
    const token = Array.isArray(presented) ? presented[0] : presented;
    if (!internalIngressRequestAllowed(deps.serviceAuth, token)) {
      log('adapter media channel refused: service credential');
      refuse(socket, 401, 'Unauthorized');
      return;
    }

    sockets.handleUpgrade(request, socket, head, (websocket) => {
      const connectionId = mintConnectionId();
      live.add(websocket);

      const connection = new AdapterIngressConnection({
        socket: {
          send: (data) => {
            if (websocket.readyState === websocket.OPEN) websocket.send(data);
          },
          close: () => websocket.close(),
        },
        sink: deps.binding,
        resolver: deps.binding,
        connectionId,
        log,
      });

      /**
       * Frames are processed STRICTLY IN ORDER.
       *
       * `receive` is async — it resolves a stream, and resolution reaches the
       * authority and the policy resolver. `ws` will happily deliver the next
       * message while that is still pending, so firing each one off
       * independently would let a MEDIA frame overtake the STREAM_OPEN that
       * gives it meaning. The protocol's sequence rules assume wire order; this
       * is what preserves it.
       */
      let pump: Promise<unknown> = Promise.resolve();
      websocket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (!isBinary) {
          // Every frame in this protocol is binary. A text frame is a client
          // speaking something else entirely.
          log('adapter media channel sent a text frame', { connectionId });
          websocket.close(1003, 'binary frames only');
          return;
        }
        const buffer = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        pump = pump.then(
          () => connection.receive(buffer),
          () => connection.receive(buffer),
        );
      });

      const finish = (reason: string): void => {
        live.delete(websocket);
        connection.close();
        log('adapter media channel closed', { connectionId, reason });
      };
      websocket.on('close', () => finish('closed'));
      websocket.on('error', (error: Error) => finish(error.message));

      log('adapter media channel open', { connectionId });
    });
  };

  deps.server.on('upgrade', onUpgrade);

  return {
    get connectionCount(): number {
      return live.size;
    },
    async close(): Promise<void> {
      deps.server.off('upgrade', onUpgrade);
      for (const websocket of [...live]) websocket.terminate();
      live.clear();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
}
