/** @author masterzee001 */
/**
 * Binding the ingress state machine to a real socket.
 *
 * Everything that can be decided without a network already was: the codec and
 * `RealtimeIngressConnection` carry the whole contract. What is left here is
 * genuinely transport work -- the upgrade, the credential, the close codes --
 * and it is kept small on purpose, because this is the part that cannot be
 * proved by a unit test.
 *
 * THE CREDENTIAL IS CHECKED ON THE UPGRADE, BEFORE ANY FRAME IS READ. P6.9
 * settled this for the adapter channel and the reasoning is unchanged: a socket
 * that authenticates by sending a first message has already been allocated, is
 * already consuming a connection slot, and is already talking to a parser. The
 * cheapest possible refusal is an HTTP response to a request that never becomes
 * a WebSocket.
 *
 * `INTERNAL_WEBRTC_TOKEN` is reused rather than joined by a third secret. This
 * seam is the same trust relationship the internal media API already has --
 * gateway to media-ingest, first-party to first-party -- and inventing a
 * separate credential for the same relationship means two secrets to rotate,
 * two ways to misconfigure, and no additional security.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  internalIngressRequestAllowed,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import { IngressLimits } from '@videofy-live/media-ingress-wire';
import {
  RealtimeIngressConnection,
  type RealtimeIngressConnectionDeps,
} from './realtime-ingress-connection.js';

export const REALTIME_INGRESS_PATH = '/internal/media/ingress/v1';

export interface RealtimeIngressServerDeps {
  readonly auth: InternalIngressAuthResolution;
  readonly openStream: RealtimeIngressConnectionDeps['openStream'];
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
  readonly path?: string;
}

export interface RealtimeIngressServerHandle {
  readonly connections: number;
  close(): Promise<void>;
}

function presentedToken(request: IncomingMessage): string | undefined {
  const header = request.headers['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice('bearer '.length);
  }
  const direct = request.headers['x-internal-token'];
  return typeof direct === 'string' ? direct : undefined;
}

export function attachRealtimeAudioIngress(
  server: HttpServer,
  deps: RealtimeIngressServerDeps,
): RealtimeIngressServerHandle {
  const path = deps.path ?? REALTIME_INGRESS_PATH;
  // `noServer` so the upgrade is ours to refuse. Letting `ws` own the upgrade
  // would mean the socket exists before the credential is looked at.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const sockets = new Set<WebSocket>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let requestPath: string;
    try {
      requestPath = new URL(request.url ?? '/', 'http://placeholder').pathname;
    } catch {
      return;
    }
    // Another upgrade handler on the same server owns other paths; leaving it
    // alone rather than destroying the socket is what makes them composable.
    if (requestPath !== path) return;

    if (!internalIngressRequestAllowed(deps.auth, presentedToken(request))) {
      deps.log?.('ingress upgrade refused', { path: requestPath });
      // A plain HTTP refusal. The connection never becomes a WebSocket, never
      // reaches the parser, and never occupies a slot.
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      const connection = new RealtimeIngressConnection({
        openStream: deps.openStream,
        send: (frame) => {
          if (ws.readyState === ws.OPEN) ws.send(frame);
        },
        close: (reason) => ws.close(1008, reason.slice(0, 120)),
        ...(deps.log === undefined ? {} : { log: deps.log }),
      });

      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          // Every frame in this protocol is binary. A text frame is a peer
          // speaking something else, and guessing at it is how a parser ends
          // up interpreting a stray heartbeat as audio.
          connection.handleMessage(Buffer.alloc(0));
          return;
        }
        connection.handleMessage(
          Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBufferLike),
        );
      });
      ws.on('close', (code, reasonBuffer) => {
        sockets.delete(ws);
        connection.handleDisconnect(`close ${code}: ${reasonBuffer.toString('utf8').slice(0, 80)}`);
      });
      ws.on('error', (error: Error) => {
        deps.log?.('ingress socket error', { message: error.message });
        // The 'close' that follows delivers the ending; doing it here too would
        // end the stream twice.
      });
    });
  };

  server.on('upgrade', onUpgrade);

  return {
    get connections(): number {
      return sockets.size;
    },
    async close(): Promise<void> {
      server.off('upgrade', onUpgrade);
      for (const ws of sockets) ws.close(1001, 'shutting down');
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

export { IngressLimits };
