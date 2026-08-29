import type { ChannelCategory } from './channel-category.js';
import type { SourceLanguageMode } from './language-controls.js';

/**
 * Socket.IO event name constants shared between the gateway server and all
 * clients (listener, operator, speech worker, media ingest).
 */

// Gateway → listener
export const SOCKET_EVENTS = {
  // Server → client
  TRANSLATION_EVENT: 'translation:event',
  TRANSCRIPTION_EVENT: 'transcription:event',
  TIMESTAMPED_TRANSLATION_EVENT: 'translation:timestamped',
  GENERATED_AUDIO_READY: 'audio:generated-ready',
  MEDIA_STATE: 'media:state',
  STREAM_STATUS: 'stream:status',
  TRANSLATED_AUDIO: 'audio:translated',
  SERVICE_STATUS: 'service:status',
  AUDIO_MODE_PREFERENCES: 'audio:mode-preferences',
  CONTROL_ACK: 'operator:control_ack',
  ERROR: 'error',

  // Client → server
  JOIN_LANGUAGE: 'join:language',
  /**
   * Join one channel in one language.
   *
   * Supersedes JOIN_LANGUAGE, which keeps working and is treated as "the
   * default channel, in this language" -- so existing clients continue
   * unchanged and can be migrated one at a time rather than all at once on the
   * same deploy.
   */
  JOIN_CHANNEL: 'join:channel',
  /** An operator setting their channel name, visibility and join code. */
  OPERATOR_CHANNEL_SETTINGS: 'operator:channel-settings',
  /** The gateway telling an operator which channel is theirs, and which they are on. */
  CHANNEL_ASSIGNED: 'channel:assigned',
  /** The channels currently broadcasting, for a listener to choose from. */
  CHANNEL_DIRECTORY: 'channel:directory',
  LEAVE_LANGUAGE: 'leave:language',

  // Speech worker → gateway
  WORKER_TRANSLATION: 'worker:translation',
  WORKER_HEALTH: 'worker:health',
  WORKER_TRIGGER_PHRASE: 'worker:trigger_phrase',
  WORKER_RESET_SEQUENCE: 'worker:reset_sequence',

  // Media ingest → gateway
  INGEST_STATE: 'ingest:state',
  INGEST_TRANSCRIPTION: 'ingest:transcription',
  INGEST_TRANSLATION: 'ingest:translation',
  /**
   * A platform transcript event from the LIVE path.
   *
   * Its own event rather than reusing `ingest:transcription`, which is keyed by
   * `chunkId` -- an identity the live path does not have, because there are no
   * chunks. Forcing one shape to carry both would mean inventing a chunk id for
   * audio that was never a chunk, and every consumer would then have to know
   * which ids were real.
   */
  INGEST_LIVE_TRANSCRIPT: 'ingest:live-transcript',
  /**
   * One frame of translated speech, while the sentence is still being made.
   *
   * Replaces, for the live path, the pattern of announcing a URL to a finished
   * audio file. A client plays these in `sequence` order within a
   * `(segmentId, generation)` and drops any frame whose generation is older
   * than the newest it has seen -- which is how a superseded sentence stops
   * without the client needing to know why it was superseded.
   */
  TRANSLATED_AUDIO_FRAME: 'translated-audio:frame',
  INGEST_GENERATED_AUDIO: 'ingest:generated-audio',
  INGEST_HEALTH: 'ingest:health',
  INGEST_START_STREAM: 'ingest:start_stream',
  INGEST_STOP_STREAM: 'ingest:stop_stream',

  // Operator → gateway
  OPERATOR_CONTROL: 'operator:control',
  OPERATOR_AUDIO_MODE_PREFERENCES: 'operator:audio-mode-preferences',
  OPERATOR_PROGRAMME_SESSION_CONFIG: 'operator:programme-session-config',

  // WebRTC signalling (P4.0 contracts only; no media transport)
  WEBRTC_SESSION_CREATE: 'webrtc:session:create',
  WEBRTC_SESSION_JOIN: 'webrtc:session:join',
  WEBRTC_SIGNAL: 'webrtc:signal',
  WEBRTC_SESSION_LEAVE: 'webrtc:session:leave',
  WEBRTC_SESSION_CLOSE: 'webrtc:session:close',
  WEBRTC_SESSION_EVENT: 'webrtc:session:event',
  WEBRTC_ERROR: 'webrtc:error',

  // Shared
  CONNECTED: 'connect',
  DISCONNECTED: 'disconnect',
  RECONNECT: 'reconnect',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

/** Room naming convention for per-language translation channels. */
export function languageRoom(targetLanguage: string): string {
  return `lang:${targetLanguage}`;
}

/** Room for operator dashboard connections. */
/**
 * The channel every existing client is already on.
 *
 * Clients that predate channels send no channel and are treated as being here,
 * which is what lets channels ship without a coordinated client release.
 */
export const DEFAULT_CHANNEL_ID = 'main';

/**
 * Who can reach a channel. The founder's ruling (2026-08-27) named the tiers:
 *
 *   public  - listed in the directory, open to anybody who knows the channel.
 *   private - not listed; the operator's invite link is what admits a viewer.
 *             A doorbell without a sign, not a lock.
 *   locked  - not listed, and the link alone is not enough: a join code must
 *             be presented too (or an access link that carries it). This is
 *             the only tier that is an access CONTROL, which is why the other
 *             two are not called locked -- somebody would eventually build on
 *             that promise.
 *
 * ('private' was previously spelled 'unlisted' and 'locked' was 'private';
 * the semantics did not change, only the names people see.)
 */
export type ChannelVisibility = 'public' | 'private' | 'locked';

/** What a listener is given when choosing where to listen. */
export interface ChannelSummary {
  readonly channelId: string;
  readonly displayName: string;
  readonly live: boolean;
  readonly visibility: ChannelVisibility;
  /**
   * The operator's declared category, or null when none is chosen.
   *
   * Founder ruling (29 Aug 2026): "Channel categories: explicit server
   * field. Do not infer semantic categories from follows, visibility or live
   * status." A client that groups channels reads THIS and nothing else; null
   * means uncategorised, not an invitation to guess.
   */
  readonly category: ChannelCategory | null;
}

/**
 * What an operator sends on operator:channel-settings.
 *
 * Every field is optional and an absent field means "leave it alone", which
 * is what lets the console change visibility without resending a join code
 * it does not have. `code: null` clears the code; `category: null` clears the
 * category. A category off the controlled list is refused whole: the gateway
 * answers ERROR "Choose a category from the list." and applies nothing.
 */
export interface OperatorChannelSettingsPayload {
  displayName?: string;
  visibility?: ChannelVisibility;
  code?: string | null;
  /** One primary category in v1 (founder ruling, 29 Aug 2026), or null for none. */
  category?: ChannelCategory | null;
}

/** What the gateway answers with on channel:assigned. */
export interface ChannelAssignedPayload {
  /** The operator's own channel id, as the gateway derived it. */
  channelId: string;
  /** The channel they are publishing to now. */
  active: string;
  /** Whether a join code is SET on the active channel; never the code itself. */
  hasCode?: boolean;
  /** The active channel's category, so a reloaded console shows the truth. */
  category?: ChannelCategory | null;
}

export const OPERATOR_ROOM = 'operators';

/** Room for media-ingest connections. */
export const INGEST_ROOM = 'ingest';

/** Room for speech-worker connections. */
export const WORKER_ROOM = 'workers';

export interface OperatorProgrammeSessionConfig {
  sessionId: string;
  broadcastId: string;
  sourceRevision: number;
  programmeSourceType?: string;
  rtmpPlaybackUrl?: string;
  targetLanguage: string;
  targetLanguages: string[];
  sourceLanguage: string;
  sourceLanguageMode: SourceLanguageMode;
}

/**
 * A frame of translated speech on its way to a listener.
 *
 * `pcmBase64` is little-endian PCM16 at 16 kHz mono: the engine's own format,
 * not a vendor container. Nothing here identifies which synthesiser produced
 * it, so changing synthesiser stays a configuration change rather than a
 * client release.
 */
export interface TranslatedAudioFramePayload {
  broadcastId: string;
  /** Bumps on a source switch; a Viewer rejects frames from an older one. */
  sourceRevision: number;
  /** Which language this stream is. Several share a segmentId. */
  targetLanguage: string;
  segmentId: string;
  /** Which synthesis attempt. Higher supersedes lower; platform-owned. */
  generation: number;
  /** Order within (segmentId, generation). Starts at 0 and never repeats. */
  sequence: number;
  segmentStartMs: number;
  /** The last frame of this generation. Nothing further may follow it. */
  final: boolean;
  sampleRate: 16000;
  channelCount: 1;
  pcmBase64: string;
}
