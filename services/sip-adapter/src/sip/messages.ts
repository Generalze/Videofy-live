/** @author masterzee001 */
/**
 * SIP messages and SDP, parsed and built — signalling only.
 *
 * This file knows nothing about RTP packets, jitter or codecs beyond their
 * names in an offer. Keeping signalling separate from media is the difference
 * between a dialog state machine and the single enormous class that SIP
 * implementations tend to grow into, where a malformed header can drop audio
 * and a lost packet can confuse a dialog.
 */

export interface SipMessage {
  kind: 'request' | 'response';
  method?: string;
  requestUri?: string;
  statusCode?: number;
  reason?: string;
  headers: Record<string, string>;
  body: string;
}

export class SipParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SipParseError';
  }
}

/** Header names are case-insensitive on the wire; normalized to lower-case. */
function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

export function parseSipMessage(raw: string): SipMessage {
  const [head, ...bodyParts] = raw.split('\r\n\r\n');
  if (head === undefined || head.trim() === '') {
    throw new SipParseError('SIP message has no start line.');
  }
  const lines = head.split('\r\n');
  const startLine = lines.shift();
  if (startLine === undefined || startLine.trim() === '') {
    throw new SipParseError('SIP message has an empty start line.');
  }

  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const name = normalizeHeaderName(line.slice(0, separator));
    const value = line.slice(separator + 1).trim();
    // Repeated headers (Via chains) are kept in wire order, comma-joined.
    headers[name] = headers[name] === undefined ? value : `${headers[name]},${value}`;
  }
  const body = bodyParts.join('\r\n\r\n');

  if (startLine.startsWith('SIP/2.0')) {
    const [, statusText, ...reasonParts] = startLine.split(' ');
    const statusCode = Number.parseInt(statusText ?? '', 10);
    if (!Number.isInteger(statusCode)) {
      throw new SipParseError(`SIP response has no status code: ${startLine}`);
    }
    return { kind: 'response', statusCode, reason: reasonParts.join(' '), headers, body };
  }

  const [method, requestUri, version] = startLine.split(' ');
  if (method === undefined || requestUri === undefined || version === undefined) {
    throw new SipParseError(`SIP request start line is malformed: ${startLine}`);
  }
  return { kind: 'request', method: method.toUpperCase(), requestUri, headers, body };
}

export function serializeSipMessage(message: SipMessage): string {
  const startLine =
    message.kind === 'response'
      ? `SIP/2.0 ${message.statusCode} ${message.reason ?? ''}`.trimEnd()
      : `${message.method} ${message.requestUri} SIP/2.0`;
  const headers = { ...message.headers, 'content-length': String(Buffer.byteLength(message.body)) };
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `${startLine}\r\n${lines.join('\r\n')}\r\n\r\n${message.body}`;
}

/**
 * The sequence number from a CSeq header, or null if it is not usable.
 *
 * CSeq is the only thing that distinguishes a stale copy of an earlier request
 * from a current one: Call-ID is identical, the tags are identical, and a
 * verbatim replay is byte-for-byte the message we already answered.
 */
export function cseqNumberOf(header: string | undefined): number | null {
  if (header === undefined) return null;
  const [text] = header.trim().split(/\s+/);
  if (text === undefined || !/^\d{1,10}$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/** The tag on a From/To header — half of a dialog's identity. */
export function tagOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /;tag=([^;\s>]+)/.exec(header);
  return match?.[1] ?? null;
}

// --- SDP -------------------------------------------------------------------

export interface SdpMedia {
  port: number;
  /** Payload types offered, in the offerer's order of preference. */
  payloadTypes: number[];
  address: string;
}

export interface ParsedSdp {
  address: string;
  audio: SdpMedia | null;
}

/**
 * Enough SDP to negotiate one audio stream. Deliberately not a general SDP
 * implementation: everything this adapter needs is the peer's address, its
 * audio port, and which payload types it will accept.
 */
export function parseSdp(body: string): ParsedSdp {
  let sessionAddress = '';
  let audio: SdpMedia | null = null;
  let inAudio = false;
  let inMediaSection = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('c=')) {
      const address = line.split(' ').at(2) ?? '';
      if (inAudio && audio !== null) audio.address = address;
      // Only a c= BEFORE any m= is the session default. One inside a video or
      // application section belongs to that section, and letting it overwrite
      // the session address would send this call's audio wherever it named.
      else if (!inMediaSection) sessionAddress = address;
      continue;
    }
    if (line.startsWith('m=')) {
      inMediaSection = true;
      const [media, port, , ...formats] = line.slice(2).split(' ');
      inAudio = media === 'audio';
      if (!inAudio) continue;
      audio = {
        port: Number.parseInt(port ?? '0', 10),
        payloadTypes: formats
          .map((format) => Number.parseInt(format, 10))
          .filter((value) => Number.isInteger(value)),
        address: '',
      };
    }
  }
  if (audio !== null && audio.address === '') audio.address = sessionAddress;
  return { address: sessionAddress, audio };
}

export interface SdpAnswerInput {
  address: string;
  port: number;
  payloadType: number;
  codecName: string;
  clockRate: number;
  sessionId: number;
}

export function buildSdp(input: SdpAnswerInput): string {
  return [
    'v=0',
    `o=videofy ${input.sessionId} ${input.sessionId} IN IP4 ${input.address}`,
    's=Videofy',
    `c=IN IP4 ${input.address}`,
    't=0 0',
    `m=audio ${input.port} RTP/AVP ${input.payloadType}`,
    `a=rtpmap:${input.payloadType} ${input.codecName}/${input.clockRate}`,
    // The adapter both hears and speaks: it is not a listener.
    'a=sendrecv',
    '',
  ].join('\r\n');
}
