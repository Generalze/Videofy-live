/** @author masterzee001 */
/**
 * WHAT TO DO WITH A CALL PUSH, decided where it can be tested.
 *
 * A push is only a wake-up. The device asks the gateway whether the call is
 * still live, and only a live call shows the incoming screen -- which is also
 * what the ringing acknowledgement reports, so the caller's "Ringing…" means a
 * phone is genuinely presenting the call.
 *
 * THE DISTINCTION THIS FILE EXISTS FOR: "I asked and the answer was no" is not
 * the same as "I could not ask yet". The API returns null for both, and the
 * routing treated them alike -- so a push arriving during a cold start, before
 * the session had been restored, was answered null, dropped, and recorded as
 * already handled. The incoming screen never appeared and the caller rang out
 * against a phone that had woken up and said nothing. On builds without the
 * native module that was every cold-start call.
 *
 * So an unanswerable question DEFERS, to be asked again once there is a
 * session, and only a real "no" from the server ignores the push for good.
 *
 * This is the FALLBACK path. The native Android layer remains the production
 * route; nothing here weakens it.
 */
import type { DirectCallCheck } from './directCallApi';

export interface IncomingCallPresentation {
  readonly callId: string;
  readonly caller: { readonly accountId: string; readonly name: string };
  readonly mode: 'normal' | 'translated';
}

export type PushRouting =
  /** Present the incoming call, then acknowledge that it is being shown. */
  | { readonly kind: 'show'; readonly presentation: IncomingCallPresentation }
  /** The server answered, and the answer was no. Never ask again. */
  | { readonly kind: 'ignore'; readonly reason: string }
  /** The question could not be asked. Ask again when it can be. */
  | { readonly kind: 'defer'; readonly reason: string };

export interface CallPushInput {
  readonly callId: string;
  /** From the push payload; used only when the server has nothing better. */
  readonly fromAccountId: string;
  readonly fromName: string;
  /** Whether a session exists to ask WITH. */
  readonly hasSession: boolean;
  readonly check: (callId: string) => Promise<DirectCallCheck | null>;
}

export async function routeCallPush(input: CallPushInput): Promise<PushRouting> {
  if (input.callId.trim() === '') {
    return { kind: 'ignore', reason: 'the push carried no call id' };
  }

  /*
   * NO SESSION YET. This is the cold-start case: the notification listener
   * runs at mount, before `auth.restore()` has resolved. Deferring keeps the
   * push alive to be re-driven the moment a session exists.
   */
  if (!input.hasSession) {
    return { kind: 'defer', reason: 'no session yet; the app is still starting' };
  }

  const check = await input.check(input.callId);

  /*
   * ASKED AND COULD NOT GET AN ANSWER -- offline, a blip, a 500. NOT a reason
   * to ring: only the server knows whether the call is live, and a device that
   * rings on silence is a device that rings for calls that ended minutes ago.
   * Deferring lets it be asked again rather than deciding on no information.
   */
  if (check === null) {
    return { kind: 'defer', reason: 'the gateway could not be reached' };
  }

  /*
   * A REAL NO. The call was declined, answered elsewhere, timed out or hung
   * up. This is the stale-push case and it must stay silent, permanently.
   */
  if (!check.ring) {
    return { kind: 'ignore', reason: `the call is ${check.state}` };
  }

  return {
    kind: 'show',
    presentation: {
      callId: input.callId,
      caller: {
        // The server's names win; the push payload is only a fallback for a
        // field the server left empty.
        accountId: check.callerAccountId || input.fromAccountId,
        name: check.callerName || input.fromName,
      },
      mode: check.mode,
    },
  };
}

/**
 * Should the incoming screen come down?
 *
 * Polled while the fallback ring screen is up, because without the native
 * module nothing else tells this device the call is over: a caller who hangs
 * up, or a decline from the person's other phone, leaves the screen ringing
 * until somebody touches it.
 *
 * A FAILED CHECK IS NOT A DISMISSAL. One unanswered poll on a moving train
 * must not cancel a call that is still ringing; only the server saying so
 * does.
 */
export function shouldDismissIncoming(check: DirectCallCheck | null): boolean {
  if (check === null) return false;
  return !check.ring;
}
