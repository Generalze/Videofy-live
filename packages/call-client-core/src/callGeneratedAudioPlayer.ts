// One loudspeaker path for every generated clip, unlocked once by a gesture.
//
// The previous implementation built `new Audio(url)` per clip. On desktop that
// is invisible; on Android Chrome each fresh element starts LOCKED, because
// autoplay permission is granted to an element that has played inside a user
// gesture — not to the page.
//
// NOTE (P6.3 pre-M1): that reasoning did NOT hold up on the device. A real
// Android Chrome run with this persistent element and the silent-WAV unlock
// behaved exactly as before, so the autoplay explanation is a hypothesis and
// not an established cause. The diagnostic hooks below exist to find out what
// is really happening; do not treat the paragraph above as settled.
//
// Feedback isolation is unchanged and still structural: this module creates
// playback objects only, and touches no getUserMedia stream and no published
// track.

import {
  classifyMediaError,
  classifyPlayRejection,
  type GeneratedAudioElementSnapshot,
  type GeneratedAudioEventName,
  type GeneratedAudioFailureReason,
} from './callGeneratedAudioDiagnostics';

/**
 * A rejected `play()`, carrying WHY.
 *
 * The queue has to tell an autoplay refusal apart from a clip that could not be
 * fetched or decoded, because the correct responses are opposites: one waits for
 * a gesture and keeps the clip, the other must drop the clip and keep going.
 * Conflating them is what made every Android clip stall behind an unplayable one
 * while the UI asked for a tap that could not have helped.
 */
export class GeneratedAudioPlaybackError extends Error {
  constructor(
    readonly reason: GeneratedAudioFailureReason,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'Generated audio playback failed.');
    this.name = 'GeneratedAudioPlaybackError';
  }
}

export interface CallGeneratedAudioPlayer {
  volume: number;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  /**
   * Point the persistent element at a clip and begin.
   *
   * Rejects when the browser refuses — which on mobile means the clip was never
   * audible, and W4 must not record an interval for it.
   */
  play(url: string): Promise<void>;
  pause(): void;
  /**
   * Called from inside a user gesture. Resolves true when the element may play
   * programmatically from now on.
   */
  unlock(): Promise<boolean>;
  dispose(): void;
}

/**
 * The subset of HTMLAudioElement this player drives.
 *
 * Named so the element can be supplied in a test: these suites run in node with
 * no DOM, and the stale-event guard below is the protection that moved here
 * when per-clip elements were replaced by one persistent element. Untestable
 * protection is not protection.
 */
export interface GeneratedAudioElementLike {
  volume: number;
  currentTime: number;
  preload: string;
  src: string;
  readonly currentSrc?: string;
  readonly paused: boolean;
  readonly ended?: boolean;
  readonly muted?: boolean;
  readonly readyState?: number;
  readonly networkState?: number;
  readonly duration?: number;
  readonly error?: { code: number; message?: string } | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  load(): void;
  play(): Promise<void>;
  pause(): void;
  /**
   * W8: present where the platform supports output routing. Without it the
   * element stays on the system default — honest, not a fault.
   */
  setSinkId?(sinkId: string): Promise<void>;
}

/** Diagnostics only. Never consulted by playback logic. */
export type GeneratedAudioDiagnosticSink = (
  event: GeneratedAudioEventName,
  detail: {
    snapshot: GeneratedAudioElementSnapshot;
    error?: unknown;
    reason?: GeneratedAudioFailureReason | null;
  },
) => void;

export interface CallGeneratedAudioPlayerOptions {
  createElement?: () => GeneratedAudioElementLike;
  /** Optional and side-effect-free: attaching it changes no playback behaviour. */
  onDiagnostic?: GeneratedAudioDiagnosticSink;
  /**
   * W8: the one persistent element registers here on creation and unregisters
   * on dispose, so generated translated playback follows the same selected
   * output as the remote originals, where the mechanism supports it.
   * Structural on purpose — only the registration half of
   * CallAudioOutputController is needed, and a test can hand in a recorder.
   */
  outputController?: {
    registerElement(element: GeneratedAudioElementLike): void;
    unregisterElement(element: GeneratedAudioElementLike): void;
  };
}

/** Element events worth seeing when a clip does not reach the speaker. */
const OBSERVED_EVENTS: { type: string; event: GeneratedAudioEventName }[] = [
  { type: 'loadstart', event: 'clip-load-start' },
  { type: 'canplay', event: 'canplay' },
  { type: 'playing', event: 'playing' },
  { type: 'stalled', event: 'stalled' },
  { type: 'waiting', event: 'waiting' },
  { type: 'abort', event: 'abort' },
];

/**
 * A short genuinely-silent WAV, built rather than pasted as a base64 blob so it
 * can be read and corrected.
 *
 * Zero-length data chunks are rejected by some browsers, so this carries real
 * (silent) samples. Playing it inside the gesture is what was intended to grant
 * the element its permission; nobody hears it.
 */
function silentWavDataUri(): string {
  const sampleRate = 8000;
  const sampleCount = 400; // 50 ms
  const dataBytes = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  // Samples are left at zero: that is the silence.

  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

export function createBrowserGeneratedAudioPlayer(
  options: CallGeneratedAudioPlayerOptions = {},
): CallGeneratedAudioPlayer {
  const element = (options.createElement ?? (() => new Audio() as GeneratedAudioElementLike))();
  const diagnostic = options.onDiagnostic;
  element.preload = 'auto';
  // iOS refuses inline playback without this and takes the clip fullscreen.
  element.setAttribute('playsinline', '');
  // W8: registered once for the element's whole lifetime, so a standing
  // output selection reaches it before the first clip plays.
  options.outputController?.registerElement(element);
  let unlocked = false;
  /** Null while no clip is loaded, so the unlock tone cannot fire clip callbacks. */
  let activeUrl: string | null = null;

  const snapshot = (): GeneratedAudioElementSnapshot => {
    const duration = element.duration;
    return {
      currentSrc: element.currentSrc ?? element.src ?? null,
      paused: element.paused ?? null,
      ended: element.ended ?? null,
      muted: element.muted ?? null,
      volume: typeof element.volume === 'number' ? element.volume : null,
      readyState: typeof element.readyState === 'number' ? element.readyState : null,
      networkState: typeof element.networkState === 'number' ? element.networkState : null,
      currentTime: typeof element.currentTime === 'number' ? element.currentTime : null,
      duration: typeof duration === 'number' && Number.isFinite(duration) ? duration : null,
      mediaErrorCode: element.error?.code ?? null,
      mediaErrorMessage: element.error?.message ?? null,
    };
  };

  const report = (
    event: GeneratedAudioEventName,
    detail: { error?: unknown; reason?: GeneratedAudioFailureReason | null } = {},
  ): void => {
    if (!diagnostic) return;
    try {
      diagnostic(event, { snapshot: snapshot(), ...detail });
    } catch {
      // Diagnostics must never be able to break playback.
    }
  };

  const player: CallGeneratedAudioPlayer = {
    get volume() {
      return element.volume;
    },
    set volume(next: number) {
      element.volume = next;
    },
    onended: null,
    onerror: null,
    async play(url: string): Promise<void> {
      activeUrl = url;
      element.src = url;
      element.load();
      report('play-called');
      try {
        await element.play();
      } catch (error) {
        const reason = classifyPlayRejection(error, snapshot());
        report('play-rejected', { error, reason });
        throw new GeneratedAudioPlaybackError(reason, error);
      }
      report('play-resolved');
    },
    pause(): void {
      activeUrl = null;
      element.pause();
    },
    /**
     * KNOWN SECONDARY DEFECT (P6.3 pre-M1, recorded not fixed).
     *
     * On a real device the FIRST unlock reports AbortError and a later one
     * succeeds. The cause is not this function's own ordering — it does await
     * `play()` before pausing. It is that the queue shares this ONE element and
     * does not wait for the unlock: `enqueue()` calls `playNext()`, which is
     * gated on `started`/`locked` but not on "an unlock is in flight", so a clip
     * arriving mid-unlock sets `element.src` and interrupts the pending
     * `play()` — which is exactly what AbortError means here.
     *
     * Harmless today because the later unlock succeeds, and it is NOT the
     * generated-clip failure. Left alone deliberately: the clip failure is a
     * different defect and fixing two things at once is how the last diagnosis
     * went wrong.
     */
    async unlock(): Promise<boolean> {
      if (unlocked) return true;
      report('unlock-start');
      const restoreVolume = element.volume;
      try {
        activeUrl = null;
        element.src = silentWavDataUri();
        element.volume = 0;
        await element.play();
        element.pause();
        element.currentTime = 0;
        unlocked = true;
        element.volume = restoreVolume;
        report('unlock-success');
        return true;
      } catch (error) {
        element.volume = restoreVolume;
        report('unlock-failure', { error, reason: classifyPlayRejection(error, snapshot()) });
        return false;
      }
    },
    dispose(): void {
      options.outputController?.unregisterElement(element);
      activeUrl = null;
      element.pause();
      element.removeAttribute('src');
      element.load();
    },
  };

  for (const { type, event } of OBSERVED_EVENTS) {
    element.addEventListener(type, () => report(event));
  }
  element.addEventListener('ended', () => {
    report('ended');
    if (activeUrl === null) return;
    activeUrl = null;
    player.onended?.();
  });
  element.addEventListener('error', () => {
    // Recorded even when no clip is loaded: a media error during the unlock
    // tone would be exactly the sort of thing the previous diagnosis missed.
    report('media-error', { reason: classifyMediaError(snapshot()) });
    if (activeUrl === null) return;
    activeUrl = null;
    player.onerror?.();
  });

  return player;
}
