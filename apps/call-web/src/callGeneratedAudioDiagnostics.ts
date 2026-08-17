// TEMPORARY DIAGNOSTIC INSTRUMENTATION — P6.3 pre-M1.
//
// The persistent-element + silent-WAV unlock did not change the behaviour on a
// real Android device, so the autoplay diagnosis is NOT established. This
// module exists to find out what is actually happening, on the phone, without
// remote DevTools.
//
// The UI currently conflates at least two failure classes behind one "Enable
// audio" button:
//
//   1. HTMLMediaElement.play() REJECTING          (a promise rejection)
//   2. HTMLMediaElement firing a media `error`    (a load/decode/network fault)
//
// Those have nothing to do with each other. One is a policy decision about
// gestures; the other means the clip never arrived or could not be decoded.
// Treating them as one symptom is why the first fix targeted the wrong cause.
//
// This module records only. It changes no playback policy, no retry behaviour
// and no state the queue acts on.

/** Every point in a clip's life we want to see, in the order they should occur. */
export type GeneratedAudioEventName =
  | 'unlock-start'
  | 'unlock-success'
  | 'unlock-failure'
  | 'clip-load-start'
  | 'play-called'
  | 'play-resolved'
  | 'play-rejected'
  | 'playing'
  | 'canplay'
  | 'stalled'
  | 'waiting'
  | 'abort'
  | 'media-error'
  | 'ended';

/**
 * What the UI would be entitled to say, if the UI said technical things.
 *
 * Kept separate from the user-facing wording on purpose: the participant needs
 * a way to recover, not a diagnosis. This is for the person holding the phone
 * during a corpus run.
 */
export type GeneratedAudioFailureReason =
  | 'autoplay-policy-blocked'
  | 'media-load-error'
  | 'decode-not-supported'
  | 'network-source-failure'
  | 'unknown-playback-failure';

/** Element state at the moment of an event. Read by the player, which owns it. */
export interface GeneratedAudioElementSnapshot {
  currentSrc: string | null;
  paused: boolean | null;
  ended: boolean | null;
  muted: boolean | null;
  volume: number | null;
  readyState: number | null;
  networkState: number | null;
  currentTime: number | null;
  duration: number | null;
  mediaErrorCode: number | null;
  mediaErrorMessage: string | null;
}

export interface GeneratedAudioDiagnosticEntry extends GeneratedAudioElementSnapshot {
  at: number;
  event: GeneratedAudioEventName;
  clipId: string | null;
  requestedUrl: string | null;
  /** Chrome-only; null where the browser does not implement it. */
  userActivationIsActive: boolean | null;
  userActivationHasBeenActive: boolean | null;
  errorName: string | null;
  errorMessage: string | null;
  /** Present only on failure events. */
  reason: GeneratedAudioFailureReason | null;
}

const MAX_ENTRIES = 300;

/**
 * Strip query and fragment from any URL before it is recorded or displayed.
 *
 * Today's generated-audio URLs carry no credential. The stripping is because a
 * diagnostic panel is a surface somebody will screenshot and paste into a chat,
 * and the day a signed URL appears is not the day anyone will remember to come
 * back and add this.
 */
export function redactUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : `${url.slice(0, cut)}?…`;
}

function readUserActivation(): { isActive: boolean | null; hasBeenActive: boolean | null } {
  const activation = (
    globalThis.navigator as Navigator & {
      userActivation?: { isActive?: boolean; hasBeenActive?: boolean };
    }
  )?.userActivation;
  return {
    isActive: typeof activation?.isActive === 'boolean' ? activation.isActive : null,
    hasBeenActive: typeof activation?.hasBeenActive === 'boolean' ? activation.hasBeenActive : null,
  };
}

function errorNameOf(error: unknown): string | null {
  if (error instanceof Error) return error.name;
  if (typeof error === 'string') return 'Error';
  return null;
}

function errorMessageOf(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return null;
}

/**
 * MediaError codes, mapped to the classes the report has to distinguish.
 *
 * 1 ABORTED, 2 NETWORK, 3 DECODE, 4 SRC_NOT_SUPPORTED. Code 4 is `media-load-error`
 * rather than a decode class because in practice it is a 404, a wrong MIME type
 * or a CORS refusal — the clip never arrived, which is a different
 * investigation from a clip that arrived and could not be decoded.
 */
function reasonFromMediaError(code: number | null): GeneratedAudioFailureReason {
  switch (code) {
    case 2:
      return 'network-source-failure';
    case 3:
      return 'decode-not-supported';
    case 4:
      return 'media-load-error';
    default:
      return 'unknown-playback-failure';
  }
}

/**
 * Why a `play()` promise rejected.
 *
 * `NotAllowedError` is THE autoplay-policy signal, and it is the one the
 * previous diagnosis assumed without evidence. If the phone reports anything
 * else here, that assumption was wrong and the fix aimed at the wrong thing.
 */
export function classifyPlayRejection(
  error: unknown,
  snapshot: GeneratedAudioElementSnapshot,
): GeneratedAudioFailureReason {
  const name = errorNameOf(error);
  if (name === 'NotAllowedError') return 'autoplay-policy-blocked';
  if (name === 'NotSupportedError') return 'media-load-error';
  // A media error already latched on the element explains the rejection better
  // than the rejection does.
  if (snapshot.mediaErrorCode !== null) return reasonFromMediaError(snapshot.mediaErrorCode);
  // AbortError from play() normally means a new load interrupted this one —
  // a sequencing problem in our own code, not a browser policy.
  return 'unknown-playback-failure';
}

export function classifyMediaError(snapshot: GeneratedAudioElementSnapshot): GeneratedAudioFailureReason {
  return reasonFromMediaError(snapshot.mediaErrorCode);
}

const EMPTY_SNAPSHOT: GeneratedAudioElementSnapshot = {
  currentSrc: null,
  paused: null,
  ended: null,
  muted: null,
  volume: null,
  readyState: null,
  networkState: null,
  currentTime: null,
  duration: null,
  mediaErrorCode: null,
  mediaErrorMessage: null,
};

export class GeneratedAudioDiagnostics {
  private readonly buffer: GeneratedAudioDiagnosticEntry[] = [];
  private clipId: string | null = null;
  private requestedUrl: string | null = null;
  private readonly onChange: (() => void) | undefined;
  private readonly nowMs: () => number;

  constructor(options: { onChange?: () => void; nowMs?: () => number } = {}) {
    this.onChange = options.onChange;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /** The clip subsequent element events belong to, until the next one begins. */
  beginClip(clipId: string, requestedUrl: string): void {
    this.clipId = clipId;
    this.requestedUrl = redactUrl(requestedUrl);
  }

  record(
    event: GeneratedAudioEventName,
    detail: {
      snapshot?: GeneratedAudioElementSnapshot;
      error?: unknown;
      reason?: GeneratedAudioFailureReason | null;
    } = {},
  ): void {
    const snapshot = detail.snapshot ?? EMPTY_SNAPSHOT;
    const activation = readUserActivation();
    this.buffer.push({
      at: this.nowMs(),
      event,
      clipId: this.clipId,
      requestedUrl: this.requestedUrl,
      ...snapshot,
      currentSrc: redactUrl(snapshot.currentSrc),
      userActivationIsActive: activation.isActive,
      userActivationHasBeenActive: activation.hasBeenActive,
      errorName: errorNameOf(detail.error),
      errorMessage: errorMessageOf(detail.error),
      reason: detail.reason ?? null,
    });
    while (this.buffer.length > MAX_ENTRIES) this.buffer.shift();
    this.onChange?.();
  }

  entries(): readonly GeneratedAudioDiagnosticEntry[] {
    return this.buffer;
  }

  /** The newest entry that carries a failure classification, or null. */
  latestFailure(): GeneratedAudioDiagnosticEntry | null {
    for (let index = this.buffer.length - 1; index >= 0; index -= 1) {
      const entry = this.buffer[index];
      if (entry?.reason) return entry;
    }
    return null;
  }

  clear(): void {
    this.buffer.splice(0);
    this.onChange?.();
  }
}

const DIAGNOSTICS_QUERY_PARAM = 'diag';

/**
 * `?diag=audio` turns the on-screen panel on.
 *
 * A query parameter because the failure is on a phone, and the phone is where
 * it has to be readable. Requiring Android remote DevTools would mean every
 * corpus run needs a cable and a second machine.
 */
export function generatedAudioDiagnosticsEnabled(search: string): boolean {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (!query) return false;
  return new URLSearchParams(query).get(DIAGNOSTICS_QUERY_PARAM) === 'audio';
}

/**
 * One line per entry, in the order they happened. Safe to screenshot or paste.
 *
 * The URLs are printed whenever they change, not folded away. The first version
 * of this omitted them, and the copied output could therefore show a clip
 * failing to load without saying WHAT it had tried to load — which is the one
 * fact that turns "the format is wrong" into "the host is wrong".
 */
export function formatDiagnostics(entries: readonly GeneratedAudioDiagnosticEntry[]): string {
  if (entries.length === 0) return 'no generated-audio events recorded yet';
  const first = entries[0]?.at ?? 0;
  const lines: string[] = [];
  let lastClipId: string | null | undefined;
  let lastRequested: string | null | undefined;
  let lastCurrentSrc: string | null | undefined;
  for (const entry of entries) {
    if (entry.clipId !== lastClipId || entry.requestedUrl !== lastRequested) {
      lastClipId = entry.clipId;
      lastRequested = entry.requestedUrl;
      lines.push(`clip ${entry.clipId ?? '(none)'}`);
      lines.push(`  requested   ${entry.requestedUrl ?? '(none)'}`);
      lastCurrentSrc = undefined;
    }
    if (entry.currentSrc !== lastCurrentSrc) {
      lastCurrentSrc = entry.currentSrc;
      lines.push(`  currentSrc  ${entry.currentSrc ?? '(none)'}`);
    }
    lines.push(formatEntry(entry, first));
  }
  return lines.join('\n');
}

function formatEntry(entry: GeneratedAudioDiagnosticEntry, first: number): string {
  const parts = [`+${String(entry.at - first).padStart(6)}ms`, entry.event.padEnd(15)];
  if (entry.reason) parts.push(`reason=${entry.reason}`);
  if (entry.errorName) parts.push(`${entry.errorName}: ${entry.errorMessage ?? ''}`);
  if (entry.mediaErrorCode !== null) {
    parts.push(`mediaError=${entry.mediaErrorCode} ${entry.mediaErrorMessage ?? ''}`);
  }
  parts.push(
    `ready=${entry.readyState ?? '-'} net=${entry.networkState ?? '-'} paused=${entry.paused ?? '-'}`,
  );
  parts.push(
    `act=${entry.userActivationIsActive ?? '-'}/${entry.userActivationHasBeenActive ?? '-'}`,
  );
  return parts.join('  ');
}
