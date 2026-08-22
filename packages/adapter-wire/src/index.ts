/** @author masterzee001 */
/**
 * The remote media-adapter wire protocol.
 *
 * Types, codec, limits and outcomes — and nothing that opens a socket. The
 * client and the server both speak this package, so neither can hold a private
 * opinion about the framing, and every protocol property can be pinned before a
 * port is ever bound.
 *
 * See docs/P6_9_REMOTE_ADAPTER_WIRE_CONTRACT.md.
 */
export {
  CONNECTION_STREAM_ID,
  FrameFlags,
  HEADER_BYTES,
  Limits,
  MessageType,
  PROTOCOL_VERSION,
  RESERVED_FLAGS_MASK,
  WireProtocolError,
  isKnownMessageType,
  messageTypeName,
  violationScope,
} from './protocol.js';
export type {
  AdapterWireOutcome,
  FrameLossCategory,
  MessageTypeCode,
  MessageTypeName,
  ProtocolViolationScope,
  WireErrorCode,
} from './protocol.js';

export { HOST_IS_LITTLE_ENDIAN, bytesToPcm, pcmToBytes } from './pcm.js';
export type { PcmCodecOptions } from './pcm.js';

export { decodeFrame, encodeFrame, sequenceDistance } from './frame-codec.js';
export type { WireFrame, WireFrameInput } from './frame-codec.js';

export {
  closeSessionRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  decodeJsonPayload,
  dispositionSchema,
  encodeJsonPayload,
  helloAckSchema,
  helloSchema,
  participantRequestSchema,
  protocolVersionSchema,
  sessionCapabilitySchema,
  settlementSchema,
  streamCloseSchema,
  streamOpenAckSchema,
  streamOpenSchema,
  wireErrorSchema,
} from './control.js';
export type {
  CloseSessionRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  Disposition,
  Hello,
  HelloAck,
  ParticipantRequest,
  Settlement,
  StreamClose,
  StreamOpen,
  StreamOpenAck,
  WireError,
} from './control.js';
export * from './translated-media.js';
