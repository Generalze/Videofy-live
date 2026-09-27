/** @author masterzee001 */
/**
 * The bridge's reading of the battery exemption, with the Kotlin side faked
 * at the module boundary: what the native layer answers is what JS reports,
 * and what it cannot answer is reported as UNKNOWN -- never as granted.
 */
import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  present: true,
  exemption: 'granted' as string,
  bucket: 40,
  requests: 0,
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
        }
      : null,
}));

const { videofyCall } = await import('../native/videofyCall');

describe('reading the exemption through the bridge', () => {
  it('reports each of the three platform answers as itself', () => {
    for (const answer of ['granted', 'not-granted', 'not-applicable'] as const) {
      fake.exemption = answer;
      expect(videofyCall.batteryExemption()).toBe(answer);
    }
  });

  it('reports a word it does not know as unknown, not as granted', () => {
    fake.exemption = 'probably';
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

describe('a build without the native layer', () => {
  it('cannot read, cannot ask, and says so', async () => {
    fake.present = false;
    vi.resetModules();
    const { videofyCall: without } = await import('../native/videofyCall');
    expect(without.available).toBe(false);
    expect(without.batteryExemption()).toBe('unknown');
    expect(without.requestBatteryExemption()).toBe(false);
    expect(without.standbyBucket()).toBeNull();
  });
});
