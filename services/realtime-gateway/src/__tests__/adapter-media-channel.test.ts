/** @author masterzee001 */
/**
 * The media channel over a real WebSocket on a real port.
 *
 * The claim this file exists to check is an ORDERING claim: a caller without a
 * valid service identity never becomes an adapter connection, so none of the
 * protocol state machine behind it is reachable by a stranger. Testing that the
 * handshake works is easy; testing that it cannot be skipped is the point.
 *
 * And then the second, equally important half: authenticating as a service is
 * NOT permission to speak for anybody. A connected adapter that has not
 * presented a session capability can still do nothing at all.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { AdapterAuthority } from '@videofy-live/adapter-authority';
import {
  MessageType,
  decodeFrame,
  encodeFrame,
  encodeJsonPayload,
  pcmToBytes,
} from '@videofy-live/adapter-wire';
import {
  ADAPTER_SERVICE_TOKEN_VARIABLE,
  resolveAdapterServiceAuth,
} from '@videofy-live/service-env';
import {
  ADAPTER_MEDIA_CHANNEL_PATH,
  ADAPTER_SERVICE_TOKEN_HEADER,
  attachAdapterMediaChannel,
  type AdapterMediaChannel,
} from '../adapter-media-channel.js';
import {
  AdapterIngressBinding,
  type AdapterTranscriptionBridgeLike,
} from '../adapter-ingress-binding.js';
import type { MediaAudioDataLike } from '../media-transcription-chunker.js';
import type { MediaTranscriptionBridgeContext } from '../media-transcription-bridge.js';

const SERVICE_TOKEN = 'adapter-service-token-0123456789';

class RecordingBridge implements AdapterTranscriptionBridgeLike {
  readonly frames: Array<{ sessionId: string; data: MediaAudioDataLike }> = [];
  handleFrame(context: MediaTranscriptionBridgeContext, data: MediaAudioDataLike): void {
    this.frames.push({ sessionId: context.sessionId, data });
  }
  endSession(): void {}
}

const open: Array<{ server: Server; channel: AdapterMediaChannel; sockets: WebSocket[] }> = [];
afterEach(async () => {
  while (open.length > 0) {
    const entry = open.pop()!;
    for (const socket of entry.sockets) socket.terminate();
    await entry.channel.close();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  }
});

async function rig(env: Record<string, string> = { [ADAPTER_SERVICE_TOKEN_VARIABLE]: SERVICE_TOKEN }) {
  let minted = 0;
  const authority = new AdapterAuthority({ mintSessionId: () => `cs_platform_${(minted += 1)}` });
  const bridge = new RecordingBridge();
  const binding = new AdapterIngressBinding({
    authority,
    bridge,
    policy: { resolve: async () => ({ targetLanguages: ['es'] }) },
  });

  const server = createServer((_request, response) => response.end('ok'));
  const channel = attachAdapterMediaChannel({
    server,
    binding,
    serviceAuth: resolveAdapterServiceAuth({ env }),
  });
  const sockets: WebSocket[] = [];
  open.push({ server, channel, sockets });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const url = `ws://127.0.0.1:${address.port}${ADAPTER_MEDIA_CHANNEL_PATH}`;

  const route = authority.issueRouteCredential({ adapterId: 'sip-1', routes: ['route_17'] });
  const grant = authority.createSession({
    credential: route.credential,
    adapterSessionRef: 'sc_1',
    routeRef: 'route_17',
    idempotencyKey: 'sip-1:route_17:sc_1',
  });
  if (typeof grant === 'string') throw new Error(grant);

  return { authority, bridge, binding, channel, url, route, grant, sockets };
}

/** Connect, and report which of the two outcomes actually happened. */
function connect(
  url: string,
  headers: Record<string, string>,
  sockets: WebSocket[],
): Promise<{ socket: WebSocket | null; refusal: number | null; received: Buffer[] }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    sockets.push(socket);
    const received: Buffer[] = [];
    socket.on('message', (data: Buffer) => received.push(Buffer.from(data)));
    socket.on('open', () => resolve({ socket, refusal: null, received }));
    // `ws` surfaces a refused upgrade as an error carrying the status code.
    socket.on('unexpected-response', (_request, response) =>
      resolve({ socket: null, refusal: response.statusCode ?? 0, received }),
    );
    socket.on('error', () => resolve({ socket: null, refusal: -1, received }));
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function control(messageType: number, body: unknown): Buffer {
  return encodeFrame({
    messageType: messageType as 0x01,
    streamId: 0,
    wireSequence: 0,
    platformTimestampMs: 0,
    payload: encodeJsonPayload(body),
  });
}

function typesIn(received: Buffer[]): number[] {
  return received.map((frame) => decodeFrame(frame).messageType);
}

describe('authentication happens on the upgrade, before HELLO', () => {
  it('PIN: no service credential means no WebSocket at all', async () => {
    const r = await rig();
    const result = await connect(r.url, {}, r.sockets);
    // Not "connected then refused" -- never connected. Nothing behind the
    // handshake is reachable, because there is no handshake to reach it with.
    expect(result.socket).toBeNull();
    expect(result.refusal).toBe(401);
    expect(r.channel.connectionCount).toBe(0);
  });

  it('PIN: a wrong service credential is refused the same way', async () => {
    const r = await rig();
    const result = await connect(
      r.url,
      { [ADAPTER_SERVICE_TOKEN_HEADER]: 'not-the-token-0123456789' },
      r.sockets,
    );
    expect(result.socket).toBeNull();
    expect(result.refusal).toBe(401);
  });

  it('PIN: an unconfigured gateway accepts no adapter connection', async () => {
    const r = await rig({});
    const result = await connect(
      r.url,
      { [ADAPTER_SERVICE_TOKEN_HEADER]: SERVICE_TOKEN },
      r.sockets,
    );
    expect(result.socket).toBeNull();
    expect(result.refusal).toBe(401);
  });

  it('a valid service credential connects and completes the handshake', async () => {
    const r = await rig();
    const result = await connect(
      r.url,
      { [ADAPTER_SERVICE_TOKEN_HEADER]: SERVICE_TOKEN },
      r.sockets,
    );
    expect(result.socket).not.toBeNull();
    expect(r.channel.connectionCount).toBe(1);

    result.socket!.send(control(MessageType.HELLO, { protocolVersion: 1, adapterInstanceId: 'sip-1' }));
    await settle();
    expect(typesIn(result.received)).toEqual([MessageType.HELLO_ACK]);
  });
});

describe('a connection is permission to ask, not permission to speak', () => {
  it('PIN: an authenticated adapter still cannot open a stream without a capability', async () => {
    const r = await rig();
    const result = await connect(
      r.url,
      { [ADAPTER_SERVICE_TOKEN_HEADER]: SERVICE_TOKEN },
      r.sockets,
    );
    const socket = result.socket!;
    socket.send(control(MessageType.HELLO, { protocolVersion: 1, adapterInstanceId: 'sip-1' }));
    await settle();

    // The service credential got it this far and gets it no further. Layer 1
    // and layer 3 are different powers.
    socket.send(
      control(MessageType.STREAM_OPEN, {
        adapterSessionRef: 'sc_1',
        participantId: 'sp_1',
        sessionCapability: 'vfc_nope.nonsense',
      }),
    );
    await settle();
    expect(typesIn(result.received)).toEqual([MessageType.HELLO_ACK, MessageType.ERROR]);
    expect(r.bridge.frames).toHaveLength(0);
  });

  it('PIN: the service credential is not usable as a session capability', async () => {
    const r = await rig();
    const result = await connect(
      r.url,
      { [ADAPTER_SERVICE_TOKEN_HEADER]: SERVICE_TOKEN },
      r.sockets,
    );
    const socket = result.socket!;
    socket.send(control(MessageType.HELLO, { protocolVersion: 1, adapterInstanceId: 'sip-1' }));
    await settle();
    socket.send(
      control(MessageType.STREAM_OPEN, {
        adapterSessionRef: 'sc_1',
        participantId: 'sp_1',
        sessionCapability: SERVICE_TOKEN,
      }),
    );
    await settle();
    expect(typesIn(result.received)).toEqual([MessageType.HELLO_ACK, MessageType.ERROR]);
  });
});

describe('the whole path over a real socket', () => {
  it('carries PCM from an authenticated adapter into the pipeline', async () => {
    const r = await rig();
    r.authority.announceParticipant(r.grant.capability, 'sp_1');
    const result = await connect(
      r.url,
      { [ADAPTER_SERVICE_TOKEN_HEADER]: SERVICE_TOKEN },
      r.sockets,
    );
    const socket = result.socket!;

    socket.send(control(MessageType.HELLO, { protocolVersion: 1, adapterInstanceId: 'sip-1' }));
    socket.send(
      control(MessageType.STREAM_OPEN, {
        adapterSessionRef: 'sc_1',
        participantId: 'sp_1',
        sessionCapability: r.grant.capability,
      }),
    );
    await settle();
    expect(typesIn(result.received)).toEqual([MessageType.HELLO_ACK, MessageType.STREAM_OPEN_ACK]);

    const ack = decodeFrame(result.received[1]!);
    const streamId = (JSON.parse(ack.payload.toString('utf8')) as { streamId: number }).streamId;

    const samples = Int16Array.from([100, -200, 300, -400]);
    socket.send(
      encodeFrame({
        messageType: MessageType.MEDIA,
        streamId,
        wireSequence: 0,
        platformTimestampMs: 20,
        payload: pcmToBytes(samples),
      }),
    );
    await settle();

    expect(r.bridge.frames).toHaveLength(1);
    expect(r.bridge.frames[0]!.sessionId).toBe('cs_platform_1');
    // Survived the real socket byte for byte, little-endian as specified.
    expect(Array.from(r.bridge.frames[0]!.data.samples as Int16Array)).toEqual([100, -200, 300, -400]);
  });

  it('PIN: frames are processed in wire order, not as they happen to resolve', async () => {
    // `receive` is async and reaches the authority. If each message were fired
    // off independently, MEDIA could overtake the STREAM_OPEN that gives it
    // meaning -- so both are sent back to back with no wait between them.
    const r = await rig();
    r.authority.announceParticipant(r.grant.capability, 'sp_1');
    const result = await connect(
      r.url,
      { [ADAPTER_SERVICE_TOKEN_HEADER]: SERVICE_TOKEN },
      r.sockets,
    );
    const socket = result.socket!;
    socket.send(control(MessageType.HELLO, { protocolVersion: 1, adapterInstanceId: 'sip-1' }));
    socket.send(
      control(MessageType.STREAM_OPEN, {
        adapterSessionRef: 'sc_1',
        participantId: 'sp_1',
        sessionCapability: r.grant.capability,
      }),
    );
    // Stream id 1 is the first this connection allocates, and it is allocated
    // by a STREAM_OPEN that has not been answered yet when this is sent.
    socket.send(
      encodeFrame({
        messageType: MessageType.MEDIA,
        streamId: 1,
        wireSequence: 0,
        platformTimestampMs: 20,
        payload: pcmToBytes(Int16Array.from([7, 7, 7, 7])),
      }),
    );
    await settle();

    expect(r.bridge.frames).toHaveLength(1);
    expect(Array.from(r.bridge.frames[0]!.data.samples as Int16Array)).toEqual([7, 7, 7, 7]);
  });

  it('PIN: a text frame is not a protocol message', async () => {
    const r = await rig();
    const result = await connect(
      r.url,
      { [ADAPTER_SERVICE_TOKEN_HEADER]: SERVICE_TOKEN },
      r.sockets,
    );
    const socket = result.socket!;
    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    socket.send(JSON.stringify({ messageType: 'HELLO' }));
    expect(await closed).toBe(1003);
  });
});
