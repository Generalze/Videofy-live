/** @author masterzee001 */
/**
 * Notifying an account, across every phone it has.
 *
 * FAN-OUT IS THE POINT. A person may have a phone, a tablet and an old handset
 * they still sign into. A call should ring all of them, and the first to answer
 * wins -- so a caller names an ACCOUNT and this finds the devices.
 *
 * PARTIAL FAILURE IS THE NORMAL CASE, not an error. One phone is off, another
 * has been wiped, a third answers instantly. A dispatcher that threw on the
 * first failure would refuse to ring the phone that was going to be answered,
 * so every device is attempted and the outcome is reported as a summary.
 *
 * NO PROVIDER CONFIGURED IS LOUD, NOT SILENT. A deployment with no push
 * provider cannot ring anybody, and the failure mode is that calls simply never
 * arrive while every service reports itself healthy -- the exact shape of defect
 * that has cost this project the most time. It is reported on every attempt
 * rather than swallowed.
 */
import type { DeviceStore } from '../device-store.js';
import {
  redactForPrivacy,
  type PushNotification,
  type PushProvider,
  type PushSendResult,
  type PushTarget,
} from './push-provider.js';

export interface PushDispatchSummary {
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  /** Devices removed because their token will never work again. */
  readonly pruned: readonly string[];
  /** Platforms with a device but no provider able to reach them. */
  readonly unreachablePlatforms: readonly string[];
}

export interface PushDispatcherOptions {
  readonly devices: DeviceStore;
  readonly providers: readonly PushProvider[];
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

export class PushDispatcher {
  private readonly devices: DeviceStore;
  private readonly providers: readonly PushProvider[];
  private readonly onEvent: PushDispatcherOptions['onEvent'];

  constructor(options: PushDispatcherOptions) {
    this.devices = options.devices;
    this.providers = options.providers;
    this.onEvent = options.onEvent;
  }

  /** Whether this deployment can reach anybody at all. */
  get configured(): boolean {
    return this.providers.length > 0;
  }

  private providerFor(platform: PushTarget['platform']): PushProvider | undefined {
    return this.providers.find((provider) => provider.platforms.includes(platform));
  }

  /**
   * Notify every device an account has.
   *
   * Never throws. A ring that failed to reach one phone must still reach the
   * others, and a caller in the middle of setting up a call has nothing useful
   * to do with an exception.
   */
  async notify(accountId: string, notification: PushNotification): Promise<PushDispatchSummary> {
    const targets = this.devices.pushTargetsFor(accountId);
    const payload = redactForPrivacy(notification);

    if (!this.configured) {
      /*
       * Said every time. A deployment that cannot push looks identical to one
       * where nobody happened to be called, and the only symptom is that phones
       * never ring.
       */
      this.onEvent?.('push.not-configured', {
        accountId,
        kind: notification.kind,
        devices: targets.length,
      });
      return {
        attempted: 0,
        delivered: 0,
        failed: 0,
        pruned: [],
        unreachablePlatforms: [...new Set(targets.map((target) => target.platform))],
      };
    }

    const pruned: string[] = [];
    const unreachable = new Set<string>();
    let delivered = 0;
    let failed = 0;

    /*
     * Concurrent, because ringing is time-critical and three sequential network
     * round trips would add seconds to a call that is being answered.
     */
    const outcomes = await Promise.all(
      targets.map(async (target): Promise<{ target: PushTarget; result: PushSendResult } | null> => {
        const provider = this.providerFor(target.platform);
        if (provider === undefined) {
          unreachable.add(target.platform);
          return null;
        }
        try {
          return { target, result: await provider.send(target, payload) };
        } catch (error) {
          /*
           * A provider that throws is treated as a TRANSIENT failure. An
           * exception is almost always the network or the SDK, and unregistering
           * a phone over a network blip is worse than retrying one that is gone.
           */
          return {
            target,
            result: {
              ok: false,
              permanent: false,
              reason: error instanceof Error ? error.message : 'unknown',
            },
          };
        }
      }),
    );

    for (const outcome of outcomes) {
      if (outcome === null) continue;
      if (outcome.result.ok) {
        delivered += 1;
        continue;
      }
      failed += 1;
      if (outcome.result.permanent) {
        // The app is gone. Keeping the row would mean paying to send to it
        // forever and counting the failure against delivery statistics.
        await this.devices.revoke(accountId, outcome.target.deviceId);
        pruned.push(outcome.target.deviceId);
      }
    }

    const summary: PushDispatchSummary = {
      attempted: targets.length,
      delivered,
      failed,
      pruned,
      unreachablePlatforms: [...unreachable],
    };

    /*
     * Logged with counts and ids, never with a token and never with the body --
     * a discreet notification exists precisely so its words are not readable by
     * whoever holds the phone, and a log that printed them would undo that.
     */
    this.onEvent?.('push.dispatched', {
      accountId,
      kind: notification.kind,
      urgency: notification.urgency,
      attempted: summary.attempted,
      delivered: summary.delivered,
      failed: summary.failed,
      pruned: summary.pruned.length,
    });

    return summary;
  }
}

/**
 * A provider that records instead of sending.
 *
 * For tests and for a deployment with no credentials yet. It reports success,
 * which is a deliberate and slightly uncomfortable choice: the alternative is a
 * development environment where every call appears to fail. `PushDispatcher`
 * reporting `configured` is what a deployment should check to know whether
 * anything real is happening.
 */
export function createRecordingPushProvider(): PushProvider & {
  readonly sent: { target: PushTarget; notification: PushNotification }[];
} {
  const sent: { target: PushTarget; notification: PushNotification }[] = [];
  return {
    name: 'recording',
    platforms: ['ios', 'android', 'web'],
    sent,
    async send(target, notification) {
      sent.push({ target, notification });
      return { ok: true };
    },
  };
}
