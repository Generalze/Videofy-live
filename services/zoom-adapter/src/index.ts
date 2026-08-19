/** @author masterzee001 */
/**
 * Process entry: listen for Zoom webhooks, and run one RTMS session per live
 * stream. Credentials are read from the environment and never logged.
 *
 * The media-adapter port is injected at construction. Until the gateway's
 * trusted server-side ingress exists and can be validated against real Zoom
 * credentials, this entry point requires the caller to supply the binding —
 * there is deliberately no default that pretends to reach Connect.
 */
import { WebSocket } from 'ws';
import { readConfig } from './config.js';
import type { MediaAdapterPort } from './media-port.js';
import { ZoomRtmsSession, type SocketLike } from './session.js';
import { buildZoomWebhookApp } from './webhook.js';

/** Adapts a ws socket to the narrow shape the session needs. */
function connectWebSocket(url: string): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on('error', reject);
    socket.on('open', () =>
      resolve({
        send: (payload) => socket.send(payload),
        close: () => socket.close(),
        onMessage: (listener) => socket.on('message', (data) => listener(data.toString())),
        onClose: (listener) => socket.on('close', () => listener()),
      }),
    );
  });
}

export function startZoomAdapter(port: MediaAdapterPort, env: NodeJS.ProcessEnv = process.env): {
  close: () => void;
} {
  const config = readConfig(env);
  const sessions = new Map<string, ZoomRtmsSession>();
  const log = (line: string, detail?: Record<string, unknown>) =>
    console.log(`[zoom-adapter] ${line}`, detail ?? '');

  const app = buildZoomWebhookApp({
    secretToken: config.webhookSecretToken,
    log,
    handlers: {
      onStreamStarted: async (start) => {
        // A live session for this stream means a duplicate delivery. A DEAD
        // one must not block its own restart: Zoom re-announces after an
        // interruption with a FRESH signaling url, which is exactly the one
        // piece of information recovery needs.
        const existing = sessions.get(start.rtmsStreamId);
        if (existing !== undefined) {
          if (existing.phase !== 'closed') return;
          sessions.delete(start.rtmsStreamId);
        }
        const session = new ZoomRtmsSession({
          identity: {
            clientId: config.clientId,
            meetingUuid: start.meetingUuid,
            rtmsStreamId: start.rtmsStreamId,
          },
          clientSecret: config.clientSecret,
          signalingUrl: start.signalingServerUrl,
          port,
          connect: connectWebSocket,
          log,
        });
        sessions.set(start.rtmsStreamId, session);
        try {
          await session.start();
        } catch (error) {
          // A session that never started must not linger in the map, or the
          // watchdog re-dials it forever and its stream can never restart.
          sessions.delete(start.rtmsStreamId);
          log('zoom rtms session failed to start', {
            message: error instanceof Error ? error.message : 'unknown',
          });
        }
      },
      onStreamStopped: async ({ rtmsStreamId, reason }) => {
        await sessions.get(rtmsStreamId)?.close(reason || 'stream stopped');
        sessions.delete(rtmsStreamId);
      },
      onStreamInterrupted: async ({ rtmsStreamId }) => {
        // Recoverable by contract — but act NOW. Routing this through the
        // watchdog would do nothing at all, since keepalives were healthy
        // seconds ago and its silence test would not trip for another minute.
        await sessions.get(rtmsStreamId)?.handleInterruption();
      },
      onConcurrencyWarning: (event) => log('zoom account concurrency warning', { event }),
    },
  });

  // Zoom drives keepalives; we only watch for their absence.
  const watchdog = setInterval(() => {
    for (const [streamId, session] of sessions) {
      if (session.phase === 'closed') {
        // Reap: a closed session left in the map blocks its own restart.
        sessions.delete(streamId);
        continue;
      }
      void session.checkKeepalive().catch((error) => {
        log('zoom rtms watchdog error', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      });
    }
  }, 5_000);

  const server = app.listen(config.port, () => log(`listening on ${config.port}`));
  return {
    close: () => {
      clearInterval(watchdog);
      server.close();
    },
  };
}
