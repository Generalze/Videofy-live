/** @owner masterzee001 */
/**
 * The NARROW facade contract between connect-control and the gateway (R1).
 *
 * connect-control never touches the call-session store or the call runtime
 * directly: the gateway hands it exactly these operations and nothing else.
 * Everything here is expressed structurally so this package depends on no
 * gateway or store types — the gateway's implementation satisfies the shape.
 *
 * The mode-change and end operations are deliberately ASYNC and deliberately
 * routed through the runtime (never the store): the runtime is what emits the
 * STATE broadcast and applies/retires ingest plans, and a mode change that
 * skipped it would leave every participant's captions running against a mode
 * the call no longer has.
 */
import type { CallMode, CallType } from '@videofy-live/connect-contracts';

export interface ConnectFacadeParticipant {
  readonly participantId: string;
  /** Present on every seat that joined through Connect; opaque (R8). */
  readonly subject?: string;
  readonly displayName: string;
  readonly speakLanguage: string;
  readonly hearLanguage: string;
  readonly connected: boolean;
}

export interface ConnectFacadeSnapshot {
  readonly callType: CallType;
  readonly callMode: CallMode;
  readonly participants: readonly ConnectFacadeParticipant[];
}

export type ConnectFacadePreregisterResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid-call-id'
        | 'invalid-call-type'
        | 'invalid-call-mode'
        | 'call-already-exists';
    };

export type ConnectFacadeModeChangeResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'unknown-call' | 'invalid-mode' };

export type ConnectFacadeEndResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unknown-call' };

/** Exactly what the /v1 router needs from the gateway, and nothing more. */
export interface ConnectCallFacade {
  preregisterCall(
    internalCallId: string,
    input: { callType: CallType; callMode: CallMode; projectTag: string },
  ): ConnectFacadePreregisterResult;
  /** Null when the store no longer knows the call (ended, or died with its last seat). */
  snapshot(internalCallId: string): ConnectFacadeSnapshot | null;
  /** Runtime path: store change + STATE emit + ingest plan apply/retire. */
  applyAuthorityModeChange(
    internalCallId: string,
    mode: CallMode,
  ): Promise<ConnectFacadeModeChangeResult>;
  /** Runtime path: final STATE emit + full ingest/transport teardown. */
  endCallByAuthority(internalCallId: string): Promise<ConnectFacadeEndResult>;
}
