/** @owner masterzee001 */
/**
 * The whole public surface of @videofy/connect.
 *
 * Everything an integrator can see lives here or in the Connect contract
 * types bundled into this package's emitted declarations. Wire vocabulary,
 * media plumbing and revision counters are deliberately unrepresentable on
 * these types.
 */
import type {
  AudioMode,
  AudioOutputCapability,
  CallMode,
  CallSnapshot,
  ConnectEventMap,
  ConnectEventName,
  LanguageTag,
} from '@videofy-live/connect-contracts';

/**
 * Optional host logger. Messages passed here are always free of tokens, ids
 * and credential material — the SDK never logs identifying values.
 */
export interface ConnectLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface VideofyClientConfig {
  /** The Videofy gateway origin, e.g. https://calls.example.com */
  baseUrl: string;
  logger?: ConnectLogger;
  /** STUN/TURN servers for call media. Omitted means none (direct only). */
  iceServers?: RTCIceServer[];
}

export interface JoinMediaOptions {
  /** Request the microphone during join. Default true. */
  microphone?: boolean;
  /** Turn the camera on right after joining. Default false. */
  camera?: boolean;
}

export interface JoinOptions {
  /** The single-use join token your server minted via the Connect API. */
  token: string;
  media?: JoinMediaOptions;
}

export interface AudioOutputDeviceInfo {
  deviceId: string;
  label: string;
}

export interface AudioOutputCapabilities {
  audioOutput: AudioOutputCapability;
  /** Empty when output routing is system-only. */
  outputs: AudioOutputDeviceInfo[];
}

/**
 * The one property attachVideo drives. HTMLVideoElement satisfies it; node
 * tests hand in a plain object.
 */
export interface VideoElementSurface {
  srcObject: unknown;
}

export interface VideofyCall {
  on<K extends ConnectEventName>(
    event: K,
    listener: (payload: ConnectEventMap[K]) => void,
  ): void;
  off<K extends ConnectEventName>(
    event: K,
    listener: (payload: ConnectEventMap[K]) => void,
  ): void;

  /** The current immutable snapshot. A fresh one accompanies every state event. */
  getSnapshot(): CallSnapshot;

  /**
   * Call from inside a user gesture (tap/click) after an audioBlocked event:
   * unlocks BOTH playback families — translated voices and the other
   * participants' original voices. They are separate media elements with
   * separate autoplay permissions, released by the one gesture.
   */
  enableAudio(): Promise<void>;

  /** Microphone on/off. Turning it on may prompt for permission. */
  setMicrophone(enabled: boolean): Promise<void>;
  /** Camera on/off. OFF releases the device — the light goes out. */
  setCamera(enabled: boolean): Promise<void>;

  /** How THIS listener hears cross-language speakers. Local ears only. */
  setAudioMode(mode: AudioMode): void;
  /** The language this participant hears and reads, applied mid-call. */
  setHearLanguage(language: LanguageTag): Promise<void>;
  /** Caption preference for this participant. */
  setCaptions(enabled: boolean): void;

  /** Route call audio to a specific output device; null = system default. */
  setAudioOutput(deviceId: string | null): Promise<void>;
  getAudioOutputCapabilities(): Promise<AudioOutputCapabilities>;

  /** Owner seat only: switch the whole call between normal and translated. */
  setCallMode(mode: CallMode): Promise<void>;

  /** The final transcript so far, as printable text. */
  getTranscript(): string;

  /** Render a participant's video into an element (their id, or your own). */
  attachVideo(participantId: string, element: VideoElementSurface): void;
  detachVideo(participantId: string): void;

  /** Leave the call and surrender the seat. Clears stored resume credentials. */
  leave(): void;
  /** Release resources only: no leave signal, credentials stay. Idempotent. */
  dispose(): void;
}

export interface VideofyClient {
  /** Join the call a token admits you to. Resolves once the seat is taken. */
  join(options: JoinOptions): Promise<VideofyCall>;
}
