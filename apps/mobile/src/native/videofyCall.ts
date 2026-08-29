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
  reportCallEnded(callId: string): void;
  reportMediaConnected(callId: string): void;
  timeline(callId: string): Record<string, unknown>;
  canUseFullScreenIntent(): boolean;
  addListener(event: string, listener: (payload: Record<string, unknown>) => void): EventSubscription;
}

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
  reportCallEnded(callId: string): void {
    native?.reportCallEnded(callId);
  },
  reportMediaConnected(callId: string): void {
    native?.reportMediaConnected(callId);
  },
  timeline(callId: string): NativeCallTimeline {
    const raw = native?.timeline(callId) ?? {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) if (typeof value === 'number') out[key] = value;
    return out;
  },
  canUseFullScreenIntent(): boolean {
    return native?.canUseFullScreenIntent() ?? false;
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
