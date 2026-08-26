/** @author masterzee001 */
/**
 * The tariff, and the only door through which it changes.
 *
 * THE STORE ASSIGNS THE VERSION, NOT THE CALLER. Letting a request name its own
 * version invites two operators publishing version 5 from two browser tabs, and
 * the loser's price silently disappearing -- or worse, overwriting a version a
 * charge was already raised under. Reading the current version and writing the
 * next one is a read-modify-write, so it happens behind a lock, and the caller
 * describes the price it wants rather than where it should sit in history.
 *
 * WHAT "CURRENT" MEANS IS A TIME QUESTION, not a row question. A tariff carries
 * the moment it takes effect, so a price can be published on Tuesday to start
 * on Friday. `current()` therefore means "the latest tariff whose effective
 * date has passed", and a future-dated one is real, visible and pending rather
 * than in force.
 *
 * NOTHING HERE DELETES OR EDITS. The port has no update and no delete, and the
 * table refuses both at the database level. Publishing is the only mutation
 * this module knows how to perform.
 */
import {
  DEFAULT_GRADE_TERMS,
  validateTariff,
  type Grade,
  type GradeTerms,
  type Tariff,
  type TariffProblem,
} from '@videofy-live/billing-tariff';

/** Durable storage. Append and read only -- there is no update by design. */
export interface TariffRecordPort {
  /** Every published tariff, ascending by version. */
  all(): Promise<readonly Tariff[]>;
  /** Fails if the version already exists rather than overwriting it. */
  append(tariff: Tariff): Promise<void>;
}

export interface PublishRequest {
  readonly grades: Readonly<Record<Grade, GradeTerms>>;
  readonly currency: string;
  /** ISO-8601. Defaults to now, meaning "in force immediately". */
  readonly effectiveFrom?: string | undefined;
  readonly publishedBy: string;
  readonly note?: string | undefined;
}

export type PublishResult =
  | { readonly ok: true; readonly tariff: Tariff }
  | { readonly ok: false; readonly problems: readonly TariffProblem[] };

export interface TariffStoreOptions {
  readonly port: TariffRecordPort;
  readonly now?: () => number;
}

/**
 * The identity recorded for the tariff nobody published.
 *
 * Seeding writes a real row rather than inventing an implicit price at read
 * time, so that the first charge ever raised points at a tariff that exists in
 * history like every other one. `system:bootstrap` is not an account and cannot
 * sign in, which keeps it distinguishable from a price a person chose.
 */
export const BOOTSTRAP_PUBLISHER = 'system:bootstrap';

export class TariffStore {
  private readonly port: TariffRecordPort;
  private readonly now: () => number;
  /**
   * One lock for the whole table, because publishing is a read-modify-write
   * over the single highest version. Contention is irrelevant here -- prices
   * change a handful of times a year -- and anything finer grained would be
   * protecting nothing.
   */
  private publishing: Promise<unknown> = Promise.resolve();

  constructor(options: TariffStoreOptions) {
    this.port = options.port;
    this.now = options.now ?? (() => Date.now());
  }

  /** Every version ever published, oldest first. */
  async history(): Promise<readonly Tariff[]> {
    return this.port.all();
  }

  /**
   * The tariff in force at a moment, which is how a past charge is explained.
   *
   * Ties break toward the higher version: two tariffs sharing an effective
   * instant is a same-second double publish, and the later one is the intent.
   */
  async inForceAt(atMs: number): Promise<Tariff | null> {
    const all = await this.port.all();
    let winner: Tariff | null = null;
    for (const tariff of all) {
      const effective = Date.parse(tariff.effectiveFrom);
      if (effective > atMs) continue;
      if (winner === null) {
        winner = tariff;
        continue;
      }
      const winningEffective = Date.parse(winner.effectiveFrom);
      if (effective > winningEffective) winner = tariff;
      else if (effective === winningEffective && tariff.version > winner.version) winner = tariff;
    }
    return winner;
  }

  /** The tariff in force right now. Null before anything is published. */
  async current(): Promise<Tariff | null> {
    return this.inForceAt(this.now());
  }

  /** Published but not yet in force. Visible so a change cannot be a surprise. */
  async pending(): Promise<readonly Tariff[]> {
    const nowMs = this.now();
    const all = await this.port.all();
    return all.filter((tariff) => Date.parse(tariff.effectiveFrom) > nowMs);
  }

  /**
   * Publish a new price.
   *
   * Validated against the LATEST version rather than the current one: a version
   * number has to clear everything already written, including a future-dated
   * tariff that has not taken effect yet.
   */
  async publish(request: PublishRequest): Promise<PublishResult> {
    const run = this.publishing.then(async (): Promise<PublishResult> => {
      const all = await this.port.all();
      const previous = all.length === 0 ? undefined : all[all.length - 1];
      const publishedAt = new Date(this.now()).toISOString();

      const candidate: Tariff = {
        version: (previous?.version ?? 0) + 1,
        effectiveFrom: request.effectiveFrom ?? publishedAt,
        currency: request.currency,
        grades: request.grades,
        publishedBy: request.publishedBy,
        publishedAt,
        note: request.note,
      };

      const validation = validateTariff(candidate, previous);
      if (!validation.ok) return { ok: false, problems: validation.problems };

      await this.port.append(candidate);
      return { ok: true, tariff: candidate };
    });

    /*
     * The chain must survive a rejected publish, or one bad request would
     * deadlock every later one behind a permanently rejected promise.
     */
    this.publishing = run.catch(() => undefined);
    return run;
  }

  /**
   * Write the starting tariff if, and only if, nothing has ever been published.
   *
   * Safe to call on every boot: a deployment that already has history is left
   * alone, so a restart can never quietly reinstate the default over a price
   * somebody deliberately set.
   */
  async seedDefault(currency: string): Promise<Tariff | null> {
    const existing = await this.port.all();
    if (existing.length > 0) return null;
    const result = await this.publish({
      grades: DEFAULT_GRADE_TERMS,
      currency,
      publishedBy: BOOTSTRAP_PUBLISHER,
      note: 'Initial tariff.',
    });
    return result.ok ? result.tariff : null;
  }
}

/** In-memory port, for tests and for a deployment with no database yet. */
export function createInMemoryTariffPort(): TariffRecordPort {
  const rows: Tariff[] = [];
  return {
    async all() {
      return [...rows].sort((a, b) => a.version - b.version);
    },
    async append(tariff) {
      if (rows.some((row) => row.version === tariff.version)) {
        throw new Error(`tariff version ${tariff.version} already exists`);
      }
      rows.push(tariff);
    },
  };
}
