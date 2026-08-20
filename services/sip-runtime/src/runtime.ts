/** @author masterzee001 */
/**
 * The service host around the SIP transport library.
 *
 * `@videofy-live/sip-adapter` is deliberately a LIBRARY: `SipCall`, the parser,
 * the RTP layer, the jitter buffer and the codecs are reusable transport
 * components that know nothing about deployment. Everything a deployment needs
 * and a transport component must not learn lives here instead:
 *
 *     UDP sockets            route configuration      the remote adapter port
 *     gateway URLs           service credentials      pump scheduling
 *     port allocation        startup and shutdown
 *
 * That is composition, not SIP semantics. The test of whether something belongs
 * in this file rather than the library is simple: would it still be true if the
 * same SIP stack were embedded in a completely different product? If yes, it
 * belongs in the library.
 *
 * ONE WebSocket carries every call this process handles. The routes are
 * separate `RemoteMediaAdapterPort` facades over it, because `routeRef` is
 * remote composition rather than part of the semantic seam — `SipCall` never
 * learns that a route exists, for the same reason it never learns that a
 * language does.
 */
import { createSocket, type Socket } from 'node:dgram';
import {
  SipCall,
  parseSipMessage,
  serializeSipMessage,
  type SipMessage,
} from '@videofy-live/sip-adapter';
import { adapterSessionRef } from '@videofy-live/media-adapter-port';
import {
  AdapterConnection,
  RemoteMediaAdapterPort,
  type ControlPlaneClient,
} from '@videofy-live/media-adapter-remote';
import type { SipRuntimeConfig } from './config.js';
import { createWebSocketFactory } from './gateway-clients.js';

export interface SipRuntimeDeps {
  readonly config: SipRuntimeConfig;
  readonly control: ControlPlaneClient;
  readonly log: (line: string, detail?: Record<string, unknown>) => void;
}

interface ActiveCall {
  readonly call: SipCall;
  readonly rtp: Socket;
  readonly rtpPort: number;
  readonly remote: { address: string; port: number };
}

/** The user part of a SIP URI: `sip:441234@host` -> `441234`. */
function dialledNumberOf(requestUri: string): string | null {
  const match = /^sips?:([^@;>]+)/i.exec(requestUri.trim());
  return match?.[1]?.trim() ?? null;
}

export class SipRuntime {
  private readonly sip: Socket;
  private readonly calls = new Map<string, ActiveCall>();
  private readonly ports: RemoteMediaAdapterPort[] = [];
  private readonly portsByRoute = new Map<string, RemoteMediaAdapterPort>();
  private readonly freeRtpPorts: number[] = [];
  private readonly connection: AdapterConnection;
  private pumpHandle: NodeJS.Timeout | null = null;
  private accepting = false;

  constructor(private readonly deps: SipRuntimeDeps) {
    const { config } = deps;
    this.sip = createSocket('udp4');
    for (let port = config.rtpPortMin; port <= config.rtpPortMax; port += 2) {
      // Even ports only: RFC 3550 reserves the odd neighbour for RTCP, and a
      // port range consumed two-at-a-time is the convention every SIP element
      // on the other side already assumes.
      this.freeRtpPorts.push(port);
    }

    this.connection = new AdapterConnection({
      sockets: createWebSocketFactory({
        url: config.gatewayMediaUrl,
        serviceToken: config.serviceToken,
      }),
      adapterInstanceId: config.adapterInstanceId,
      queueLimits: { maxBytes: 8 * 1024 * 1024, maxFrames: 512, maxAgeMs: 4_000 },
      log: deps.log,
    });

    for (const routeRef of new Set(Object.values(config.routesByDialledNumber))) {
      const port = RemoteMediaAdapterPort.forRoute({
        routeRef,
        connection: this.connection,
        control: deps.control,
      });
      this.portsByRoute.set(routeRef, port);
      this.ports.push(port);
    }
  }

  get activeCallCount(): number {
    return this.calls.size;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.sip.once('error', reject);
      this.sip.bind(this.deps.config.sipPort, this.deps.config.sipHost, () => {
        this.sip.off('error', reject);
        resolve();
      });
    });
    this.sip.on('message', (datagram, from) => {
      void this.onSipDatagram(datagram, from);
    });
    this.sip.on('error', (error) => this.deps.log('sip socket error', { message: error.message }));

    // One timer for every call. A timer per call would be hundreds of timers
    // on a busy host, all firing at the same 20 ms cadence anyway.
    this.pumpHandle = setInterval(() => {
      void this.pumpAll();
    }, this.deps.config.pumpIntervalMs);
    this.accepting = true;
  }

  /** Step 1 of shutdown, on its own: nothing new enters the drain. */
  stopAccepting(): void {
    this.accepting = false;
  }

  private async pumpAll(): Promise<void> {
    for (const active of [...this.calls.values()]) {
      try {
        await active.call.pump();
      } catch (error) {
        this.deps.log('pump failed', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  }

  private send(message: SipMessage, to: { address: string; port: number }): void {
    const raw = Buffer.from(serializeSipMessage(message));
    this.sip.send(raw, to.port, to.address, (error) => {
      if (error) this.deps.log('sip send failed', { message: error.message });
    });
  }

  private refuse(request: SipMessage, status: number, reason: string, to: { address: string; port: number }): void {
    this.send(
      {
        kind: 'response',
        statusCode: status,
        reason,
        headers: {
          // Echoed back verbatim: a response that does not carry the request's
          // own Via, From, To, Call-ID and CSeq is one no SIP element will
          // match to the transaction it answers.
          via: request.headers['via'] ?? '',
          from: request.headers['from'] ?? '',
          to: request.headers['to'] ?? '',
          'call-id': request.headers['call-id'] ?? '',
          cseq: request.headers['cseq'] ?? '',
        },
        body: '',
      },
      to,
    );
  }

  private async onSipDatagram(
    datagram: Buffer,
    from: { address: string; port: number },
  ): Promise<void> {
    let message: SipMessage;
    try {
      message = parseSipMessage(datagram.toString('utf8'));
    } catch {
      // Unparseable input on a public port is background noise, not an event.
      // Logging every scan would drown the log the moment this is exposed.
      return;
    }
    if (message.kind !== 'request') return;
    const callId = message.headers['call-id'];
    if (typeof callId !== 'string' || callId === '') return;

    switch (message.method) {
      case 'INVITE':
        await this.onInvite(message, callId, from);
        return;
      case 'ACK':
        this.calls.get(callId)?.call.onAck();
        return;
      case 'BYE':
        this.refuse(message, 200, 'OK', from);
        await this.endCall(callId, 'caller hung up');
        return;
      case 'CANCEL':
        this.refuse(message, 200, 'OK', from);
        await this.endCall(callId, 'caller cancelled');
        return;
      case 'OPTIONS':
        // Answering keepalives is how an upstream SIP element decides this
        // process is alive. Refusing them gets the route marked down.
        this.refuse(message, 200, 'OK', from);
        return;
      default:
        this.refuse(message, 405, 'Method Not Allowed', from);
    }
  }

  private async onInvite(
    message: SipMessage,
    callId: string,
    from: { address: string; port: number },
  ): Promise<void> {
    const existing = this.calls.get(callId);
    if (existing !== undefined) {
      // A retransmitted INVITE for a call already in progress. `SipCall` owns
      // the dialog rules; this only has to not create a second call.
      await existing.call.onInvite(message);
      return;
    }
    if (!this.accepting) {
      // Draining. 503 with no Retry-After tells an upstream element to try
      // another node NOW, which is exactly what a rolling restart needs.
      this.refuse(message, 503, 'Service Unavailable', from);
      return;
    }

    const dialled = dialledNumberOf(message.requestUri ?? '');
    const routeRef = dialled === null ? undefined : this.deps.config.routesByDialledNumber[dialled];
    if (routeRef === undefined) {
      // A number nobody configured. 404 is what a telephone network expects,
      // and it is diagnosable; silently accepting and failing later is not.
      this.deps.log('inbound call to an unconfigured number', { dialled });
      this.refuse(message, 404, 'Not Found', from);
      return;
    }
    const port = this.portsByRoute.get(routeRef);
    if (port === undefined) {
      this.refuse(message, 404, 'Not Found', from);
      return;
    }

    const rtpPort = this.freeRtpPorts.shift();
    if (rtpPort === undefined) {
      // Capacity, stated honestly. 486 would say the person is busy; 503 says
      // this node is, which is the true and actionable answer.
      this.deps.log('no free RTP port', { configured: this.deps.config.rtpPortMax });
      this.refuse(message, 503, 'Service Unavailable', from);
      return;
    }

    let rtp: Socket;
    try {
      rtp = await this.bindRtp(rtpPort);
    } catch (error) {
      this.freeRtpPorts.push(rtpPort);
      this.deps.log('could not bind an RTP socket', {
        rtpPort,
        message: error instanceof Error ? error.message : 'unknown',
      });
      this.refuse(message, 503, 'Service Unavailable', from);
      return;
    }

    const call = new SipCall({
      port,
      // The ADVERTISED address, not the bind address. On a VPS behind NAT
      // these differ, and using the bind address produces a call that connects
      // and then carries no audio.
      localAddress: this.deps.config.advertisedAddress,
      localRtpPort: rtpPort,
      sendRtp: (payload, target) => {
        rtp.send(payload, target.port, target.address, (error) => {
          if (error) this.deps.log('rtp send failed', { message: error.message });
        });
      },
      sendSip: (response) => this.send(response, from),
      seamHandshakeDeadlineMs: this.deps.config.seamHandshakeDeadlineMs,
      gracePeriodMs: this.deps.config.gracePeriodMs,
      releaseTransport: () => this.releaseRtp(rtpPort, rtp),
    });

    rtp.on('message', (datagram) => call.onRtpDatagram(datagram));
    rtp.on('error', (error) => this.deps.log('rtp socket error', { message: error.message }));

    this.calls.set(callId, { call, rtp, rtpPort, remote: from });
    try {
      await call.onInvite(message);
    } catch (error) {
      this.deps.log('invite failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      await this.endCall(callId, 'invite failed');
    }
  }

  private bindRtp(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4');
      socket.once('error', reject);
      socket.bind(port, this.deps.config.sipHost, () => {
        socket.off('error', reject);
        resolve(socket);
      });
    });
  }

  private releaseRtp(port: number, socket: Socket): void {
    try {
      socket.close();
    } catch {
      /* closing a socket that is already gone is not a failure */
    }
    // Returned to the pool only after the socket is closed, so the next call
    // cannot try to bind a port this one still holds.
    if (!this.freeRtpPorts.includes(port)) this.freeRtpPorts.push(port);
  }

  private async endCall(callId: string, reason: string): Promise<void> {
    const active = this.calls.get(callId);
    if (active === undefined) return;
    // Removed from the map FIRST, so a second BYE and a concurrent drain both
    // find nothing rather than racing this teardown.
    this.calls.delete(callId);
    try {
      await active.call.close(reason);
    } catch (error) {
      this.deps.log('call teardown failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
    // `releaseTransport` normally does this; belt and braces for a call that
    // failed before its lifecycle owned the socket.
    this.releaseRtp(active.rtpPort, active.rtp);
  }

  /** Shutdown step 2: end active calls, bounded by the lifecycle's deadline. */
  async endAllCalls(reason: string): Promise<void> {
    await Promise.all([...this.calls.keys()].map((callId) => this.endCall(callId, reason)));
  }

  /** Shutdown step 3 and 4: transports, RTP before signalling. */
  closeTransports(): void {
    for (const active of this.calls.values()) this.releaseRtp(active.rtpPort, active.rtp);
    try {
      this.sip.close();
    } catch {
      /* already closed */
    }
  }

  /** Shutdown step 5: the gateway learns we are going. */
  closeRemote(): void {
    this.connection.close();
  }

  /** Shutdown step 6. */
  releaseTimers(): void {
    if (this.pumpHandle !== null) clearInterval(this.pumpHandle);
    this.pumpHandle = null;
  }

  /** Exposed for the acceptance harness; nothing in production reads it. */
  get sessionRefFor(): (callId: string) => string {
    return (callId) => adapterSessionRef(`sc_${callId}`);
  }
}
