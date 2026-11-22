/** @author masterzee001 */
/**
 * The native incoming-call layer, from JS.
 *
 * LOADED OPTIONALLY. A dev client or an older APK without the module must
 * not crash at import; every call becomes a no-op and `available` says so,
 * so the app can fall back to the notification path it had before.
 *
 * The contract mirrors modules/videofy-call/android/.../VideofyCallModule.kt.
 * Credentials cross here exactly once per sign-in and are cleared with the
 * session; nothing about them is logged.
 */
import { requireOptionalNativeModule } from 'expo';

/** What a listener registration hands back; enough to remove it. */
export interface EventSubscription {
  remove(): void;
}

export interface NativeCallDescriptor {
  readonly callId: string;
  readonly callerAccountId: string;
  readonly callerName: string;
  readonly mode: 'normal' | 'translated';
}

export interface NativeCallTimeline {
  readonly [point: string]: number;
}

interface NativeModuleShape {
  setRingCredential(gatewayUrl: string, token: string, accountId: string, expiresAtMs: number): void;
  clearRingCredential(): void;
  consumePendingAction(accountId: string): (Record<string, unknown> & { action?: string }) | null;
  reportAnswered(callId: string): void;
  reportCallEnded(callId: string): void;
  reportMediaConnected(callId: string): void;
  reportOutgoingCall(callId: string, peerName: string): boolean;
  setAudioRoute(callId: string, speaker: boolean): boolean;
  timeline(callId: string): Record<string, unknown>;
  pendingTimelines(): string;
  forgetTimeline(callId: string): void;
  canUseFullScreenIntent(): boolean;
  batteryExemption(): string;
  requestBatteryExemption(): boolean;
  standbyBucket(): number;
  addListener(event: string, listener: (payload: Record<string, unknown>) => void): EventSubscription;
}

/**
 * Whether Android has this app exempt from battery optimisation, AS READ.
 *
 * Five answers, and the two that are not readings are distinct on purpose:
 *   `not-applicable`  Android 5 and older, which has no such setting. The
 *                     ONLY answer that means there is nothing to allow.
 *   `unreadable`      the platform has the setting and the native read
 *                     could not be performed (no PowerManager, or the read
 *                     threw). Not a clean bill of health; the request is
 *                     still worth making. The first version of this bridge
 *                     let the native layer fold this into `not-applicable`,
 *                     so a failed read told the person their phone was fine.
 *   `unknown`         this build has no native layer to ask with at all.
 * A screen that showed "granted" for any of the last three would be stating
 * something nobody measured.
 */
export type BatteryExemption = 'granted' | 'not-granted' | 'not-applicable' | 'unreadable' | 'unknown';

const BATTERY_EXEMPTION_WORDS: readonly BatteryExemption[] = ['granted', 'not-granted', 'not-applicable', 'unreadable'];

const native = requireOptionalNativeModule<NativeModuleShape>('VideofyCall');

function descriptor(payload: Record<string, unknown>): NativeCallDescriptor | null {
  const callId = payload['callId'];
  if (typeof callId !== 'string' || callId.length === 0) return null;
  return {
    callId,
    callerAccountId: typeof payload['callerAccountId'] === 'string' ? (payload['callerAccountId'] as string) : '',
    callerName: typeof payload['callerName'] === 'string' ? (payload['callerName'] as string) : 'Caller',
    mode: payload['mode'] === 'translated' ? 'translated' : 'normal',
  };
}

export const videofyCall = {
  /** True when this build carries the native layer. */
  available: native !== null,

  /** Bound to the account and the session's expiry: the receiver rings for nobody else, and for nobody past it. */
  setRingCredential(gatewayUrl: string, token: string, accountId: string, expiresAtMs: number): void {
    native?.setRingCredential(gatewayUrl, token, accountId, expiresAtMs);
  },
  /** Credential, parked actions, ring notification and service -- all of it. */
  clearRingCredential(): void {
    native?.clearRingCredential();
  },
  /** An Answer tapped while the app was cold, for THIS account and fresh; read once. */
  consumePendingAnswer(accountId: string): NativeCallDescriptor | null {
    const pending = native?.consumePendingAction(accountId) ?? null;
    if (pending === null || pending.action !== 'answer') return null;
    return descriptor(pending);
  },
  /** Answered on the app's own screen: stop the ring, keep the Telecom call. */
  reportAnswered(callId: string): void {
    native?.reportAnswered(callId);
  },
  reportCallEnded(callId: string): void {
    native?.reportCallEnded(callId);
  },
  reportMediaConnected(callId: string): void {
    native?.reportMediaConnected(callId);
  },
  /** The caller's side of Telecom phase 2. True when Telecom owns the call. */
  reportOutgoingCall(callId: string, peerName: string): boolean {
    return native?.reportOutgoingCall(callId, peerName) ?? false;
  },
  /** Speaker / earpiece through Telecom's Connection. False = not owned; use the app's own route. */
  setAudioRoute(callId: string, speaker: boolean): boolean {
    return native?.setAudioRoute(callId, speaker) ?? false;
  },
  timeline(callId: string): NativeCallTimeline {
    const raw = native?.timeline(callId) ?? {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) if (typeof value === 'number') out[key] = value;
    return out;
  },
  /*
   * A PUSH THAT ARRIVED AND RANG NOBODY (27 Sep 2026 review). `timeline()`
   * above is read by the call screen's teardown, so a push that arrived and
   * never rang -- the exact failure being diagnosed -- reported nothing,
   * because no call screen ever mounted. These two let the app report every
   * timeline still on the device at its next opportunity, and forget each
   * one only once the gateway has said it has it (push/unreportedTimelines).
   */
  /** Every call with stamps still on the device, by call id; numbers only, nothing forgotten. */
  pendingTimelines(): Record<string, NativeCallTimeline> {
    const raw = native?.pendingTimelines();
    if (typeof raw !== 'string' || raw.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, NativeCallTimeline> = {};
    for (const [callId, stamps] of Object.entries(parsed as Record<string, unknown>)) {
      if (stamps === null || typeof stamps !== 'object') continue;
      const numeric: Record<string, number> = {};
      for (const [key, value] of Object.entries(stamps as Record<string, unknown>)) if (typeof value === 'number') numeric[key] = value;
      out[callId] = numeric;
    }
    return out;
  },
  /** After the gateway confirmed it has this call's stamps. */
  forgetTimeline(callId: string): void {
    native?.forgetTimeline(callId);
  },
  canUseFullScreenIntent(): boolean {
    return native?.canUseFullScreenIntent() ?? false;
  },
  /*
   * THE RIGHT TO WAKE (27 Sep 2026). Three calls whose push Google accepted
   * and the handset never woke for. The exemption is READ from the platform
   * every time it is asked for -- after the request, on every foreground --
   * and never remembered as granted because the dialog was shown.
   */
  batteryExemption(): BatteryExemption {
    const read = native?.batteryExemption();
    return BATTERY_EXEMPTION_WORDS.find((word) => word === read) ?? 'unknown';
  },
  /** Opens Android's own allow dialog. True means the dialog was launched, and nothing about the answer. */
  requestBatteryExemption(): boolean {
    return native?.requestBatteryExemption() ?? false;
  },
  /** The raw UsageStatsManager bucket code; null where the build or the platform has none. */
  standbyBucket(): number | null {
    const code = native?.standbyBucket();
    return typeof code === 'number' && code >= 0 ? code : null;
  },
  onIncoming(listener: (call: NativeCallDescriptor) => void): EventSubscription | null {
    return native?.addListener('incoming', (payload) => {
      const call = descriptor(payload);
      if (call !== null) listener(call);
    }) ?? null;
  },
  onAnswer(listener: (call: NativeCallDescriptor) => void): EventSubscription | null {
    return native?.addListener('answer', (payload) => {
      const call = descriptor(payload);
      if (call !== null) listener(call);
    }) ?? null;
  },
  onDecline(listener: (callId: string) => void): EventSubscription | null {
    return native?.addListener('decline', (payload) => {
      if (typeof payload['callId'] === 'string') listener(payload['callId'] as string);
    }) ?? null;
  },
  onTimeout(listener: (callId: string) => void): EventSubscription | null {
    return native?.addListener('timeout', (payload) => {
      if (typeof payload['callId'] === 'string') listener(payload['callId'] as string);
    }) ?? null;
  },
};
