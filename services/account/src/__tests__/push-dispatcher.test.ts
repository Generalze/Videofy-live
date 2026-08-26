/**
 * Notifying an account across every phone it has.
 *
 * Two rules carry these tests: a permanent failure prunes the device and a
 * transient one does not, and a discreet notification never carries words. Both
 * fail silently if they are wrong -- one as a registry slowly filling with dead
 * tokens, the other as a message preview on a lock screen belonging to somebody
 * the message was not for.
 */
import { describe, expect, it } from 'vitest';
import { DeviceStore } from '../device-store.js';
import { PushDispatcher, createRecordingPushProvider } from '../push/push-dispatcher.js';
import type { PushNotification, PushProvider, PushSendResult } from '../push/push-provider.js';

const RING: PushNotification = {
  kind: 'call',
  privacy: 'visible',
  urgency: 'high',
  title: 'Incoming call',
  body: 'Zoe is calling',
  data: { callId: 'call_1' },
};

const PREVIEW: PushNotification = {
  kind: 'message',
  privacy: 'discreet',
  urgency: 'normal',
  title: 'New message',
  body: 'the actual private words',
  data: { messageId: 'msg_1' },
};

async function withDevices(count: number) {
  const devices = new DeviceStore();
  for (let index = 0; index < count; index += 1) {
    await devices.register({
      deviceId: `dev_${index}`,
      accountId: 'acct_a',
      platform: index % 2 === 0 ? 'ios' : 'android',
      pushToken: `tok_${index}`,
    });
  }
  return devices;
}

function providerThat(result: PushSendResult): PushProvider {
  return {
    name: 'stub',
    platforms: ['ios', 'android', 'web'],
    async send() {
      return result;
    },
  };
}

describe('fanning out', () => {
  it('rings every device on the account', async () => {
    const devices = await withDevices(3);
    const provider = createRecordingPushProvider();
    const summary = await new PushDispatcher({ devices, providers: [provider] }).notify('acct_a', RING);

    expect(summary.attempted).toBe(3);
    expect(summary.delivered).toBe(3);
    expect(provider.sent).toHaveLength(3);
  });

  it('does not notify anybody else', async () => {
    const devices = await withDevices(2);
    const provider = createRecordingPushProvider();
    await new PushDispatcher({ devices, providers: [provider] }).notify('acct_stranger', RING);
    expect(provider.sent).toHaveLength(0);
  });

  /*
   * One phone off must not stop the phone that was going to be answered. This
   * is why nothing here throws on the first failure.
   */
  it('keeps going when one device fails', async () => {
    const devices = await withDevices(3);
    let call = 0;
    const flaky: PushProvider = {
      name: 'flaky',
      platforms: ['ios', 'android', 'web'],
      async send() {
        call += 1;
        return call === 1 ? { ok: false, permanent: false, reason: 'timeout' } : { ok: true };
      },
    };

    const summary = await new PushDispatcher({ devices, providers: [flaky] }).notify('acct_a', RING);
    expect(summary.delivered).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it('does not throw when a provider throws', async () => {
    const devices = await withDevices(1);
    const exploding: PushProvider = {
      name: 'exploding',
      platforms: ['ios', 'android', 'web'],
      async send() {
        throw new Error('socket hang up');
      },
    };

    const summary = await new PushDispatcher({ devices, providers: [exploding] }).notify('acct_a', RING);
    expect(summary.failed).toBe(1);
    // A thrown error is transient: never unregister a phone over a network blip.
    expect(summary.pruned).toHaveLength(0);
  });
});

describe('pruning dead tokens', () => {
  /*
   * THE OPERATIONAL RULE. An uninstalled app answers "unregistered" forever.
   * Keeping the row means paying to send to it and counting the failure against
   * delivery statistics until nobody trusts them.
   */
  it('removes a device whose token will never work again', async () => {
    const devices = await withDevices(2);
    const summary = await new PushDispatcher({
      devices,
      providers: [providerThat({ ok: false, permanent: true, reason: 'unregistered' })],
    }).notify('acct_a', RING);

    expect(summary.pruned).toHaveLength(2);
    expect(devices.listFor('acct_a')).toHaveLength(0);
  });

  it('keeps a device that failed transiently', async () => {
    const devices = await withDevices(2);
    const summary = await new PushDispatcher({
      devices,
      providers: [providerThat({ ok: false, permanent: false, reason: 'timeout' })],
    }).notify('acct_a', RING);

    expect(summary.pruned).toHaveLength(0);
    expect(devices.listFor('acct_a')).toHaveLength(2);
  });
});

describe('what a locked screen may show', () => {
  /*
   * THE PRIVACY ONE. A translated message on a lock screen is readable by
   * whoever is holding the phone, which is not always the person it was sent
   * to. Discreet notifications carry the data and lose the words.
   */
  it('strips the words from a discreet notification', async () => {
    const devices = await withDevices(1);
    const provider = createRecordingPushProvider();
    await new PushDispatcher({ devices, providers: [provider] }).notify('acct_a', PREVIEW);

    const delivered = provider.sent[0]?.notification;
    expect(delivered?.title).toBeUndefined();
    expect(delivered?.body).toBeUndefined();
    // The app still knows what to fetch once it is unlocked.
    expect(delivered?.data['messageId']).toBe('msg_1');
  });

  it('leaves a visible notification intact', async () => {
    const devices = await withDevices(1);
    const provider = createRecordingPushProvider();
    await new PushDispatcher({ devices, providers: [provider] }).notify('acct_a', RING);

    expect(provider.sent[0]?.notification.body).toBe('Zoe is calling');
  });

  it('never puts a token or a message body in an event', async () => {
    const devices = await withDevices(1);
    const events: { event: string; detail: Record<string, string | number> }[] = [];
    await new PushDispatcher({
      devices,
      providers: [createRecordingPushProvider()],
      onEvent: (event, detail) => events.push({ event, detail }),
    }).notify('acct_a', PREVIEW);

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('tok_0');
    expect(serialised).not.toContain('the actual private words');
  });
});

describe('a deployment that cannot push at all', () => {
  /*
   * The failure mode is that calls never arrive while every service reports
   * itself healthy. It has to be loud.
   */
  it('reports itself unconfigured rather than silently succeeding', async () => {
    const devices = await withDevices(2);
    const events: string[] = [];
    const dispatcher = new PushDispatcher({
      devices,
      providers: [],
      onEvent: (event) => events.push(event),
    });

    expect(dispatcher.configured).toBe(false);
    const summary = await dispatcher.notify('acct_a', RING);
    expect(summary.delivered).toBe(0);
    expect(events).toContain('push.not-configured');
  });

  it('names platforms it has devices for but cannot reach', async () => {
    const devices = await withDevices(2);
    const iosOnly: PushProvider = {
      name: 'apns',
      platforms: ['ios'],
      async send() {
        return { ok: true };
      },
    };

    const summary = await new PushDispatcher({ devices, providers: [iosOnly] }).notify('acct_a', RING);
    expect(summary.delivered).toBe(1);
    expect(summary.unreachablePlatforms).toContain('android');
  });
});
