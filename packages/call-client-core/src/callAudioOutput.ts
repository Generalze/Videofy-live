// P6.4-W8 — audio output routing, scoped to what the platform actually gives.
//
// Selection exists ONLY where the browser exposes both halves of the
// mechanism: HTMLMediaElement.setSinkId to point an element at a device, and
// mediaDevices.enumerateDevices to know which devices exist. Anything less is
// 'system-only', and there is deliberately no selection API for that case — a
// picker over routes the platform cannot switch would be a fake control.
//
// HONEST LIMIT: earpiece-vs-speaker routing on phones is generally NOT
// exposed to the web platform; that toggle belongs to the OS call-audio
// stack. The enumerated 'audiooutput' devices are what exists here, and on
// most mobile browsers that list is a single default entry or nothing.
//
// PRIVACY: a deviceId is used in exactly one place — passed to setSinkId on a
// local element. It never appears in any diagnostic, log, or emitted payload,
// and this module exposes no API that would put one there: the error callback
// carries a caller-provided generic route label and the error NAME only,
// never the message, which a browser may build from the requested id.
//
// Routing is local output selection only. Nothing here renegotiates, emits,
// or touches a peer connection.

/** The subset of MediaDeviceInfo this module reads, injectable for tests. */
export interface MediaDeviceInfoLike {
  kind: string;
  deviceId: string;
  label: string;
}

/**
 * The two platform surfaces capability rests on. Injectable because the test
 * suites run in node with no DOM, and because detection must be assertable
 * for every presence/absence combination.
 */
export interface AudioOutputPlatformDeps {
  /** HTMLMediaElement.prototype in a browser; undefined where absent. */
  mediaElementPrototype?: { setSinkId?: unknown } | null | undefined;
  /** navigator.mediaDevices in a browser; undefined where absent. */
  mediaDevices?:
    | { enumerateDevices?: () => Promise<readonly MediaDeviceInfoLike[]> }
    | null
    | undefined;
}

export type CallAudioOutputCapabilityKind = 'selectable' | 'system-only';

export interface CallAudioOutputCapability {
  kind: CallAudioOutputCapabilityKind;
}

/** What a picker may show: id for local routing, label for the human. */
export interface CallAudioOutputDevice {
  deviceId: string;
  label: string;
}

function browserPlatformDeps(): AudioOutputPlatformDeps {
  return {
    mediaElementPrototype:
      typeof HTMLMediaElement === 'undefined'
        ? undefined
        : (HTMLMediaElement.prototype as { setSinkId?: unknown }),
    mediaDevices: typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  };
}

/**
 * 'selectable' requires BOTH surfaces: an element method to apply a route and
 * an enumeration to offer one. Either alone is 'system-only' — offering a
 * device that cannot be applied, or an "apply" with nothing to list, would
 * both be pretend selection.
 */
export function detectAudioOutputCapability(
  deps: AudioOutputPlatformDeps = browserPlatformDeps(),
): CallAudioOutputCapability {
  const selectable =
    typeof deps.mediaElementPrototype?.setSinkId === 'function' &&
    typeof deps.mediaDevices?.enumerateDevices === 'function';
  return { kind: selectable ? 'selectable' : 'system-only' };
}

/**
 * The platform's own 'audiooutput' list, nothing invented. Labels may be
 * empty before a media permission is granted — surfaced as-is, the UI labels
 * generically. Only deviceId and label survive the mapping, so nothing else
 * a MediaDeviceInfo carries can leak through this module.
 */
export async function listAudioOutputs(
  deps: AudioOutputPlatformDeps = browserPlatformDeps(),
): Promise<CallAudioOutputDevice[]> {
  const mediaDevices = deps.mediaDevices;
  const enumerate = mediaDevices?.enumerateDevices;
  if (!mediaDevices || typeof enumerate !== 'function') return [];
  const devices = await enumerate.call(mediaDevices);
  return devices
    .filter((device) => device.kind === 'audiooutput')
    .map(({ deviceId, label }) => ({ deviceId, label }));
}

/**
 * The one element capability routing needs. Optional because elements exist
 * on platforms without setSinkId; such an element simply stays on the system
 * default.
 */
export interface AudioOutputElementLike {
  setSinkId?(sinkId: string): Promise<void>;
}

export interface CallAudioOutputControllerOptions {
  /**
   * Per-element application failure. Carries the caller's generic route label
   * and the error NAME only — never the deviceId, never the error message.
   */
  onError?: (routeLabel: string, errorName: string | null) => void;
}

const SYSTEM_DEFAULT_ROUTE_LABEL = 'system-default';
const SELECTED_ROUTE_LABEL = 'selected-output';

/**
 * Applies one local output selection to every tracked media element.
 *
 * Elements register on creation and unregister on teardown; the current sink
 * follows them in both directions — a selection made before an element exists
 * reaches it the moment it registers. null means system default, spelled
 * setSinkId('') at the platform.
 */
export class CallAudioOutputController {
  private sinkId: string | null = null;
  private routeLabel = SYSTEM_DEFAULT_ROUTE_LABEL;
  private readonly elements = new Set<AudioOutputElementLike>();
  private readonly onError: ((routeLabel: string, errorName: string | null) => void) | undefined;

  constructor(options: CallAudioOutputControllerOptions = {}) {
    this.onError = options.onError;
  }

  /** Local selection state for the picker UI. Never a diagnostic. */
  currentSinkId(): string | null {
    return this.sinkId;
  }

  registerElement(element: AudioOutputElementLike): void {
    this.elements.add(element);
    // A fresh element already plays on the system default; only a standing
    // non-default selection needs applying.
    if (this.sinkId !== null) void this.apply(element);
  }

  unregisterElement(element: AudioOutputElementLike): void {
    this.elements.delete(element);
  }

  /**
   * Select the output for every tracked element, present and future.
   * Resolves after every element settled; per-element failure is tolerated
   * and reported, so one refusing device cannot strand the rest.
   */
  async setOutput(sinkId: string | null, routeLabel?: string): Promise<void> {
    this.sinkId = sinkId;
    this.routeLabel =
      routeLabel ?? (sinkId === null ? SYSTEM_DEFAULT_ROUTE_LABEL : SELECTED_ROUTE_LABEL);
    await Promise.all([...this.elements].map((element) => this.apply(element)));
  }

  private async apply(element: AudioOutputElementLike): Promise<void> {
    // No mechanism on this element: it stays on the system default. Not an
    // error — pretending to route it would be the fake this module refuses.
    if (typeof element.setSinkId !== 'function') return;
    try {
      await element.setSinkId(this.sinkId ?? '');
    } catch (error) {
      this.onError?.(this.routeLabel, error instanceof Error ? error.name : null);
    }
  }
}
