/** @author masterzee001 */
/**
 * The SIP/RTP transport adapter's public surface.
 *
 * THIS PACKAGE IS A LIBRARY, NOT A SERVICE. It has no `dev` or `start` script
 * and nothing here binds a socket or starts a process, because there is
 * currently nothing for a running SIP service to deliver audio to: the only
 * implementation of `MediaAdapterPort` in this repository is the in-memory
 * recording double used by the suites. Runtime composition — the process that
 * owns the sockets, drives `pump()` on a timer, and hands frames to the trusted
 * ingress — arrives with the Adapter Ingress Binding in P6.9.
 *
 * The package previously declared `main`, `dev` and `start` pointing at an
 * `index.ts` that did not exist. `tsc` compiled the files that were there and
 * `--noEmit` was happy, so typecheck and build both passed while `npm start`
 * and `npm run dev` would have failed on a missing file. Green checks that
 * verify nothing are worse than no checks, because they are believed.
 */
export { SipCall, CODECS, UnsupportedCodecError } from './call.js';
export type {
  RtpTarget,
  MediaLedger,
  SipCallDeps,
  CallMeasurements,
} from './call.js';

export {
  CallLifecycle,
  PERMITTED_TRANSITIONS,
  SYSTEM_TIMERS,
  acceptsMediaIn,
  deliversMediaIn,
  guardedLogger,
  invokeBounded,
  mayTransition,
} from './lifecycle.js';
export type {
  CallLifecycleDeps,
  CallbackOutcome,
  LifecycleState,
  LifecycleSteps,
  LifecycleTimers,
  LifecycleTransition,
  LogSink,
  TerminationIntent,
  TerminationMode,
  TimerHandle,
} from './lifecycle.js';

export { LOOPBACK_ONLY, maySendMediaTo } from './media-policy.js';
export type { MediaDestinationPolicy } from './media-policy.js';

export {
  PAYLOAD_TYPE,
  codecForPayloadType,
  decodeToEngineFormat,
  downsample16kTo8k,
  encodeFromEngineFormat,
  upsample8kTo16k,
} from './codec/index.js';
export type { Codec, CodecName, TranscodeResult } from './codec/index.js';

export { JitterBuffer } from './rtp/jitter-buffer.js';
export type {
  EmittedPacket,
  JitterBufferOptions,
  JitterStats,
} from './rtp/jitter-buffer.js';

export { RtpParseError, parseRtpPacket, sequenceDelta, serializeRtpPacket } from './rtp/packet.js';
export type { RtpPacket, RtpSerializeInput } from './rtp/packet.js';

export { SipDialog, SipDialogError } from './sip/dialog.js';
export type {
  DialogIdentity,
  DialogSnapshot,
  DialogState,
  SipDialogOptions,
} from './sip/dialog.js';

export {
  SipParseError,
  buildSdp,
  cseqNumberOf,
  parseSdp,
  parseSipMessage,
  serializeSipMessage,
  tagOf,
} from './sip/messages.js';
export type { ParsedSdp, SdpAnswerInput, SdpMedia, SipMessage } from './sip/messages.js';
