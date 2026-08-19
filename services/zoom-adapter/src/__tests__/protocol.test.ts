/** @author masterzee001 */
/**
 * The wire protocol: parsing what Zoom documents, refusing what it does not,
 * and never confusing the two fields Zoom gave the same name.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIO_DATA_OPT,
  MEDIA_TYPE,
  MSG,
  REQUESTED_AUDIO_PARAMS,
  RtmsProtocolError,
  audioHandshakeRequest,
  clientReadyAck,
  eventSubscription,
  keepAliveResponse,
  parseInbound,
  signalingHandshakeRequest,
} from '../protocol.js';
import { rtmsStreamSignature, signaturesMatch, urlValidationResponse, webhookSignature } from '../credentials.js';
import { decodePcm16, measureGap, toAdapterFrame } from '../audio.js';
import { audioPacket, dataHandshakeResp, keepAliveReq, participantJoinEvent, participantLeaveEvent, pcmBase64, signalingHandshakeResp } from './fixtures.js';

const IDENTITY = { clientId: 'client_abc', meetingUuid: 'meet_uuid_1', rtmsStreamId: 'stream_1' };

describe('inbound parsing', () => {
  it('reads the signaling handshake response as a per-media-type url OBJECT', () => {
    const parsed = parseInbound(JSON.parse(signalingHandshakeResp()));
    expect(parsed.kind).toBe('signaling-handshake-resp');
    if (parsed.kind !== 'signaling-handshake-resp') throw new Error('wrong kind');
    // The webhook's same-named field is a bare string; these must never be
    // parsed by the same code path.
    expect(parsed.mediaServerUrls['audio']).toBe('wss://media.example.test/audio');
    expect(parsed.mediaServerUrls['all']).toBe('wss://media.example.test/all');
    expect(parsed.statusCode).toBe(0);
  });

  it('surfaces a refused handshake with its status code rather than throwing', () => {
    const parsed = parseInbound(JSON.parse(signalingHandshakeResp({ statusCode: 3 })));
    if (parsed.kind !== 'signaling-handshake-resp') throw new Error('wrong kind');
    expect(parsed.statusCode).toBe(3); // STATUS_INVALID_SIGNATURE
  });

  it('reads audio from the nested content object', () => {
    const parsed = parseInbound(JSON.parse(audioPacket({ userId: 16778240, userName: 'John Smith' })));
    if (parsed.kind !== 'audio') throw new Error('wrong kind');
    expect(parsed.packet.userId).toBe(16778240);
    expect(parsed.packet.userName).toBe('John Smith');
    expect(parsed.packet.pcm.length).toBe(8);
  });

  it('REFUSES mixed-stream audio, which carries user_id 0 and no speaker at all', () => {
    expect(() => parseInbound(JSON.parse(audioPacket({ userId: 0 })))).toThrow(RtmsProtocolError);
    try {
      parseInbound(JSON.parse(audioPacket({ userId: 0 })));
    } catch (error) {
      expect((error as RtmsProtocolError).code).toBe('unattributed-audio');
    }
  });

  it('reads join with names and leave with ids only — the documented asymmetry', () => {
    const joined = parseInbound(JSON.parse(participantJoinEvent([{ user_id: 11, user_name: 'Ada' }])));
    if (joined.kind !== 'event-update') throw new Error('wrong kind');
    expect(joined.event.kind).toBe('join');
    expect(joined.event.participants).toEqual([{ userId: 11, userName: 'Ada' }]);

    const left = parseInbound(JSON.parse(participantLeaveEvent([11])));
    if (left.kind !== 'event-update') throw new Error('wrong kind');
    expect(left.event.kind).toBe('leave');
    expect(left.event.participants).toEqual([{ userId: 11 }]);
  });

  it('answers keepalives by echoing the server timestamp', () => {
    const parsed = parseInbound(JSON.parse(keepAliveReq(1727384349123)));
    if (parsed.kind !== 'keepalive-req') throw new Error('wrong kind');
    expect(keepAliveResponse(parsed.timestamp)).toEqual({
      msg_type: MSG.KEEP_ALIVE_RESP,
      timestamp: 1727384349123,
    });
  });

  it('tolerates unknown message types instead of failing the meeting', () => {
    expect(parseInbound({ msg_type: 29 })).toEqual({ kind: 'other', msgType: 29 });
  });

  it('rejects malformed frames', () => {
    expect(() => parseInbound(null)).toThrow(RtmsProtocolError);
    expect(() => parseInbound('not an object')).toThrow(RtmsProtocolError);
    expect(() => parseInbound({ no_msg_type: true })).toThrow(RtmsProtocolError);
    expect(() => parseInbound({ msg_type: MSG.MEDIA_DATA_AUDIO, content: { user_id: 5, data: 42 } })).toThrow(
      RtmsProtocolError,
    );
  });
});

describe('outbound messages', () => {
  it('asks for per-speaker 16 kHz mono L16 in 20 ms packets', () => {
    const request = audioHandshakeRequest(IDENTITY, 'sig') as Record<string, unknown>;
    expect(request['msg_type']).toBe(MSG.DATA_HAND_SHAKE_REQ);
    expect(request['media_type']).toBe(MEDIA_TYPE.AUDIO);
    const params = (request['media_params'] as { audio: Record<string, number> }).audio;
    // Multi-stream is the whole point: the default mixed stream is anonymous.
    expect(params['data_opt']).toBe(AUDIO_DATA_OPT.MULTI_STREAMS);
    expect(REQUESTED_AUDIO_PARAMS.sample_rate).toBe(1); // SR_16K is index 1, not 16000
    expect(params['channel']).toBe(1);
    expect(params['codec']).toBe(1);
    expect(params['send_rate']).toBe(20);
  });

  it('builds the signaling handshake and the ready ack in their documented shapes', () => {
    const handshake = signalingHandshakeRequest(IDENTITY, 'sig') as Record<string, unknown>;
    expect(handshake['msg_type']).toBe(MSG.SIGNALING_HAND_SHAKE_REQ);
    expect(handshake['meeting_uuid']).toBe('meet_uuid_1');
    expect(handshake['rtms_stream_id']).toBe('stream_1');
    expect(clientReadyAck('stream_1')).toEqual({ msg_type: MSG.CLIENT_READY_ACK, rtms_stream_id: 'stream_1' });
  });

  it('subscribes explicitly, because events are opt-in and silence looks like a bug', () => {
    const subscription = eventSubscription([3, 4]) as { msg_type: number; events: unknown[] };
    expect(subscription.msg_type).toBe(MSG.EVENT_SUBSCRIPTION);
    expect(subscription.events).toEqual([
      { event_type: 3, subscribe: true },
      { event_type: 4, subscribe: true },
    ]);
  });
});

describe('the two signatures', () => {
  it('signs an RTMS stream over client_id,meeting_uuid,rtms_stream_id with the CLIENT secret', () => {
    const signature = rtmsStreamSignature({
      clientId: 'client_abc',
      clientSecret: 'client-secret',
      meetingUuid: 'meet_uuid_1',
      rtmsStreamId: 'stream_1',
    });
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    // Any component changing must change the signature.
    const other = rtmsStreamSignature({
      clientId: 'client_abc',
      clientSecret: 'client-secret',
      meetingUuid: 'meet_uuid_2',
      rtmsStreamId: 'stream_1',
    });
    expect(other).not.toBe(signature);
  });

  it('signs a webhook over v0:{timestamp}:{raw body} with the WEBHOOK secret — a different scheme', () => {
    const signature = webhookSignature({ secretToken: 'webhook-secret', timestamp: '1700000000', rawBody: '{"a":1}' });
    expect(signature).toMatch(/^v0=[0-9a-f]{64}$/);
    // Same inputs under the stream scheme must not collide with this one.
    const stream = rtmsStreamSignature({
      clientId: 'webhook-secret',
      clientSecret: 'webhook-secret',
      meetingUuid: '1700000000',
      rtmsStreamId: '{"a":1}',
    });
    expect(signature.slice(3)).not.toBe(stream);
  });

  it('compares in constant time and answers false on a length mismatch', () => {
    expect(signaturesMatch('v0=abc', 'v0=abc')).toBe(true);
    expect(signaturesMatch('v0=abc', 'v0=abcd')).toBe(false);
    expect(signaturesMatch('v0=abc', 'v0=abd')).toBe(false);
  });

  it('answers the endpoint validation challenge with the token and its hmac', () => {
    const answer = urlValidationResponse('webhook-secret', 'plain-1');
    expect(answer.plainToken).toBe('plain-1');
    expect(answer.encryptedToken).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('audio decoding', () => {
  it('reinterprets little-endian PCM16 without transcoding', () => {
    const samples = decodePcm16(Buffer.from(pcmBase64([0, 1000, -1000, 32767, -32768]), 'base64'));
    expect([...samples]).toEqual([0, 1000, -1000, 32767, -32768]);
  });

  it('refuses payloads that are not whole 16-bit samples', () => {
    expect(() => decodePcm16(Buffer.from([1, 2, 3]))).toThrow(RtmsProtocolError);
    expect(() => decodePcm16(Buffer.alloc(0))).toThrow(RtmsProtocolError);
  });

  it('presents frames in the engine format with no resampling', () => {
    const parsed = parseInbound(JSON.parse(audioPacket({ userId: 7, samples: new Array(320).fill(0) })));
    if (parsed.kind !== 'audio') throw new Error('wrong kind');
    const frame = toAdapterFrame(parsed.packet, 'zp_test');
    expect(frame.sampleRate).toBe(16000);
    expect(frame.channelCount).toBe(1);
    // 320 samples at 16 kHz is exactly the documented 20 ms packet.
    expect(frame.samples.length).toBe(320);
  });

  it('measures gaps per speaker, treating contiguous packets as continuous', () => {
    const frame = { participantId: 'a', samples: new Int16Array(320), sampleRate: 16000, channelCount: 1, platformTimestampMs: 1020 } as const;
    expect(measureGap({ platformTimestampMs: 1000, durationMs: 20 }, frame).contiguous).toBe(true);
    // A 500 ms jump is missing speech, not silence — the engine must know.
    const late = { ...frame, platformTimestampMs: 1520 };
    const gap = measureGap({ platformTimestampMs: 1000, durationMs: 20 }, late);
    expect(gap.contiguous).toBe(false);
    expect(gap.gapMs).toBe(500);
    expect(measureGap(null, frame).contiguous).toBe(true);
  });
});
