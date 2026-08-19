/** @author masterzee001 */
/**
 * Synthetic RTMS fixtures, shaped from Zoom's published message examples.
 *
 * These are OUR constructions matching the documented schemas — no captured
 * Zoom traffic, no credentials, no recording of a real meeting. Where Zoom's
 * reference shows a field, it appears here with the documented name and type.
 */
import { MSG, STATUS } from '../protocol.js';

/** Documented example shape of SIGNALING_HAND_SHAKE_RESP. */
export function signalingHandshakeResp(
  overrides: { statusCode?: number; urls?: Record<string, string> } = {},
): string {
  return JSON.stringify({
    msg_type: MSG.SIGNALING_HAND_SHAKE_RESP,
    protocol_version: 1,
    sequence: 0,
    status_code: overrides.statusCode ?? STATUS.OK,
    reason: '',
    media_server: {
      server_urls: overrides.urls ?? {
        audio: 'wss://media.example.test/audio',
        video: 'wss://media.example.test/video',
        transcript: 'wss://media.example.test/transcript',
        all: 'wss://media.example.test/all',
      },
    },
  });
}

export function dataHandshakeResp(statusCode = STATUS.OK): string {
  return JSON.stringify({
    msg_type: MSG.DATA_HAND_SHAKE_RESP,
    protocol_version: 1,
    status_code: statusCode,
    reason: '',
    sequence: 0,
    payload_encrypted: false,
    media_params: { audio: { content_type: 2, sample_rate: 1, channel: 1, codec: 1, data_opt: 2, send_rate: 20 } },
  });
}

export function keepAliveReq(timestamp: number): string {
  return JSON.stringify({ msg_type: MSG.KEEP_ALIVE_REQ, timestamp });
}

/** Little-endian 16-bit PCM, base64 — exactly how RTMS carries audio. */
export function pcmBase64(samples: number[]): string {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer.toString('base64');
}

export function audioPacket(input: {
  userId: number;
  userName?: string;
  samples?: number[];
  timestamp?: number;
}): string {
  const samples = input.samples ?? [0, 128, -128, 256];
  const data = pcmBase64(samples);
  return JSON.stringify({
    msg_type: MSG.MEDIA_DATA_AUDIO,
    content: {
      user_id: input.userId,
      user_name: input.userName ?? 'Speaker',
      data,
      length: samples.length * 2,
      timestamp: input.timestamp ?? 1738392033699,
    },
  });
}

export function participantJoinEvent(
  participants: Array<{ user_id: number; user_name: string }>,
  timestamp = 1727384349000,
): string {
  return JSON.stringify({
    msg_type: MSG.EVENT_UPDATE,
    event: { event_type: 3, timestamp, participants },
  });
}

/** Leave carries user_id only — the documented asymmetry with join. */
export function participantLeaveEvent(userIds: number[], timestamp = 1727384359000): string {
  return JSON.stringify({
    msg_type: MSG.EVENT_UPDATE,
    event: { event_type: 4, timestamp, participants: userIds.map((user_id) => ({ user_id })) },
  });
}
