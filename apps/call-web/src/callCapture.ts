// Microphone capture contract for the call app.
//
// apps/operator-web/src/broadcasterCapture.ts has stated its capture contract
// since P3 and reads the granted settings back. This app asked for
// `{ audio: true }` and inspected nothing — so when the 17 Aug 2026 acceptance
// failed, no call log could say what echo cancellation had actually been doing,
// and it had to be measured by hand afterwards from a live browser.
//
// The request is a preference. The SETTINGS ARE THE FACT, and the fact is what
// every later acoustic measurement has to be interpreted against.

/**
 * Chrome exposes more than a boolean here.
 *
 * `true` references this page's own render streams. `'all'` asks the canceller
 * to reference everything the machine plays, which is the only value that could
 * address audio arriving from a DIFFERENT browser context — the configuration
 * that actually failed. Support is not universal, so it is requested as `ideal`
 * and reported as whatever came back.
 */
export type EchoCancellationSetting = boolean | 'all' | 'remote-only';

export interface CallCaptureSettings {
  /**
   * Hardware name, e.g. "Microphone Array (Intel Smart Sound Technology)".
   *
   * The device LABEL is recorded and the device ID deliberately is not. The
   * label names a piece of hardware, which is what M1's rig question needs; the
   * id is a stable per-origin identifier that would correlate one person across
   * every call they ever join, which no acoustic measurement needs.
   */
  deviceLabel: string | null;
  channelCount: number | null;
  sampleRate: number | null;
  latencyMs: number | null;
  echoCancellation: EchoCancellationSetting | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  /** What this browser says it COULD do, so a `false` reading can be read as refusal vs absence. */
  echoCancellationCapabilities: EchoCancellationSetting[] | null;
}

/**
 * Which capture contract this call asked the browser for.
 *
 * W1 changed an independent experimental variable that overlaps the mechanism
 * W6 is meant to test: `'all'` asks the canceller to reference everything the
 * machine renders, which is part of what W6 exists to achieve by other means.
 * Without a control profile, every later result carries an unanswerable
 * footnote — did recapture improve because of topology, because Chrome granted
 * `'all'`, because W6 worked, or because `'all'` had already done part of W6's
 * job?
 *
 * - `browser-default` — `{ audio: true }`, byte-for-byte the request that
 *   produced the frozen evidence corpus. The CONTROL.
 * - `explicit-all` — W1's preferred modern request.
 *
 * Deliberately not called `legacy`: naming it after its age would turn a
 * temporary piece of history into architecture. It is a browser default, and
 * that is exactly what it says.
 */
export type CallCaptureProfile = 'browser-default' | 'explicit-all';

export const CALL_CAPTURE_PROFILES: readonly CallCaptureProfile[] = [
  'browser-default',
  'explicit-all',
];

/** W1's preferred request. `browser-default` is the control you opt into. */
export const DEFAULT_CALL_CAPTURE_PROFILE: CallCaptureProfile = 'explicit-all';

const CAPTURE_QUERY_PARAM = 'capture';

/**
 * The profile named by `?capture=`, or null.
 *
 * A query parameter rather than a build flag because a corpus operator needs to
 * choose per call, at the moment of joining, without a rebuild between runs —
 * and because the choice is then visible in the URL that produced the recording.
 */
export function captureProfileFromLocation(search: string): CallCaptureProfile | null {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (!query) return null;
  const value = new URLSearchParams(query).get(CAPTURE_QUERY_PARAM)?.trim();
  return CALL_CAPTURE_PROFILES.includes(value as CallCaptureProfile)
    ? (value as CallCaptureProfile)
    : null;
}

/**
 * The constraints for a profile.
 *
 * Two COMPLETE contracts, not one contract with the echo-cancellation value
 * swapped. Keeping the explicit noiseSuppression/autoGainControl/channelCount
 * while changing only the AEC value would not reproduce the original capture
 * request, and the control would be measuring something nobody ever shipped.
 *
 * `ideal`, never `exact`: `exact: 'all'` rejects with OverconstrainedError on
 * any browser without the string form, and the participant then cannot join at
 * all. A capture preference is not worth a join failure.
 */
export function createCallAudioConstraints(
  profile: CallCaptureProfile = DEFAULT_CALL_CAPTURE_PROFILE,
  deviceId?: string,
): MediaStreamConstraints {
  if (profile === 'browser-default') {
    // Exactly what gentle-atlas-54 and swift-ember-69 were captured under. If a
    // device is named, that is the ONLY addition — anything more and this stops
    // being the historical contract.
    return { audio: deviceId ? { deviceId: { ideal: deviceId } } : true, video: false };
  }
  // `echoCancellation: { ideal: 'all' }` is outside lib.dom's ConstrainBoolean.
  // The cast is the honest way to say "this is a real Chrome constraint the DOM
  // typings do not model yet" rather than silently downgrading to a boolean.
  const audio = {
    channelCount: { ideal: 1 },
    echoCancellation: { ideal: 'all' },
    noiseSuppression: true,
    autoGainControl: true,
  } as unknown as MediaTrackConstraints;
  if (deviceId) {
    (audio as { deviceId?: unknown }).deviceId = { ideal: deviceId };
  }
  return { audio, video: false };
}

/** Read back what the browser actually granted. Never throws: this is instrumentation. */
export function readCallCaptureSettings(track: MediaStreamTrack | null): CallCaptureSettings | null {
  if (!track) return null;
  let settings: MediaTrackSettings = {};
  try {
    settings = track.getSettings?.() ?? {};
  } catch {
    settings = {};
  }
  const raw = settings as MediaTrackSettings & {
    echoCancellation?: EchoCancellationSetting;
    latency?: number;
  };
  return {
    deviceLabel: track.label || null,
    channelCount: numberOrNull(raw.channelCount),
    sampleRate: numberOrNull(raw.sampleRate),
    // Reported in seconds by the spec; ms is the unit every other timing value
    // in this system uses, and mixed units are how comparisons go wrong.
    latencyMs: typeof raw.latency === 'number' ? Math.round(raw.latency * 1000) : null,
    echoCancellation: raw.echoCancellation ?? null,
    noiseSuppression: booleanOrNull(raw.noiseSuppression),
    autoGainControl: booleanOrNull(raw.autoGainControl),
    echoCancellationCapabilities: readEchoCancellationCapabilities(track),
  };
}

function readEchoCancellationCapabilities(track: MediaStreamTrack): EchoCancellationSetting[] | null {
  try {
    const capabilities = track.getCapabilities?.() as
      | { echoCancellation?: EchoCancellationSetting[] }
      | undefined;
    const values = capabilities?.echoCancellation;
    return Array.isArray(values) && values.length > 0 ? [...values] : null;
  } catch {
    // getCapabilities is absent on Firefox and throws on some Safari builds.
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
