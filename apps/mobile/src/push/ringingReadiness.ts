/** @author masterzee001 */
/**
 * Whether this phone can be woken for a call -- what was READ, in words.
 *
 * THE DEFECT (27 Sep 2026). Three real calls in one evening. The server sent
 * a data-only, high-priority push with a TTL matching the ring window; Google
 * accepted all three in under a second (`delivered:1 failed:0`); all three
 * went to no_answer, and the device timeline held NO t4_push_received. The
 * phone never woke. Google's "delivered" means accepted for delivery, not
 * received: the only evidence a phone woke is the phone saying so.
 *
 * Android puts an app that has not been opened recently into a standby
 * bucket where high-priority pushes are rationed, and may bar it from
 * starting the service that rings. The app can ask to be exempt from that
 * (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS), which appeared nowhere in this
 * repository until now.
 *
 * TWO RULES THIS FILE OBEYS, because the alternative is the lie this codebase
 * keeps having to remove:
 *   - NEVER CLAIM A STATE THAT WAS NOT READ. Every word here is derived from
 *     a reading the native layer took from Android; `unknown` is a real
 *     answer and is shown as one.
 *   - THE EXEMPTION IS NOT ENOUGH. Samsung and the Chinese OEMs run a
 *     second battery manager no API can reach. Where the manufacturer is
 *     known to have one, the words name it and say only the person can
 *     change it -- never "calls will now always ring".
 *
 * Pure: the readings come in, the words come out, nothing here touches the
 * platform. That is what lets a mutant be caught without a handset.
 */
import type { BatteryExemption } from '../native/videofyCall';

export type { BatteryExemption };

/** Android's standby buckets, named from the UsageStatsManager codes. */
export type StandbyBucket = 'exempted' | 'active' | 'working-set' | 'frequent' | 'rare' | 'restricted' | 'never';

/** The setting no API reaches: which vendor, and where a person finds it. */
export interface VendorSetting {
  readonly vendor: string;
  readonly where: string;
}

export interface RingingReadiness {
  readonly exemption: BatteryExemption;
  /** Null where the platform or the build has no buckets to read. */
  readonly bucket: StandbyBucket | null;
  /** Null where no second battery manager is known for this manufacturer. */
  readonly vendor: VendorSetting | null;
}

/** The two reads the native layer offers; kept narrow so a test can hand in a fake. */
export interface RingingReads {
  batteryExemption(): BatteryExemption;
  standbyBucket(): number | null;
}

/** UsageStatsManager.STANDBY_BUCKET_* -- the constants, transcribed. */
const BUCKET_CODES: readonly [number, StandbyBucket][] = [
  [5, 'exempted'],
  [10, 'active'],
  [20, 'working-set'],
  [30, 'frequent'],
  [40, 'rare'],
  [45, 'restricted'],
  [50, 'never'],
];

export function bucketFromCode(code: number | null): StandbyBucket | null {
  if (code === null) return null;
  return BUCKET_CODES.find(([known]) => known === code)?.[1] ?? null;
}

/**
 * The manufacturers known to ship a second battery manager, and where it
 * lives. The exact words vary by model and Android version, so each entry
 * names the setting rather than promising a path; the honest claim is that
 * it exists and that only the person can change it.
 */
const VENDOR_SETTINGS: readonly { readonly match: readonly string[]; readonly setting: VendorSetting }[] = [
  {
    match: ['samsung'],
    setting: {
      vendor: 'Samsung',
      where: 'Battery > Background usage limits: take Videofy Live out of Sleeping apps and Deep sleeping apps, and set its battery use to Unrestricted',
    },
  },
  {
    match: ['xiaomi', 'redmi', 'poco'],
    setting: {
      vendor: 'Xiaomi',
      where: 'Security > Autostart: turn it on for Videofy Live, and set the app’s Battery saver to No restrictions',
    },
  },
  {
    match: ['huawei', 'honor'],
    setting: {
      vendor: 'Huawei',
      where: 'Battery > App launch: manage Videofy Live manually with Auto-launch, Secondary launch and Run in background all on',
    },
  },
  {
    match: ['oppo', 'realme', 'oneplus'],
    setting: {
      vendor: 'Oppo',
      where: 'Battery > App battery management (or Auto-launch): allow Videofy Live to start on its own and run in the background',
    },
  },
  {
    match: ['vivo', 'iqoo'],
    setting: {
      vendor: 'Vivo',
      where: 'i Manager > App manager > Autostart: allow Videofy Live, and allow its background power use',
    },
  },
  {
    match: ['tecno', 'infinix', 'itel'],
    setting: {
      vendor: 'Tecno',
      where: 'Phone Master > Auto-start management: allow Videofy Live, and lift its power-saving restriction',
    },
  },
];

export function vendorSettingFor(manufacturer: string | null): VendorSetting | null {
  const needle = (manufacturer ?? '').trim().toLowerCase();
  if (needle.length === 0) return null;
  return VENDOR_SETTINGS.find(({ match }) => match.some((name) => needle.includes(name)))?.setting ?? null;
}

/** One reading, from the two things the platform can tell us and the one it cannot. */
export function readRingingReadiness(reads: RingingReads, manufacturer: string | null): RingingReadiness {
  return {
    exemption: reads.batteryExemption(),
    bucket: bucketFromCode(reads.standbyBucket()),
    vendor: vendorSettingFor(manufacturer),
  };
}

/**
 * Whether to put the request in front of the person now. Only when Android
 * has been READ as not exempt, and only until they have said not now: an
 * app that asks on every launch is one people learn to swipe past.
 */
export function shouldOfferExemption(readiness: RingingReadiness | null, dismissed: boolean): boolean {
  if (readiness === null || dismissed) return false;
  return readiness.exemption === 'not-granted';
}

export interface ReadinessWords {
  readonly headline: string;
  readonly detail: string;
  /** What the bucket reading says, or null when there was none to read. */
  readonly bucketLine: string | null;
  /** The setting no app can reach, or null where none is known for this phone. */
  readonly vendorLine: string | null;
  readonly tone: 'ok' | 'warn' | 'unknown';
}

const BUCKET_WORDS: Record<StandbyBucket, string> = {
  exempted: 'exempt from standby',
  active: 'active',
  'working-set': 'in its working set',
  frequent: 'frequent',
  rare: 'rare, where pushes are rationed',
  restricted: 'restricted, where pushes are held back and the ring may be barred',
  never: 'never used',
};

/**
 * The words, and nothing the reading did not say. The headline states the
 * measured fact; the detail says what it means for a telephone; the vendor
 * line, when there is one, is the honest limit of what any app can do.
 */
export function readinessWords(readiness: RingingReadiness): ReadinessWords {
  const bucketLine =
    readiness.bucket === null ? null : `Right now Android files this app as ${BUCKET_WORDS[readiness.bucket]}.`;
  const vendorLine =
    readiness.vendor === null
      ? null
      : `${readiness.vendor.vendor} phones have a second setting no app can reach: ${readiness.vendor.where}. Only you can change it, in the phone’s own settings, and the exact words vary by model. Swiping the app away from recent apps on these phones can stop it entirely; calls will not ring again until it is opened.`;
  switch (readiness.exemption) {
    case 'granted':
      return {
        headline: 'Allowed to run in the background',
        detail: 'Android will let a call wake this app. That is the part Android controls.',
        bucketLine,
        vendorLine,
        tone: 'ok',
      };
    case 'not-granted':
      return {
        headline: 'Calls may not ring when the app has been closed for a while',
        detail:
          'Android puts an app you have not opened recently on a battery budget. A call push can sit in that queue, or arrive and be barred from starting the ring. Allow Videofy Live to run in the background so a call can wake it.',
        bucketLine,
        vendorLine,
        tone: 'warn',
      };
    case 'not-applicable':
      return {
        headline: 'This Android version has no battery budget for apps',
        detail: 'There is nothing to allow here.',
        bucketLine,
        vendorLine,
        tone: 'ok',
      };
    case 'unknown':
      return {
        headline: 'This build cannot read the battery setting',
        detail: 'The native call layer is not in this build, so nothing here can be measured. Install the newest build.',
        bucketLine: null,
        vendorLine,
        tone: 'unknown',
      };
  }
}
