/** @author masterzee001 */
/**
 * The phones an account can be reached on.
 *
 * WHY THIS EXISTS AT ALL. Every other surface in this product assumes somebody
 * is looking at it. A phone is not: the app is backgrounded, the screen is off,
 * and the only way to make it ring is a push notification addressed to a token
 * the operating system issued. Without a registry of those tokens there is no
 * mobile product, only a website in an app shell.
 *
 * A TOKEN BELONGS TO ONE ACCOUNT, AND REGISTERING IT MOVES IT. This is the rule
 * that matters most here, and it is a privacy rule rather than a tidiness one.
 * Push tokens belong to an INSTALL, not to a person: when one person signs out
 * of a shared or resold phone and another signs in, the operating system hands
 * the app the same token. If registration merely added a row, the previous
 * account would keep receiving notifications -- their calls, their message
 * previews, on somebody else's lock screen. So a token is reassigned on
 * registration, and the old owner's claim to it ends at that moment.
 *
 * TOKENS ARE CREDENTIALS AND ARE NEVER LOGGED. Anyone holding one can push to
 * that device through the provider. They are stored, compared and sent; they
 * are not printed, not returned in list responses, and not put in an error
 * message. `describe()` exists so a person can recognise their own device in a
 * list without the response carrying anything worth stealing.
 */

export type DevicePlatform = 'ios' | 'android' | 'web';

export const DEVICE_PLATFORMS: readonly DevicePlatform[] = ['ios', 'android', 'web'];

export interface DeviceRecord {
  /** Stable per install, chosen by the client. */
  readonly deviceId: string;
  readonly accountId: string;
  readonly platform: DevicePlatform;
  /** The provider token. A credential -- see the note above. */
  readonly pushToken: string;
  /** What a person sees in a device list. Never the token. */
  readonly label: string;
  readonly registeredAtMs: number;
  readonly lastSeenAtMs: number;
}

/** What a list endpoint may safely return. */
export interface DeviceSummary {
  readonly deviceId: string;
  readonly platform: DevicePlatform;
  readonly label: string;
  readonly registeredAtMs: number;
  readonly lastSeenAtMs: number;
}

export interface DeviceRecordPort {
  all(): Promise<readonly DeviceRecord[]>;
  save(record: DeviceRecord): Promise<void>;
  remove(deviceId: string): Promise<void>;
}

export interface RegisterDeviceInput {
  readonly deviceId: string;
  readonly accountId: string;
  readonly platform: DevicePlatform;
  readonly pushToken: string;
  readonly label?: string | undefined;
}

export type RegisterResult =
  | { readonly ok: true; readonly device: DeviceSummary; readonly reassignedFrom: string | null }
  | { readonly ok: false; readonly reason: 'invalid-platform' | 'missing-token' | 'missing-device-id' };

/** Trimmed, and capped so a label cannot become a payload. */
const MAX_LABEL = 64;

function summarise(record: DeviceRecord): DeviceSummary {
  return {
    deviceId: record.deviceId,
    platform: record.platform,
    label: record.label,
    registeredAtMs: record.registeredAtMs,
    lastSeenAtMs: record.lastSeenAtMs,
  };
}

export class DeviceStore {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly port: DeviceRecordPort | undefined;
  private readonly now: () => number;

  constructor(options: { port?: DeviceRecordPort | undefined; now?: () => number } = {}) {
    this.port = options.port;
    this.now = options.now ?? (() => Date.now());
  }

  /** Load durable state. A device list that empties on deploy is no list. */
  async hydrate(): Promise<number> {
    if (this.port === undefined) return 0;
    for (const record of await this.port.all()) {
      this.devices.set(record.deviceId, record);
    }
    return this.devices.size;
  }

  /**
   * Register or refresh a device.
   *
   * Idempotent by design: a client that registers on every launch must not
   * accumulate rows, and re-registering the same token for the same account is
   * simply a heartbeat.
   */
  async register(input: RegisterDeviceInput): Promise<RegisterResult> {
    const deviceId = input.deviceId.trim();
    const pushToken = input.pushToken.trim();
    if (deviceId.length === 0) return { ok: false, reason: 'missing-device-id' };
    if (pushToken.length === 0) return { ok: false, reason: 'missing-token' };
    if (!DEVICE_PLATFORMS.includes(input.platform)) return { ok: false, reason: 'invalid-platform' };

    /*
     * THE REASSIGNMENT. Find any other device row already holding this token
     * and drop it. Two rows with one token means the provider decides which
     * account gets the notification, which is to say nobody decided.
     */
    let reassignedFrom: string | null = null;
    for (const [existingId, existing] of this.devices) {
      if (existing.pushToken !== pushToken) continue;
      if (existingId === deviceId && existing.accountId === input.accountId) continue;
      if (existing.accountId !== input.accountId) reassignedFrom = existing.accountId;
      this.devices.delete(existingId);
      await this.port?.remove(existingId);
    }

    const nowMs = this.now();
    const previous = this.devices.get(deviceId);
    const record: DeviceRecord = {
      deviceId,
      accountId: input.accountId,
      platform: input.platform,
      pushToken,
      label: (input.label ?? previous?.label ?? input.platform).trim().slice(0, MAX_LABEL),
      registeredAtMs: previous?.accountId === input.accountId ? previous.registeredAtMs : nowMs,
      lastSeenAtMs: nowMs,
    };

    this.devices.set(deviceId, record);
    await this.port?.save(record);
    return { ok: true, device: summarise(record), reassignedFrom };
  }

  /**
   * Stop reaching an account on a device.
   *
   * Scoped to the owner on purpose: a caller may only revoke a device that is
   * currently theirs, or revocation becomes a way to silence somebody else's
   * phone by guessing an id.
   */
  async revoke(accountId: string, deviceId: string): Promise<boolean> {
    const record = this.devices.get(deviceId);
    if (record === undefined || record.accountId !== accountId) return false;
    this.devices.delete(deviceId);
    await this.port?.remove(deviceId);
    return true;
  }

  /** Every device for an account, most recently seen first. Tokens excluded. */
  listFor(accountId: string): readonly DeviceSummary[] {
    return [...this.devices.values()]
      .filter((record) => record.accountId === accountId)
      .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs)
      .map(summarise);
  }

  /**
   * The tokens to push to. The ONLY method that exposes them.
   *
   * Kept separate from `listFor` so that a route handler cannot return tokens
   * by reaching for the convenient method -- the one that leaks is the one that
   * has to be asked for by name.
   */
  pushTargetsFor(accountId: string): readonly { deviceId: string; platform: DevicePlatform; pushToken: string }[] {
    return [...this.devices.values()]
      .filter((record) => record.accountId === accountId)
      .map((record) => ({
        deviceId: record.deviceId,
        platform: record.platform,
        pushToken: record.pushToken,
      }));
  }

  get size(): number {
    return this.devices.size;
  }
}
