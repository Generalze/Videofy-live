/** @author masterzee001 */
/**
 * The session state machine, against fake sockets: the cross-socket handshake
 * ordering, per-speaker identity and demultiplexing, gap reporting, the
 * keepalive watchdog, and recovery.
 */
import { describe, expect, it } from 'vitest';
import { MSG } from '../protocol.js';
import { RecordingMediaAdapterPort } from '../media-port.js';
import { ZoomRtmsSession, KEEPALIVE_SILENCE_LIMIT_MS, type SocketLike } from '../session.js';
import {
  audioPacket,
  dataHandshakeResp,
  keepAliveReq,
  participantJoinEvent,
  participantLeaveEvent,
  signalingHandshakeResp,
} from './fixtures.js';

class FakeSocket implements SocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  private messageListener: ((raw: string) => void) | null = null;
  private closeListener: (() => void) | null = null;

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
    this.closeListener?.();
  }
  onMessage(listener: (raw: string) => void): void {
    this.messageListener = listener;
  }
  onClose(listener: () => void): void {
    this.closeListener = listener;
  }
  /** Deliver a server message and let its async handling settle. */
  async deliver(raw: string): Promise<void> {
    this.messageListener?.(raw);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  typesSent(): number[] {
    return this.sent.map((message) => message['msg_type'] as number);
  }
}

interface Harness {
  session: ZoomRtmsSession;
  port: RecordingMediaAdapterPort;
  sockets: FakeSocket[];
  clock: { now: number };
  signaling(): FakeSocket;
  media(): FakeSocket;
}

function harness(): Harness {
  const port = new RecordingMediaAdapterPort();
  const sockets: FakeSocket[] = [];
  const clock = { now: 1_000_000 };
  let minted = 0;
  const session = new ZoomRtmsSession({
    identity: { clientId: 'client_abc', meetingUuid: 'meet_uuid_1', rtmsStreamId: 'stream_1' },
    clientSecret: 'client-secret',
    signalingUrl: 'wss://signal.example.test',
    port,
    connect: async () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => clock.now,
    mintParticipantId: () => {
      minted += 1;
      return `zp_${minted}`;
    },
  });
  return {
    session,
    port,
    sockets,
    clock,
    signaling: () => sockets[0]!,
    media: () => sockets[1]!,
  };
}

/** Drive a session all the way to 'ready'. */
async function ready(h: Harness): Promise<void> {
  await h.session.start();
  await h.signaling().deliver(signalingHandshakeResp());
  await h.media().deliver(dataHandshakeResp());
}

describe('handshake ordering', () => {
  it('acks READY on the SIGNALING socket, and only after the media handshake', async () => {
    const h = harness();
    await h.session.start();
    expect(h.session.phase).toBe('signaling-handshake');
    expect(h.signaling().typesSent()).toEqual([MSG.SIGNALING_HAND_SHAKE_REQ]);

    await h.signaling().deliver(signalingHandshakeResp());
    // Media handshake opened; nothing acked yet — acking here would tell Zoom
    // we can receive before we can.
    expect(h.session.phase).toBe('media-handshake');
    expect(h.media().typesSent()).toEqual([MSG.DATA_HAND_SHAKE_REQ]);
    expect(h.signaling().typesSent()).not.toContain(MSG.CLIENT_READY_ACK);

    await h.media().deliver(dataHandshakeResp());
    expect(h.session.phase).toBe('ready');
    // The ack and the event subscription both go back on SIGNALING.
    expect(h.signaling().typesSent()).toEqual([
      MSG.SIGNALING_HAND_SHAKE_REQ,
      MSG.CLIENT_READY_ACK,
      MSG.EVENT_SUBSCRIPTION,
    ]);
    expect(h.media().typesSent()).not.toContain(MSG.CLIENT_READY_ACK);
  });

  it('prefers the audio media url and falls back to "all"', async () => {
    const h = harness();
    await h.session.start();
    await h.signaling().deliver(signalingHandshakeResp({ urls: { all: 'wss://media.example.test/all' } }));
    expect(h.sockets).toHaveLength(2);
    expect(h.session.phase).toBe('media-handshake');
  });

  it('closes the session when a handshake is refused', async () => {
    const h = harness();
    await h.session.start();
    await h.signaling().deliver(signalingHandshakeResp({ statusCode: 3 }));
    expect(h.session.phase).toBe('closed');
    expect(h.port.closes).toHaveLength(1);
  });
});

describe('participant audio', () => {
  it('demultiplexes simultaneous speakers into stable, non-Zoom identities', async () => {
    const h = harness();
    await ready(h);

    await h.media().deliver(audioPacket({ userId: 111, userName: 'Ada', timestamp: 1000 }));
    await h.media().deliver(audioPacket({ userId: 222, userName: 'Bo', timestamp: 1000 }));
    await h.media().deliver(audioPacket({ userId: 111, userName: 'Ada', timestamp: 1020 }));

    const speakers = [...new Set(h.port.frames.map((frame) => frame.participantId))];
    expect(speakers).toHaveLength(2);
    // Same Zoom user always maps to the same Videofy id...
    expect(h.port.frames[0]!.participantId).toBe(h.port.frames[2]!.participantId);
    expect(h.port.frames[0]!.participantId).not.toBe(h.port.frames[1]!.participantId);
    // ...and the Zoom number never becomes the engine identity.
    for (const frame of h.port.frames) {
      expect(frame.participantId).not.toContain('111');
      expect(frame.participantId).not.toContain('222');
    }
  });

  it('introduces a speaker heard before any roster event arrived', async () => {
    const h = harness();
    await ready(h);
    await h.media().deliver(audioPacket({ userId: 111, userName: 'Ada' }));
    expect(h.port.joins).toEqual([{ sessionId: 'stream_1', participantId: 'zp_1', displayName: 'Ada' }]);
    // A second packet from the same speaker must not re-introduce them.
    await h.media().deliver(audioPacket({ userId: 111, userName: 'Ada' }));
    expect(h.port.joins).toHaveLength(1);
  });

  it('reports a gap in one speaker without blaming the other', async () => {
    const h = harness();
    await ready(h);
    const twentyMs = new Array(320).fill(0);
    await h.media().deliver(audioPacket({ userId: 111, samples: twentyMs, timestamp: 1000 }));
    await h.media().deliver(audioPacket({ userId: 222, samples: twentyMs, timestamp: 5000 }));
    await h.media().deliver(audioPacket({ userId: 111, samples: twentyMs, timestamp: 1020 }));
    // Ada is contiguous; Bo's first packet has no predecessor. Neither is a gap.
    expect(h.session.gaps).toHaveLength(0);

    await h.media().deliver(audioPacket({ userId: 111, samples: twentyMs, timestamp: 3000 }));
    expect(h.session.gaps).toHaveLength(1);
    expect(h.session.gaps[0]!.gapMs).toBeGreaterThan(1000);
  });

  it('drops one malformed packet and keeps the meeting alive', async () => {
    const h = harness();
    await ready(h);
    await h.media().deliver(JSON.stringify({ msg_type: MSG.MEDIA_DATA_AUDIO, content: { user_id: 9, data: 'not-base64-pcm-!' } }));
    await h.media().deliver(audioPacket({ userId: 111, userName: 'Ada' }));
    expect(h.session.phase).toBe('ready');
    expect(h.port.frames).toHaveLength(1);
  });

  it('never forwards mixed-stream audio, which would attribute a room to nobody', async () => {
    const h = harness();
    await ready(h);
    await h.media().deliver(audioPacket({ userId: 0 }));
    expect(h.port.frames).toHaveLength(0);
    expect(h.session.phase).toBe('ready');
  });
});

describe('roster events', () => {
  it('maps joins and leaves, and returns a rejoiner as the same person', async () => {
    const h = harness();
    await ready(h);
    await h.signaling().deliver(participantJoinEvent([{ user_id: 111, user_name: 'Ada' }]));
    expect(h.port.joins).toEqual([{ sessionId: 'stream_1', participantId: 'zp_1', displayName: 'Ada' }]);

    await h.signaling().deliver(participantLeaveEvent([111]));
    expect(h.port.leaves).toEqual([{ sessionId: 'stream_1', participantId: 'zp_1' }]);

    // Zoom reuses the user_id on rejoin; the engine should see Ada, not a stranger.
    await h.media().deliver(audioPacket({ userId: 111, userName: 'Ada' }));
    expect(h.port.frames[0]!.participantId).toBe('zp_1');
  });
});

describe('keepalive and recovery', () => {
  it('answers server keepalives on the socket that asked', async () => {
    const h = harness();
    await ready(h);
    await h.signaling().deliver(keepAliveReq(555));
    await h.media().deliver(keepAliveReq(777));
    const signalingReplies = h.signaling().sent.filter((m) => m['msg_type'] === MSG.KEEP_ALIVE_RESP);
    const mediaReplies = h.media().sent.filter((m) => m['msg_type'] === MSG.KEEP_ALIVE_RESP);
    expect(signalingReplies).toEqual([{ msg_type: MSG.KEEP_ALIVE_RESP, timestamp: 555 }]);
    expect(mediaReplies).toEqual([{ msg_type: MSG.KEEP_ALIVE_RESP, timestamp: 777 }]);
  });

  it('re-establishes after 65 seconds of keepalive silence, per Zoom guidance', async () => {
    const h = harness();
    await ready(h);
    h.clock.now += KEEPALIVE_SILENCE_LIMIT_MS - 1;
    await h.session.checkKeepalive();
    expect(h.session.phase).toBe('ready'); // not yet

    h.clock.now += 2;
    await h.session.checkKeepalive();
    // Old sockets released, a fresh signaling handshake sent.
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.sockets[1]!.closed).toBe(true);
    expect(h.sockets).toHaveLength(3);
    expect(h.sockets[2]!.typesSent()).toEqual([MSG.SIGNALING_HAND_SHAKE_REQ]);
  });

  it('keeps identities across a reconnect so a transcript does not split in two', async () => {
    const h = harness();
    await ready(h);
    await h.media().deliver(audioPacket({ userId: 111, userName: 'Ada' }));
    const before = h.port.frames[0]!.participantId;

    h.clock.now += KEEPALIVE_SILENCE_LIMIT_MS + 1;
    await h.session.checkKeepalive();
    await h.sockets[2]!.deliver(signalingHandshakeResp());
    await h.sockets[3]!.deliver(dataHandshakeResp());
    await h.sockets[3]!.deliver(audioPacket({ userId: 111, userName: 'Ada' }));

    expect(h.session.phase).toBe('ready');
    expect(h.port.frames.at(-1)!.participantId).toBe(before);
  });

  it('answers a stale socket on ITSELF, and lets it neither drive nor refresh the live session', async () => {
    const h = harness();
    await ready(h);
    const staleMedia = h.media();

    h.clock.now += KEEPALIVE_SILENCE_LIMIT_MS + 1;
    await h.session.checkKeepalive();
    await h.sockets[2]!.deliver(signalingHandshakeResp());
    await h.sockets[3]!.deliver(dataHandshakeResp());
    const freshMedia = h.sockets[3]!;
    const freshRepliesBefore = freshMedia.sent.filter((m) => m['msg_type'] === MSG.KEEP_ALIVE_RESP).length;

    // A straggler arrives on the SUPERSEDED socket.
    const silentSince = h.clock.now;
    h.clock.now += 30_000;
    await staleMedia.deliver(keepAliveReq(999));

    // It is answered on the socket that asked...
    expect(staleMedia.sent.filter((m) => m['msg_type'] === MSG.KEEP_ALIVE_RESP)).toEqual([
      { msg_type: MSG.KEEP_ALIVE_RESP, timestamp: 999 },
    ]);
    // ...never on the live one...
    expect(freshMedia.sent.filter((m) => m['msg_type'] === MSG.KEEP_ALIVE_RESP)).toHaveLength(
      freshRepliesBefore,
    );

    // ...and it does not count as the live connection being healthy: silence
    // on the real socket must still trip the watchdog.
    h.clock.now = silentSince + KEEPALIVE_SILENCE_LIMIT_MS + 1;
    await h.session.checkKeepalive();
    expect(h.sockets).toHaveLength(5);

    // A superseded socket cannot drive the handshake either.
    await staleMedia.deliver(dataHandshakeResp());
    expect(h.session.phase).not.toBe('ready');
  });

  it('BLOCKER pin: a closed media leg re-establishes instead of going silent forever', async () => {
    const h = harness();
    await ready(h);
    // Signaling stays healthy — the case a single shared deadline would miss.
    h.media().close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.sockets.length).toBeGreaterThan(2);
    expect(h.sockets[2]!.typesSent()).toEqual([MSG.SIGNALING_HAND_SHAKE_REQ]);
  });

  it('BLOCKER pin: a quiet MEDIA leg trips the watchdog even while signaling is healthy', async () => {
    const h = harness();
    await ready(h);
    // Signaling keeps answering every 10s; only the media leg goes quiet.
    for (let elapsed = 0; elapsed < KEEPALIVE_SILENCE_LIMIT_MS + 10_000; elapsed += 10_000) {
      h.clock.now += 10_000;
      await h.signaling().deliver(keepAliveReq(h.clock.now));
      await h.session.checkKeepalive();
    }
    expect(h.sockets.length).toBeGreaterThan(2);
  });

  it('BLOCKER pin: close() fences an in-flight dial rather than reviving the session', async () => {
    const port = new RecordingMediaAdapterPort();
    const sockets: FakeSocket[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new ZoomRtmsSession({
      identity: { clientId: 'c', meetingUuid: 'm', rtmsStreamId: 's' },
      clientSecret: 'secret',
      signalingUrl: 'wss://signal.example.test',
      port,
      connect: async () => {
        await gate;
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const starting = session.start();
    await session.close('stream stopped');
    release();
    await starting;
    // Either the dial never happened, or the socket that arrived after
    // teardown was surrendered — never adopted, and never handshaken on.
    expect(session.phase).toBe('closed');
    for (const socket of sockets) {
      expect(socket.closed).toBe(true);
      expect(socket.typesSent()).toEqual([]);
    }
  });

  it('BLOCKER pin: concurrent watchdog ticks open exactly one replacement', async () => {
    const h = harness();
    await ready(h);
    h.clock.now += KEEPALIVE_SILENCE_LIMIT_MS + 1;
    // Two ticks race, as the 5s interval would against a slower dial.
    await Promise.all([h.session.checkKeepalive(), h.session.checkKeepalive()]);
    expect(h.sockets).toHaveLength(3);
  });

  it('refuses a handshake that silently downgraded to the anonymous mixed stream', async () => {
    const h = harness();
    await h.session.start();
    await h.signaling().deliver(signalingHandshakeResp());
    await h.media().deliver(
      JSON.stringify({
        msg_type: MSG.DATA_HAND_SHAKE_RESP,
        status_code: 0,
        media_params: { audio: { data_opt: 1, sample_rate: 1, channel: 1, codec: 1 } },
      }),
    );
    // Status OK but the wrong audio: refuse loudly rather than discard every
    // packet for an hour while reporting a healthy session.
    expect(h.session.phase).toBe('closed');
    expect(h.port.closes).toHaveLength(1);
  });

  it('clears the gap baseline on re-establish so a restarted clock is not read as continuity', async () => {
    const h = harness();
    await ready(h);
    const twentyMs = new Array(320).fill(0);
    await h.media().deliver(audioPacket({ userId: 111, samples: twentyMs, timestamp: 900_000 }));
    h.clock.now += KEEPALIVE_SILENCE_LIMIT_MS + 1;
    await h.session.checkKeepalive();
    await h.sockets[2]!.deliver(signalingHandshakeResp());
    await h.sockets[3]!.deliver(dataHandshakeResp());
    const gapsBefore = h.session.gaps.length;
    // The new stream restarts its timestamp series near zero.
    await h.sockets[3]!.deliver(audioPacket({ userId: 111, samples: twentyMs, timestamp: 20 }));
    expect(h.session.gaps).toHaveLength(gapsBefore);
    expect(h.port.frames.at(-1)!.platformTimestampMs).toBe(20);
  });

  it('closes once, releasing both sockets and the seam session', async () => {
    const h = harness();
    await ready(h);
    await h.session.close('meeting ended');
    await h.session.close('meeting ended');
    expect(h.port.closes).toEqual([{ sessionId: 'stream_1', reason: 'meeting ended' }]);
    expect(h.signaling().closed).toBe(true);
    expect(h.media().closed).toBe(true);
  });
});
