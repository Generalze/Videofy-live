/** @author masterzee001 */
/**
 * The bridge's reading of the battery exemption and of the timelines still
 * on the device, with the Kotlin side faked at the module boundary: what the
 * native layer answers is what JS reports, and what it cannot answer is
 * reported as UNKNOWN -- never as granted, and a failed read never as "this
 * Android has no such setting".
 */
import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  present: true,
  exemption: 'granted' as string,
  bucket: 40,
  requests: 0,
  pending: '{}' as unknown,
  forgotten: [] as string[],
}));

vi.mock('expo', () => ({
  requireOptionalNativeModule: () =>
    fake.present
      ? {
          batteryExemption: () => fake.exemption,
          requestBatteryExemption: () => {
            fake.requests += 1;
            return true;
          },
          standbyBucket: () => fake.bucket,
          pendingTimelines: () => fake.pending,
          forgetTimeline: (callId: string) => {
            fake.forgotten.push(callId);
          },
        }
      : null,
}));

const { videofyCall } = await import('../native/videofyCall');

describe('reading the exemption through the bridge', () => {
  it('reports each of the four platform answers as itself', () => {
    for (const answer of ['granted', 'not-granted', 'not-applicable', 'unreadable'] as const) {
      fake.exemption = answer;
      expect(videofyCall.batteryExemption()).toBe(answer);
    }
  });

  it('keeps a failed read as unreadable: never not-applicable, never granted', () => {
    fake.exemption = 'unreadable';
    const read = videofyCall.batteryExemption();
    expect(read).toBe('unreadable');
    expect(read).not.toBe('not-applicable');
    expect(read).not.toBe('granted');
  });

  it('reports a word it does not know as unknown, not as granted', () => {
    fake.exemption = 'probably';
    expect(videofyCall.batteryExemption()).toBe('unknown');
    fake.exemption = '';
    expect(videofyCall.batteryExemption()).toBe('unknown');
  });

  it('reports the bucket code, and null for the platform’s -1', () => {
    fake.bucket = 40;
    expect(videofyCall.standbyBucket()).toBe(40);
    fake.bucket = -1;
    expect(videofyCall.standbyBucket()).toBeNull();
  });

  it('says only that the dialog was launched', () => {
    expect(videofyCall.requestBatteryExemption()).toBe(true);
    expect(fake.requests).toBe(1);
    // Launched is not granted: the reading is still whatever the platform says.
    fake.exemption = 'not-granted';
    expect(videofyCall.batteryExemption()).toBe('not-granted');
  });
});

describe('the timelines still on the device', () => {
  it('reads every call’s stamps out of the native JSON, numbers only', () => {
    fake.pending = JSON.stringify({
      'call-a': { t4_push_received: 1_700_000_000_000, t4_standby_bucket: 40, t4_battery_exempt: -2, t5_not_rung: 1_700_000_000_400, t5_not_rung_reason: 7, note: 'x' },
      'call-b': { t4_push_received: 1_700_000_100_000 },
    });
    expect(videofyCall.pendingTimelines()).toEqual({
      'call-a': { t4_push_received: 1_700_000_000_000, t4_standby_bucket: 40, t4_battery_exempt: -2, t5_not_rung: 1_700_000_000_400, t5_not_rung_reason: 7 },
      'call-b': { t4_push_received: 1_700_000_100_000 },
    });
  });

  it('reads nothing from an empty, malformed or non-object answer, rather than throwing into the sweep', () => {
    for (const answer of ['', '{', '[]', '42', 'null', 42, undefined, null]) {
      fake.pending = answer;
      expect(videofyCall.pendingTimelines()).toEqual({});
    }
  });

  it('skips a call whose stamps are not an object and keeps the others', () => {
    fake.pending = JSON.stringify({ 'call-a': 7, 'call-b': null, 'call-c': { t4_push_received: 1 } });
    expect(videofyCall.pendingTimelines()).toEqual({ 'call-c': { t4_push_received: 1 } });
  });

  it('forgets exactly the call it is told to', () => {
    fake.forgotten.length = 0;
    videofyCall.forgetTimeline('call-a');
    expect(fake.forgotten).toEqual(['call-a']);
  });
});

describe('a build without the native layer', () => {
  it('cannot read, cannot ask, and says so', async () => {
    fake.present = false;
    vi.resetModules();
    const { videofyCall: without } = await import('../native/videofyCall');
    expect(without.available).toBe(false);
    expect(without.batteryExemption()).toBe('unknown');
    expect(without.requestBatteryExemption()).toBe(false);
    expect(without.standbyBucket()).toBeNull();
    expect(without.pendingTimelines()).toEqual({});
    expect(() => without.forgetTimeline('call-a')).not.toThrow();
  });
});
