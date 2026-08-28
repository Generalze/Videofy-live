/** @author masterzee001 */
/**
 * Reaching a phone that nobody is looking at.
 *
 * ONE CONTRACT, SEVERAL PROVIDERS. Android goes through FCM, iOS through APNs,
 * and a web install through neither. Nothing above this file should know that:
 * a caller asks for an account to be notified and this decides how. The
 * alternative -- provider names appearing in call code and message code -- is
 * how a second platform becomes a rewrite.
 *
 * A FAILED SEND IS NOT A FAILED DELIVERY, AND NEITHER IS A SUCCESSFUL ONE. The
 * provider accepting a payload means it will try; the phone may be off, the
 * user may have revoked permission, the notification may be silently dropped.
 * Nothing here pretends otherwise, and no caller should treat a resolved
 * promise as "the person was told".
 *
 * PERMANENT FAILURES MUST PRUNE THE TOKEN. This is the operational rule that
 * keeps the registry honest. When an app is uninstalled the provider starts
 * answering "unregistered" for that token, forever. A dispatcher that ignores
 * that accumulates dead tokens, pays to send to them, and slowly turns its own
 * delivery statistics into noise. So a permanent failure removes the device,
 * and a transient one does not.
 */

export type PushKind = 'call' | 'message' | 'system';

/**
 * How much of this may appear on a locked screen.
 *
 * `discreet` carries NO human-readable text -- only a data payload the app
 * reads after it is unlocked, so it can fetch and display the real content
 * itself. Message previews are the case this exists for: a translated message
 * on a lock screen is readable by whoever is holding the phone, which is not
 * always the person it was sent to.
 */
export type PushPrivacy = 'visible' | 'discreet';

/**
 * `high` is for something a person is waiting on RIGHT NOW -- a ringing call.
 *
 * Both platforms ration it, and a service that marks everything high loses the
 * privilege for the one thing that needed it. Rings are high; everything else
 * is normal.
 */
export type PushUrgency = 'high' | 'normal';

export interface PushNotification {
  readonly kind: PushKind;
  readonly privacy: PushPrivacy;
  readonly urgency: PushUrgency;
  /** Omitted entirely when `discreet`. */
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  /**
   * The payload the app acts on. Strings only, because both providers flatten
   * to strings and discovering that per-field is a class of bug nobody enjoys.
   */
  readonly data: Readonly<Record<string, string>>;
  /**
   * Collapse key: a newer notification replaces an older one with the same id.
   *
   * A phone that was off for ten minutes should not ring ten times for one
   * missed call.
   */
  readonly collapseId?: string | undefined;
  /**
   * How long the provider may hold this for an unreachable device.
   *
   * A CALL is worthless after its ringing window (founder ruling
   * 2026-08-28): a push delivered five minutes late must not suddenly ring a
   * phone for a call that is already NO ANSWER. FCM's default lifetime is
   * weeks; a call sets ~30s. Messages leave it unset.
   */
  readonly ttlSeconds?: number | undefined;
}

export interface PushTarget {
  readonly deviceId: string;
  readonly platform: 'ios' | 'android' | 'web';
  /** A credential. Never logged, never echoed. */
  readonly pushToken: string;
}

export type PushSendResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * Whether this token will NEVER work again.
       *
       * The distinction is the whole reason this field exists. `true` means the
       * app is gone and the device row should be deleted; `false` means try
       * again later. Guessing wrong in one direction keeps dead tokens forever,
       * and in the other direction unregisters a phone over a network blip.
       */
      readonly permanent: boolean;
      readonly reason: string;
    };

export interface PushProvider {
  readonly name: string;
  /** Which platforms this provider can reach. */
  readonly platforms: readonly PushTarget['platform'][];
  send(target: PushTarget, notification: PushNotification): Promise<PushSendResult>;
}

/**
 * Strip anything a locked screen should not show.
 *
 * Applied centrally rather than trusted to each provider, so a new provider
 * cannot leak a preview by forgetting. A discreet notification keeps its data
 * payload and loses its words.
 */
export function redactForPrivacy(notification: PushNotification): PushNotification {
  if (notification.privacy === 'visible') return notification;
  const { title: _title, body: _body, ...rest } = notification;
  return rest;
}
