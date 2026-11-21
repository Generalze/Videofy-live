/** @author masterzee001 */
/**
 * The words about waking, derived from readings and nothing else.
 *
 * Every claim on the ringing banner and the profile row passes through
 * push/ringingReadiness, so this is where a screen would be caught saying
 * "calls will now ring" over a reading that said otherwise -- or over no
 * reading at all -- and where a read that FAILED would be caught being
 * shown as a phone with no problem.
 */
import { describe, expect, it } from 'vitest';
import {
  bucketFromCode,
  exemptionFromTimelineCode,
  readRingingReadiness,
  readinessWords,
  shouldNameVendorSetting,
  shouldOfferExemption,
  shouldShowRingingBanner,
  TIMELINE_EXEMPTION_CODES,
  vendorSettingFor,
  type BatteryExemption,
  type RingingReadiness,
} from '../push/ringingReadiness';

const EVERY_ANSWER: readonly BatteryExemption[] = ['granted', 'not-granted', 'not-applicable', 'unreadable', 'unknown'];

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

describe('the exemption as the ring timeline carries it (DeviceStandby.batteryExemptionCode, transcribed)', () => {
  it('reads each of the four codes back as its own answer', () => {
    expect(exemptionFromTimelineCode(1)).toBe('granted');
    expect(exemptionFromTimelineCode(0)).toBe('not-granted');
    expect(exemptionFromTimelineCode(-1)).toBe('not-applicable');
    expect(exemptionFromTimelineCode(-2)).toBe('unreadable');
  });

  it('keeps a failed read (-2) apart from an Android with no setting (-1)', () => {
    // The whole point of the fourth code: a read that failed at T4 must
    // never be logged as "this Android has no battery budget".
    expect(exemptionFromTimelineCode(-2)).not.toBe('not-applicable');
    expect(exemptionFromTimelineCode(-1)).not.toBe('unreadable');
  });

  it('reads a code it does not know as unknown, never as granted', () => {
    expect(exemptionFromTimelineCode(2)).toBe('unknown');
    expect(exemptionFromTimelineCode(-3)).toBe('unknown');
    // And the table carries one entry per code, so no code is shadowed.
    expect(new Set(TIMELINE_EXEMPTION_CODES.map(([code]) => code)).size).toBe(TIMELINE_EXEMPTION_CODES.length);
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

  it('carries a failed read through as unreadable, not as anything else', () => {
    expect(readRingingReadiness(reads('unreadable', 40), null).exemption).toBe('unreadable');
  });
});

describe('THE REQUEST: offered while the exemption is missing', () => {
  it('is offered when Android was READ as not exempt', () => {
    expect(shouldOfferExemption(readiness({ exemption: 'not-granted' }))).toBe(true);
  });

  it('is STILL offered when the read could not be performed -- an unknown is not a clean bill of health', () => {
    expect(shouldOfferExemption(readiness({ exemption: 'unreadable' }))).toBe(true);
  });

  it('is not offered where it was granted, where the Android has no such setting, or where this build cannot ask', () => {
    expect(shouldOfferExemption(readiness({ exemption: 'granted' }))).toBe(false);
    expect(shouldOfferExemption(readiness({ exemption: 'not-applicable' }))).toBe(false);
    // A build without the native layer has nothing to launch the dialog with.
    expect(shouldOfferExemption(readiness({ exemption: 'unknown' }))).toBe(false);
  });

  it('is never offered before a reading exists', () => {
    expect(shouldOfferExemption(null)).toBe(false);
  });

  it('does not depend on the vendor', () => {
    const samsung = vendorSettingFor('samsung');
    for (const exemption of EVERY_ANSWER) {
      expect(shouldOfferExemption(readiness({ exemption, vendor: samsung }))).toBe(shouldOfferExemption(readiness({ exemption })));
    }
  });
});

describe('THE VENDOR SENTENCE: named on a vendor phone, whatever the exemption says', () => {
  it('is wanted for every exemption answer alike, because granting the exemption changes nothing about that setting', () => {
    const samsung = vendorSettingFor('samsung');
    for (const exemption of EVERY_ANSWER) {
      expect(shouldNameVendorSetting(readiness({ exemption, vendor: samsung }))).toBe(true);
    }
  });

  it('is not wanted where no second battery manager is known, and never before a reading', () => {
    for (const exemption of EVERY_ANSWER) {
      expect(shouldNameVendorSetting(readiness({ exemption, vendor: null }))).toBe(false);
    }
    expect(shouldNameVendorSetting(null)).toBe(false);
  });
});

describe('the card above Chats', () => {
  it('shows while the request has something to say', () => {
    expect(shouldShowRingingBanner(readiness({ exemption: 'not-granted' }), false)).toBe(true);
    expect(shouldShowRingingBanner(readiness({ exemption: 'unreadable' }), false)).toBe(true);
  });

  it('STAYS UP on a vendor phone after the exemption is granted -- the moment it matters most', () => {
    // The first version hid the banner here, and the sentence about the
    // setting that STILL blocked the person's calls vanished with it.
    expect(shouldShowRingingBanner(readiness({ exemption: 'granted', vendor: vendorSettingFor('samsung') }), false)).toBe(true);
    expect(shouldShowRingingBanner(readiness({ exemption: 'not-applicable', vendor: vendorSettingFor('xiaomi') }), false)).toBe(true);
  });

  it('has nothing to say on a plain phone once the exemption is granted', () => {
    expect(shouldShowRingingBanner(readiness({ exemption: 'granted', vendor: null }), false)).toBe(false);
    expect(shouldShowRingingBanner(readiness({ exemption: 'not-applicable', vendor: null }), false)).toBe(false);
  });

  it('never shows before a reading exists', () => {
    expect(shouldShowRingingBanner(null, false)).toBe(false);
  });

  it('stops once the person has said not now, whatever it had to say', () => {
    expect(shouldShowRingingBanner(readiness({ exemption: 'not-granted' }), true)).toBe(false);
    expect(shouldShowRingingBanner(readiness({ exemption: 'granted', vendor: vendorSettingFor('samsung') }), true)).toBe(false);
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

  it('names the vendor setting for EVERY exemption answer, in the same words', () => {
    const lines = EVERY_ANSWER.map((exemption) => readinessWords(readiness({ exemption, vendor: vendorSettingFor('xiaomi') })).vendorLine);
    for (const line of lines) expect(line).toContain('Xiaomi phones have a second setting no app can reach');
    expect(new Set(lines).size).toBe(1);
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

  it('says a FAILED read failed, as a warning, and never that the phone has no problem', () => {
    const words = readinessWords(readiness({ exemption: 'unreadable', bucket: 'rare' }));
    expect(words.tone).toBe('warn');
    expect(words.headline).toBe('The battery setting could not be read');
    expect(words.detail).toContain('not a clean bill of health');
    expect(words.detail).toContain('allow background use anyway');
    // Nothing in it may borrow the words of the one answer that means "nothing to allow".
    const nothingToAllow = readinessWords(readiness({ exemption: 'not-applicable' }));
    expect(words.headline).not.toBe(nothingToAllow.headline);
    expect(`${words.headline} ${words.detail}`).not.toMatch(/no battery budget|nothing to allow/iu);
    // The bucket WAS read, by the same layer, so it is still shown.
    expect(words.bucketLine).toContain('rare');
  });

  it('says the setting could not be read by THIS BUILD, rather than anything about calls', () => {
    const words = readinessWords(readiness({ exemption: 'unknown', bucket: 'rare' }));
    expect(words.tone).toBe('unknown');
    expect(words.headline).toBe('This build cannot read the battery setting');
    // A bucket handed in beside an unreadable exemption is not shown: the
    // build that cannot read one cannot have read the other.
    expect(words.bucketLine).toBeNull();
  });

  it('says there is nothing to allow ONLY on an Android without the setting', () => {
    const words = readinessWords(readiness({ exemption: 'not-applicable' }));
    expect(words.tone).toBe('ok');
    expect(words.headline).toBe('This Android version has no battery budget for apps');
    for (const exemption of EVERY_ANSWER.filter((answer) => answer !== 'not-applicable')) {
      expect(readinessWords(readiness({ exemption })).headline).not.toBe(words.headline);
    }
  });

  it('gives every answer its own headline', () => {
    const headlines = EVERY_ANSWER.map((exemption) => readinessWords(readiness({ exemption })).headline);
    expect(new Set(headlines).size).toBe(EVERY_ANSWER.length);
  });

  it('NEVER promises that calls will always ring', () => {
    for (const exemption of EVERY_ANSWER) {
      for (const vendor of [null, vendorSettingFor('xiaomi')]) {
        const words = readinessWords(readiness({ exemption, vendor, bucket: 'active' }));
        const everything = [words.headline, words.detail, words.bucketLine ?? '', words.vendorLine ?? ''].join(' ');
        expect(everything).not.toMatch(/always ring|will ring|now ring/iu);
      }
    }
  });
});
