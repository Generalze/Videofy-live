/** @author masterzee001 */
/**
 * The words about waking, derived from readings and nothing else.
 *
 * Every claim on the ringing banner and the profile row passes through
 * push/ringingReadiness, so this is where a screen would be caught saying
 * "calls will now ring" over a reading that said otherwise -- or over no
 * reading at all.
 */
import { describe, expect, it } from 'vitest';
import {
  bucketFromCode,
  readRingingReadiness,
  readinessWords,
  shouldOfferExemption,
  vendorSettingFor,
  type BatteryExemption,
  type RingingReadiness,
} from '../push/ringingReadiness';

const reads = (exemption: BatteryExemption, bucket: number | null = null) => ({
  batteryExemption: () => exemption,
  standbyBucket: () => bucket,
});

const readiness = (over: Partial<RingingReadiness> = {}): RingingReadiness => ({
  exemption: 'not-granted',
  bucket: null,
  vendor: null,
  ...over,
});

describe('the standby bucket, named from the platform code', () => {
  it('names every documented bucket and nothing else', () => {
    expect(bucketFromCode(5)).toBe('exempted');
    expect(bucketFromCode(10)).toBe('active');
    expect(bucketFromCode(20)).toBe('working-set');
    expect(bucketFromCode(30)).toBe('frequent');
    expect(bucketFromCode(40)).toBe('rare');
    expect(bucketFromCode(45)).toBe('restricted');
    expect(bucketFromCode(50)).toBe('never');
    // An unknown code is not rounded to a neighbour; it is "no reading".
    expect(bucketFromCode(41)).toBeNull();
    expect(bucketFromCode(0)).toBeNull();
    expect(bucketFromCode(null)).toBeNull();
  });
});

describe('the vendor setting no app can reach', () => {
  it('names the second battery manager for the manufacturers known to ship one', () => {
    expect(vendorSettingFor('samsung')?.vendor).toBe('Samsung');
    expect(vendorSettingFor('Xiaomi')?.vendor).toBe('Xiaomi');
    expect(vendorSettingFor('POCO')?.vendor).toBe('Xiaomi');
    expect(vendorSettingFor('HUAWEI')?.vendor).toBe('Huawei');
    expect(vendorSettingFor('HONOR')?.vendor).toBe('Huawei');
    expect(vendorSettingFor('OnePlus')?.vendor).toBe('Oppo');
    expect(vendorSettingFor('realme')?.vendor).toBe('Oppo');
    expect(vendorSettingFor('vivo')?.vendor).toBe('Vivo');
    expect(vendorSettingFor('TECNO')?.vendor).toBe('Tecno');
    expect(vendorSettingFor('Infinix')?.vendor).toBe('Tecno');
  });

  it('says nothing about a manufacturer it does not know, rather than guessing', () => {
    expect(vendorSettingFor('Google')).toBeNull();
    expect(vendorSettingFor('motorola')).toBeNull();
    expect(vendorSettingFor('')).toBeNull();
    expect(vendorSettingFor('   ')).toBeNull();
    expect(vendorSettingFor(null)).toBeNull();
  });

  it('matches on the manufacturer string as Android reports it, whatever the case', () => {
    expect(vendorSettingFor('SAMSUNG Electronics')?.vendor).toBe('Samsung');
  });
});

describe('one reading, assembled', () => {
  it('carries the exemption, the named bucket and the vendor setting', () => {
    const read = readRingingReadiness(reads('not-granted', 40), 'samsung');
    expect(read.exemption).toBe('not-granted');
    expect(read.bucket).toBe('rare');
    expect(read.vendor?.vendor).toBe('Samsung');
  });

  it('reads null where there is no bucket and no vendor', () => {
    const read = readRingingReadiness(reads('granted', null), 'Google');
    expect(read).toEqual({ exemption: 'granted', bucket: null, vendor: null });
  });
});

describe('when to put the request in front of the person', () => {
  it('offers it only when Android was READ as not exempt', () => {
    expect(shouldOfferExemption(readiness({ exemption: 'not-granted' }), false)).toBe(true);
    expect(shouldOfferExemption(readiness({ exemption: 'granted' }), false)).toBe(false);
    expect(shouldOfferExemption(readiness({ exemption: 'not-applicable' }), false)).toBe(false);
    // A build that cannot read the setting has nothing to ask about.
    expect(shouldOfferExemption(readiness({ exemption: 'unknown' }), false)).toBe(false);
  });

  it('never offers it before a reading exists', () => {
    expect(shouldOfferExemption(null, false)).toBe(false);
  });

  it('stops offering once the person has said not now', () => {
    expect(shouldOfferExemption(readiness({ exemption: 'not-granted' }), true)).toBe(false);
  });
});

describe('the words say what was read, and no more', () => {
  it('states the exemption as granted, and STILL names the vendor setting', () => {
    const words = readinessWords(readiness({ exemption: 'granted', vendor: vendorSettingFor('samsung') }));
    expect(words.tone).toBe('ok');
    expect(words.headline).toBe('Allowed to run in the background');
    // The exemption is not the whole answer on a Samsung, and the words say so.
    expect(words.vendorLine).toContain('Samsung');
    expect(words.vendorLine).toContain('no app can reach');
    expect(words.vendorLine).toContain('Only you can change it');
  });

  it('warns when not exempt, and says what to do', () => {
    const words = readinessWords(readiness({ exemption: 'not-granted' }));
    expect(words.tone).toBe('warn');
    expect(words.headline).toBe('Calls may not ring when the app has been closed for a while');
    expect(words.detail).toContain('Allow Videofy Live to run in the background');
    expect(words.vendorLine).toBeNull();
  });

  it('reports the bucket in words when one was read, and nothing when none was', () => {
    expect(readinessWords(readiness({ bucket: 'rare' })).bucketLine).toBe('Right now Android files this app as rare, where pushes are rationed.');
    expect(readinessWords(readiness({ bucket: 'restricted' })).bucketLine).toContain('the ring may be barred');
    expect(readinessWords(readiness({ bucket: 'active' })).bucketLine).toBe('Right now Android files this app as active.');
    expect(readinessWords(readiness({ bucket: null })).bucketLine).toBeNull();
  });

  it('says the setting could not be read, rather than anything about calls', () => {
    const words = readinessWords(readiness({ exemption: 'unknown', bucket: 'rare' }));
    expect(words.tone).toBe('unknown');
    expect(words.headline).toBe('This build cannot read the battery setting');
    // A bucket handed in beside an unreadable exemption is not shown: the
    // build that cannot read one cannot have read the other.
    expect(words.bucketLine).toBeNull();
  });

  it('says there is nothing to allow on an Android without the setting', () => {
    const words = readinessWords(readiness({ exemption: 'not-applicable' }));
    expect(words.tone).toBe('ok');
    expect(words.headline).toBe('This Android version has no battery budget for apps');
  });

  it('NEVER promises that calls will always ring', () => {
    const cases: BatteryExemption[] = ['granted', 'not-granted', 'not-applicable', 'unknown'];
    for (const exemption of cases) {
      for (const vendor of [null, vendorSettingFor('xiaomi')]) {
        const words = readinessWords(readiness({ exemption, vendor, bucket: 'active' }));
        const everything = [words.headline, words.detail, words.bucketLine ?? '', words.vendorLine ?? ''].join(' ');
        expect(everything).not.toMatch(/always ring|will ring|now ring/iu);
      }
    }
  });
});
