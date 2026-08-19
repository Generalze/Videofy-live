/** @author masterzee001 */
/**
 * The Zoom Realtime Media Streams wire protocol, as officially documented.
 *
 * Every constant here comes from Zoom's own reference pages (P6.7 M0 audit):
 * /docs/rtms/data-types/ for the enums, /docs/rtms/event-reference/ for the
 * message shapes, /docs/rtms/media-parameter-definition/ for the audio
 * parameters. Nothing is guessed — a value we could not read on an official
 * page does not appear in this file.
 *
 * Two documented hazards this module exists to absorb:
 *
 * 1. Zoom's prose and its enum page disagree on event NAMES (the enum page
 *    says PARTICIPANT_JOIN, the event reference prose says PARTICIPANT_JOINED)
 *    while agreeing on the numbers. Everything here therefore dispatches on
 *    the NUMBER and never on a name.
 * 2. The signaling handshake response and the webhook both carry a field
 *    called `server_urls`, and they are different shapes — a bare string on
 *    the webhook, a per-media-type object on the handshake response. They are
 *    parsed by separate functions so the two can never be confused.
 */

/** RTMS_MESSAGE_TYPE. Only the members this adapter acts on are named. */
export const MSG = {
  SIGNALING_HAND_SHAKE_REQ: 1,
  SIGNALING_HAND_SHAKE_RESP: 2,
  DATA_HAND_SHAKE_REQ: 3,
  DATA_HAND_SHAKE_RESP: 4,
  EVENT_SUBSCRIPTION: 5,
  EVENT_UPDATE: 6,
  CLIENT_READY_ACK: 7,
  KEEP_ALIVE_REQ: 12,
  KEEP_ALIVE_RESP: 13,
  MEDIA_DATA_AUDIO: 14,
  MEDIA_DATA_VIDEO: 15,
  MEDIA_DATA_SHARE: 16,
  MEDIA_DATA_TRANSCRIPT: 17,
} as const;

/**
 * MEDIA_DATA_TYPE. ALL is a distinct sentinel (32), NOT the bitwise OR of the
 * others — reading it as a union would request the wrong media.
 */
export const MEDIA_TYPE = {
  AUDIO: 1,
  VIDEO: 2,
  DESKSHARE: 4,
  TRANSCRIPT: 8,
  CHAT: 16,
  ALL: 32,
} as const;

/** RTMS_EVENT_TYPE, dispatched by number (see hazard 1 above). */
export const EVENT = {
  FIRST_PACKET_TIMESTAMP: 1,
  ACTIVE_SPEAKER_CHANGE: 2,
  PARTICIPANT_JOIN: 3,
  PARTICIPANT_LEAVE: 4,
  SHARING_START: 5,
  SHARING_STOP: 6,
  MEDIA_CONNECTION_INTERRUPTED: 7,
} as const;

/**
 * Audio media parameters.
 *
 * `data_opt` is the parameter Videofy cares about most: the documented
 * DEFAULT is a single mixed stream whose packets carry `user_id: 0`, i.e. no
 * speaker attribution at all. Per-speaker translation is impossible on that,
 * so this adapter always requests AUDIO_MULTI_STREAMS and refuses attribution
 * -less audio rather than translating a room into one anonymous voice.
 */
export const AUDIO_DATA_OPT = {
  MIXED_STREAM: 1,
  MULTI_STREAMS: 2,
} as const;

/** AUDIO_SAMPLE_RATE — the enum value is an INDEX, not the rate in hertz. */
export const SAMPLE_RATE = { SR_8K: 0, SR_16K: 1, SR_32K: 2, SR_48K: 3 } as const;
export const AUDIO_CHANNEL = { MONO: 1, STEREO: 2 } as const;
export const AUDIO_CODEC = { L16: 1, G711: 2, G722: 3, OPUS: 4 } as const;
export const AUDIO_CONTENT_TYPE = { RTP: 1, RAW_AUDIO: 2 } as const;

/** STATUS_OK plus the handshake failures worth naming in a log line. */
export const STATUS = {
  OK: 0,
  INVALID_MESSAGE_TYPE: 1,
  INVALID_RTMS_STREAM_ID: 2,
  INVALID_SIGNATURE: 3,
  INVALID_PAYLOAD: 4,
  DUPLICATE_SIGNAL_REQUEST: 8,
  INVALID_MEDIA_PARAMS: 17,
} as const;

/**
 * The audio shape this adapter asks for: raw 16 kHz mono L16, per speaker, in
 * 20 ms packets. Chosen to match the engine's existing 16 kHz mono contract
 * exactly, so audio crosses the seam with no resampling and no transcode.
 */
export const REQUESTED_AUDIO_PARAMS = {
  content_type: AUDIO_CONTENT_TYPE.RAW_AUDIO,
  sample_rate: SAMPLE_RATE.SR_16K,
  channel: AUDIO_CHANNEL.MONO,
  codec: AUDIO_CODEC.L16,
  data_opt: AUDIO_DATA_OPT.MULTI_STREAMS,
  send_rate: 20,
} as const;

export interface RtmsAudioPacket {
  userId: number;
  userName: string;
  /** Raw decoded PCM; still base64 on the wire. */
  pcm: Buffer;
  /** Zoom server creation time, advancing by send_rate per packet per user. */
  timestamp: number;
}

export interface RtmsParticipantEvent {
  kind: 'join' | 'leave' | 'active-speaker';
  participants: Array<{ userId: number; userName?: string }>;
  timestamp: number;
}

export type RtmsInbound =
  | { kind: 'signaling-handshake-resp'; statusCode: number; reason?: string; mediaServerUrls: Record<string, string> }
  | { kind: 'data-handshake-resp'; statusCode: number; reason?: string; negotiatedMediaParams: unknown }
  | { kind: 'keepalive-req'; timestamp: number }
  | { kind: 'event-update'; event: RtmsParticipantEvent }
  | { kind: 'audio'; packet: RtmsAudioPacket }
  | { kind: 'other'; msgType: number };

/**
 * The handshake response echoes the NEGOTIATED media params, which may differ
 * from what we asked for. Checking them is not pedantry: mixed stream is the
 * documented DEFAULT, and a silent downgrade to it yields a session that looks
 * perfectly healthy while every packet is discarded as unattributed - an hour
 * of silence instead of a refused handshake.
 */
export function audioParamsAsRequested(
  negotiated: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (typeof negotiated !== 'object' || negotiated === null) {
    return { ok: false, reason: 'handshake response carried no media_params' };
  }
  const audio = (negotiated as Record<string, unknown>)['audio'];
  if (typeof audio !== 'object' || audio === null) {
    return { ok: false, reason: 'handshake response carried no audio params' };
  }
  const settings = audio as Record<string, unknown>;
  const expected: Array<[string, number, string]> = [
    ['data_opt', AUDIO_DATA_OPT.MULTI_STREAMS, 'per-speaker audio'],
    ['sample_rate', SAMPLE_RATE.SR_16K, '16 kHz'],
    ['channel', AUDIO_CHANNEL.MONO, 'mono'],
    ['codec', AUDIO_CODEC.L16, 'raw L16'],
  ];
  for (const [field, want, description] of expected) {
    const got = settings[field];
    // Absent means Zoom did not echo it; only a WRONG value is a downgrade.
    if (typeof got === 'number' && got !== want) {
      return { ok: false, reason: description + ' refused (' + field + '=' + String(got) + ')' };
    }
  }
  return { ok: true };
}

export class RtmsProtocolError extends Error {
  constructor(
    readonly code: 'malformed' | 'unsupported-audio' | 'unattributed-audio',
    message: string,
  ) {
    super(message);
    this.name = 'RtmsProtocolError';
  }
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RtmsProtocolError('malformed', 'RTMS message must be a JSON object.');
  }
  return raw as Record<string, unknown>;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RtmsProtocolError('malformed', `RTMS field ${field} must be a number.`);
  }
  return value;
}

/**
 * Parse one inbound RTMS message. Unknown message types are surfaced as
 * 'other' rather than thrown: Zoom's enum runs to 29 and will grow, and a
 * live meeting must not die because a future message type appeared.
 */
export function parseInbound(raw: unknown): RtmsInbound {
  const message = asRecord(raw);
  const msgType = integer(message['msg_type'], 'msg_type');

  switch (msgType) {
    case MSG.SIGNALING_HAND_SHAKE_RESP: {
      const mediaServer = message['media_server'];
      const urls =
        typeof mediaServer === 'object' && mediaServer !== null
          ? (mediaServer as Record<string, unknown>)['server_urls']
          : undefined;
      // Handshake-response shape: an OBJECT keyed by media type. The webhook's
      // same-named field is a bare string and is parsed elsewhere.
      const mediaServerUrls: Record<string, string> = {};
      if (typeof urls === 'object' && urls !== null && !Array.isArray(urls)) {
        for (const [key, value] of Object.entries(urls as Record<string, unknown>)) {
          if (typeof value === 'string') mediaServerUrls[key] = value;
        }
      }
      return {
        kind: 'signaling-handshake-resp',
        statusCode: integer(message['status_code'], 'status_code'),
        ...(typeof message['reason'] === 'string' ? { reason: message['reason'] } : {}),
        mediaServerUrls,
      };
    }

    case MSG.DATA_HAND_SHAKE_RESP:
      return {
        kind: 'data-handshake-resp',
        statusCode: integer(message['status_code'], 'status_code'),
        ...(typeof message['reason'] === 'string' ? { reason: message['reason'] } : {}),
        negotiatedMediaParams: message['media_params'],
      };

    case MSG.KEEP_ALIVE_REQ:
      // The SERVER initiates keepalives and the app answers — the opposite of
      // most protocols. We need a responder and a watchdog, never a send timer.
      return { kind: 'keepalive-req', timestamp: integer(message['timestamp'], 'timestamp') };

    case MSG.EVENT_UPDATE:
      return { kind: 'event-update', event: parseEventUpdate(message) };

    case MSG.MEDIA_DATA_AUDIO:
      return { kind: 'audio', packet: parseAudioPacket(message) };

    default:
      return { kind: 'other', msgType };
  }
}

function parseEventUpdate(message: Record<string, unknown>): RtmsParticipantEvent {
  const event = asRecord(message['event']);
  const eventType = integer(event['event_type'], 'event.event_type');
  const timestamp = typeof event['timestamp'] === 'number' ? event['timestamp'] : 0;

  const readRoster = (): Array<{ userId: number; userName?: string }> => {
    const list = event['participants'];
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const person = entry as Record<string, unknown>;
      if (typeof person['user_id'] !== 'number') return [];
      // Leave events carry user_id only — the name is absent by design.
      return [
        {
          userId: person['user_id'],
          ...(typeof person['user_name'] === 'string' ? { userName: person['user_name'] } : {}),
        },
      ];
    });
  };

  switch (eventType) {
    case EVENT.PARTICIPANT_JOIN:
      return { kind: 'join', participants: readRoster(), timestamp };
    case EVENT.PARTICIPANT_LEAVE:
      return { kind: 'leave', participants: readRoster(), timestamp };
    case EVENT.ACTIVE_SPEAKER_CHANGE:
      return {
        kind: 'active-speaker',
        participants:
          typeof event['user_id'] === 'number'
            ? [
                {
                  userId: event['user_id'],
                  ...(typeof event['user_name'] === 'string' ? { userName: event['user_name'] } : {}),
                },
              ]
            : [],
        timestamp,
      };
    default:
      return { kind: 'active-speaker', participants: [], timestamp };
  }
}

/**
 * Audio arrives nested under `content`, not flat on the message. A packet
 * whose user_id is 0 is MIXED audio: the whole room in one anonymous stream.
 * We refuse it loudly rather than attributing a meeting to a phantom speaker.
 */
export function parseAudioPacket(message: Record<string, unknown>): RtmsAudioPacket {
  const content = asRecord(message['content']);
  const userId = integer(content['user_id'], 'content.user_id');
  if (userId === 0) {
    throw new RtmsProtocolError(
      'unattributed-audio',
      'Mixed-stream audio carries no speaker identity; this adapter requires AUDIO_MULTI_STREAMS.',
    );
  }
  const data = content['data'];
  if (typeof data !== 'string') {
    throw new RtmsProtocolError('malformed', 'Audio packet data must be a base64 string.');
  }
  return {
    userId,
    userName: typeof content['user_name'] === 'string' ? content['user_name'] : '',
    pcm: Buffer.from(data, 'base64'),
    timestamp: typeof content['timestamp'] === 'number' ? content['timestamp'] : 0,
  };
}

// ---------------------------------------------------------------------------
// Outbound messages
// ---------------------------------------------------------------------------

export interface HandshakeIdentity {
  clientId: string;
  meetingUuid: string;
  rtmsStreamId: string;
}

export function signalingHandshakeRequest(identity: HandshakeIdentity, signature: string): object {
  return {
    msg_type: MSG.SIGNALING_HAND_SHAKE_REQ,
    protocol_version: 1,
    sequence: 0,
    meeting_uuid: identity.meetingUuid,
    rtms_stream_id: identity.rtmsStreamId,
    signature,
    buffer_data: false,
  };
}

export function audioHandshakeRequest(identity: HandshakeIdentity, signature: string): object {
  return {
    msg_type: MSG.DATA_HAND_SHAKE_REQ,
    protocol_version: 1,
    sequence: 0,
    meeting_uuid: identity.meetingUuid,
    rtms_stream_id: identity.rtmsStreamId,
    signature,
    media_type: MEDIA_TYPE.AUDIO,
    media_params: { audio: { ...REQUESTED_AUDIO_PARAMS } },
  };
}

/**
 * Sent on the SIGNALING connection — not the media one — and only once every
 * intended media handshake has completed. That cross-socket ordering is the
 * one thing a naive state machine gets wrong.
 */
export function clientReadyAck(rtmsStreamId: string): object {
  return { msg_type: MSG.CLIENT_READY_ACK, rtms_stream_id: rtmsStreamId };
}

export function keepAliveResponse(timestamp: number): object {
  return { msg_type: MSG.KEEP_ALIVE_RESP, timestamp };
}

/**
 * Events are opt-in. Skip this and the stream connects, plays audio, and never
 * reports a single join or leave — which reads exactly like a broken roster.
 */
export function eventSubscription(eventTypes: readonly number[]): object {
  return {
    msg_type: MSG.EVENT_SUBSCRIPTION,
    events: eventTypes.map((eventType) => ({ event_type: eventType, subscribe: true })),
  };
}
