/** @author masterzee001 */
/**
 * A channel's persistent identity: who owns it, what it is called, how it is
 * found.
 *
 * Founder directive (LOCKED, 30 Aug 2026), OPERATOR CHANNEL IDENTITY: "every
 * entitled operator lands automatically on their own persistent channel";
 * "keep the opaque account-derived channelId internally"; "unique
 * human-readable @handle"; "CHANNEL (persistent identity) vs PROGRAMME (one
 * broadcast) are separate"; "persist outside gateway memory"; "never expose
 * fallback names like 'Channel abc123' when an identity exists".
 *
 * WHY THIS LIVES IN THE ACCOUNT SERVICE. A channel profile is a fact about a
 * PERSON'S standing identity -- it outlives every programme, every gateway
 * restart and every socket. The gateway owns the programme (what is on air)
 * and mirrors the one field it also decides, visibility, through the internal
 * seam. Nothing here knows whether a channel is live; discovery joins the two.
 *
 * THE OPAQUE ID STAYS THE KEY. The gateway derives channelId from the account
 * id under a per-deployment salt; the handle is an ALIAS resolving to that id.
 * Every room name, follow row and listener link built on the id keeps working
 * when the handle changes, which is what lets a handle be changeable at all.
 *
 * THE DEFAULT HANDLE IS THE USERNAME'S CHOSEN PART. A C7 username is
 * `c7<chosen>`; the prefix is on every account and distinguishes nobody, so
 * the channel handle is the part the person chose, with dots folded to
 * underscores. When that is reserved, too short or already held, a suffix
 * from the channel id makes it unique without ever producing a name that
 * looks like a fallback ("Channel abc123" is what the directive forbids; the
 * DISPLAY NAME is always the person's own).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHANNEL_DESCRIPTION_MAX_LENGTH,
  CHANNEL_DISPLAY_NAME_MAX_LENGTH,
  CHANNEL_HANDLE_MAX_LENGTH,
  channelAvatarPath,
  channelBannerPath,
  checkChannelHandle,
  isChannelCategory,
  isChannelVisibility,
  normaliseChannelHandle,
  type ChannelCategory,
  type ChannelProfile,
  type ChannelProfileUpdate,
  type ChannelVisibility,
  type PublicChannelProfile,
} from '@videofy-live/shared-types';

/* ---------------------------------------------------------------- username */

/**
 * Every C7 username begins with `c7` (packages/account-trust/src/username.ts,
 * USERNAME_PREFIX). That package does not export the prefix or its local-part
 * helper, so the strip is restated here and a test pins it against the real
 * checkUsernameShape, which is what keeps the two from drifting.
 */
const USERNAME_PREFIX = 'c7';

/** The part a person actually chose, with the prefix removed if present. */
function usernameLocalPart(username: string): string {
  const lowered = username.trim().toLowerCase();
  return lowered.startsWith(USERNAME_PREFIX) ? lowered.slice(USERNAME_PREFIX.length) : lowered;
}

/* ------------------------------------------------------------------ record */

/** One row of channel_profiles. The refs name a stored image; see ChannelImageStore. */
export interface ChannelProfileRecord {
  readonly channelId: string;
  readonly ownerAccountId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: ChannelCategory | null;
  readonly visibility: ChannelVisibility;
  /** A version token for the stored avatar, or null when there is none. */
  readonly avatarRef: string | null;
  readonly bannerRef: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type ChannelProfileInsertOutcome = 'inserted' | 'channel-exists' | 'owner-exists' | 'handle-taken';
export type ChannelProfileUpdateOutcome = 'updated' | 'missing' | 'handle-taken';

/**
 * Storage. Every implementation must enforce the three uniquenesses itself
 * -- channel id, owner, handle (case-insensitively) -- because an application
 * check races with itself across processes and a unique index cannot.
 */
export interface ChannelProfilePort {
  get(channelId: string): Promise<ChannelProfileRecord | null>;
  getMany(channelIds: readonly string[]): Promise<ReadonlyMap<string, ChannelProfileRecord>>;
  byOwner(ownerAccountId: string): Promise<ChannelProfileRecord | null>;
  /** Matched case-insensitively; handles are stored folded but a caller may not fold. */
  byHandle(handle: string): Promise<ChannelProfileRecord | null>;
  insert(record: ChannelProfileRecord): Promise<ChannelProfileInsertOutcome>;
  /** Replaces every column of the row with this channel id. */
  update(record: ChannelProfileRecord): Promise<ChannelProfileUpdateOutcome>;
}

export function createInMemoryChannelProfilePort(): ChannelProfilePort {
  const rows = new Map<string, ChannelProfileRecord>();
  const holderOfHandle = (handle: string): ChannelProfileRecord | null => {
    const wanted = handle.toLowerCase();
    for (const row of rows.values()) if (row.handle.toLowerCase() === wanted) return row;
    return null;
  };
  return {
    async get(channelId) {
      return rows.get(channelId) ?? null;
    },
    async getMany(channelIds) {
      const found = new Map<string, ChannelProfileRecord>();
      for (const id of channelIds) {
        const row = rows.get(id);
        if (row) found.set(id, row);
      }
      return found;
    },
    async byOwner(ownerAccountId) {
      for (const row of rows.values()) if (row.ownerAccountId === ownerAccountId) return row;
      return null;
    },
    async byHandle(handle) {
      return holderOfHandle(handle);
    },
    async insert(record) {
      if (rows.has(record.channelId)) return 'channel-exists';
      for (const row of rows.values()) {
        if (row.ownerAccountId === record.ownerAccountId) return 'owner-exists';
      }
      if (holderOfHandle(record.handle) !== null) return 'handle-taken';
      rows.set(record.channelId, record);
      return 'inserted';
    },
    async update(record) {
      if (!rows.has(record.channelId)) return 'missing';
      const holder = holderOfHandle(record.handle);
      if (holder !== null && holder.channelId !== record.channelId) return 'handle-taken';
      rows.set(record.channelId, record);
      return 'updated';
    },
  };
}

/* ------------------------------------------------------------------ images */

export type ChannelImageKind = 'avatar' | 'banner';

export interface StoredImage {
  readonly mime: string;
  readonly bytes: Buffer;
}

/**
 * Where channel pictures live. Bytes only; the profile row holds the ref that
 * says one exists, so a profile read never has to look at the filesystem.
 */
export interface ChannelImageStore {
  put(channelId: string, kind: ChannelImageKind, mime: string, bytes: Buffer): Promise<void>;
  get(channelId: string, kind: ChannelImageKind): Promise<StoredImage | null>;
  remove(channelId: string, kind: ChannelImageKind): Promise<void>;
}

export function createInMemoryChannelImageStore(): ChannelImageStore {
  const images = new Map<string, StoredImage>();
  const key = (channelId: string, kind: ChannelImageKind): string => `${kind} ${channelId}`;
  return {
    async put(channelId, kind, mime, bytes) {
      images.set(key(channelId, kind), { mime, bytes });
    },
    async get(channelId, kind) {
      return images.get(key(channelId, kind)) ?? null;
    },
    async remove(channelId, kind) {
      images.delete(key(channelId, kind));
    },
  };
}

/**
 * The same types, extensions and file-is-the-state layout as account avatars
 * (avatar-routes.ts): one file per channel per kind, named by the channel id,
 * with the extension recording the type. `<dir>/avatars/<id>.png`.
 */
const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Channel ids are minted by the gateway; anything else in a path is a probe. */
const SAFE_CHANNEL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function createFileChannelImageStore(dir: string): ChannelImageStore {
  const folder = (kind: ChannelImageKind): string => join(dir, `${kind}s`);
  const pathFor = (kind: ChannelImageKind, channelId: string, extension: string): string =>
    join(folder(kind), `${channelId}.${extension}`);
  const findExisting = async (
    channelId: string,
    kind: ChannelImageKind,
  ): Promise<{ path: string; mime: string } | null> => {
    if (!SAFE_CHANNEL_ID.test(channelId)) return null;
    for (const [mime, extension] of Object.entries(EXTENSION)) {
      const path = pathFor(kind, channelId, extension);
      try {
        await stat(path);
        return { path, mime };
      } catch {
        // Not this extension; the next may exist.
      }
    }
    return null;
  };
  return {
    async put(channelId, kind, mime, bytes) {
      if (!SAFE_CHANNEL_ID.test(channelId)) throw new Error('Not a channel id.');
      await mkdir(folder(kind), { recursive: true });
      // A change of format must not leave the old file behind as the answer.
      const previous = await findExisting(channelId, kind);
      if (previous !== null) await unlink(previous.path).catch(() => undefined);
      await writeFile(pathFor(kind, channelId, EXTENSION[mime] ?? 'jpg'), bytes);
    },
    async get(channelId, kind) {
      const existing = await findExisting(channelId, kind);
      if (existing === null) return null;
      return { mime: existing.mime, bytes: await readFile(existing.path) };
    },
    async remove(channelId, kind) {
      const existing = await findExisting(channelId, kind);
      if (existing !== null) await unlink(existing.path).catch(() => undefined);
    },
  };
}

/* ---------------------------------------------------------- default handle */

/**
 * The handle a username suggests, or null when nothing usable survives.
 *
 * `c7zoe.meak` -> `zoe_meak`. The C7 prefix goes because it is on every
 * account; a dot becomes an underscore because the handle alphabet has no
 * dots; a reserved or too-short result gets `_channel` so `c7main` lands on
 * `main_channel` rather than on the platform channel.
 */
export function deriveChannelHandle(username: string): string | null {
  const local = usernameLocalPart(username);
  const slug = local
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, CHANNEL_HANDLE_MAX_LENGTH);
  const direct = checkChannelHandle(slug);
  if (direct.ok) return direct.handle;
  if (direct.reason === 'reserved' || direct.reason === 'too-short') {
    const padded = checkChannelHandle(`${slug}_channel`.slice(0, CHANNEL_HANDLE_MAX_LENGTH));
    if (padded.ok) return padded.handle;
  }
  return null;
}

/**
 * The handles to try, in order, when claiming a channel: the username's own,
 * then the same with a piece of the (opaque, unique) channel id, so two
 * usernames that fold to one slug both get a handle without a round trip
 * to a person.
 */
export function defaultChannelHandleCandidates(username: string | null, channelId: string): string[] {
  const idPart = channelId.toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = username === null ? null : deriveChannelHandle(username);
  const withSuffix = (stem: string, length: number): string => {
    const suffix = idPart.slice(0, length).padEnd(length, '0');
    return `${stem.slice(0, CHANNEL_HANDLE_MAX_LENGTH - length - 1)}_${suffix}`;
  };
  if (base === null) {
    return [withSuffix('ch', 12), withSuffix('ch', 16)];
  }
  return [base, withSuffix(base, 4), withSuffix(base, 8)];
}

/* ------------------------------------------------------------- validation */

export type ChannelProfileValidation =
  | { readonly ok: true; readonly patch: ChannelProfileUpdate }
  | { readonly ok: false; readonly message: string };

/**
 * The owner's edit, checked field by field with the exact rule broken named.
 * Unknown fields are ignored so an older console can send a newer body.
 */
export function validateChannelProfileUpdate(body: unknown): ChannelProfileValidation {
  const input = (body ?? {}) as Record<string, unknown>;
  const patch: {
    handle?: string;
    displayName?: string;
    description?: string;
    category?: ChannelCategory | null;
    visibility?: ChannelVisibility;
  } = {};

  if (input['handle'] !== undefined) {
    if (typeof input['handle'] !== 'string') return { ok: false, message: 'handle must be text.' };
    const check = checkChannelHandle(input['handle']);
    if (!check.ok) return { ok: false, message: check.message };
    patch.handle = check.handle;
  }
  if (input['displayName'] !== undefined) {
    if (typeof input['displayName'] !== 'string') {
      return { ok: false, message: 'displayName must be text.' };
    }
    const displayName = input['displayName'].trim();
    if (displayName.length === 0) return { ok: false, message: 'Give the channel a name.' };
    if (displayName.length > CHANNEL_DISPLAY_NAME_MAX_LENGTH) {
      return {
        ok: false,
        message: `Channel names are at most ${CHANNEL_DISPLAY_NAME_MAX_LENGTH} characters.`,
      };
    }
    patch.displayName = displayName;
  }
  if (input['description'] !== undefined) {
    if (typeof input['description'] !== 'string') {
      return { ok: false, message: 'description must be text.' };
    }
    const description = input['description'].trim();
    if (description.length > CHANNEL_DESCRIPTION_MAX_LENGTH) {
      return {
        ok: false,
        message: `Descriptions are at most ${CHANNEL_DESCRIPTION_MAX_LENGTH} characters.`,
      };
    }
    patch.description = description;
  }
  if (input['category'] !== undefined) {
    if (input['category'] !== null && !isChannelCategory(input['category'])) {
      return { ok: false, message: 'Choose a category from the list.' };
    }
    patch.category = input['category'];
  }
  if (input['visibility'] !== undefined) {
    if (!isChannelVisibility(input['visibility'])) {
      return { ok: false, message: 'Visibility is public, private or locked.' };
    }
    patch.visibility = input['visibility'];
  }
  return { ok: true, patch };
}

/* ------------------------------------------------------------------ wire */

function imageUrl(path: string, ref: string | null): string | null {
  return ref === null ? null : `${path}?v=${encodeURIComponent(ref)}`;
}

/** The owner's / platform's view. */
export function toChannelProfile(record: ChannelProfileRecord): ChannelProfile {
  return {
    channelId: record.channelId,
    ownerAccountId: record.ownerAccountId,
    handle: record.handle,
    displayName: record.displayName,
    description: record.description,
    category: record.category,
    visibility: record.visibility,
    avatarUrl: imageUrl(channelAvatarPath(record.channelId), record.avatarRef),
    bannerUrl: imageUrl(channelBannerPath(record.channelId), record.bannerRef),
    createdAt: record.createdAtMs,
    updatedAt: record.updatedAtMs,
  };
}

/**
 * Anybody's view. Built field by field rather than by deleting the owner
 * from the full shape, so a field added to the record later is public only
 * when somebody decides it is.
 */
export function toPublicChannelProfile(record: ChannelProfileRecord): PublicChannelProfile {
  return {
    channelId: record.channelId,
    handle: record.handle,
    displayName: record.displayName,
    description: record.description,
    category: record.category,
    visibility: record.visibility,
    avatarUrl: imageUrl(channelAvatarPath(record.channelId), record.avatarRef),
    bannerUrl: imageUrl(channelBannerPath(record.channelId), record.bannerRef),
  };
}

/* ---------------------------------------------------------------- service */

export interface ClaimChannelInput {
  readonly channelId: string;
  readonly ownerAccountId: string;
  /** The owner's C7 username, when they have one; the default handle comes from it. */
  readonly username: string | null;
  /** The owner's chosen display name, when they have one. */
  readonly displayName: string | null;
}

export type ClaimChannelResult =
  | { readonly ok: true; readonly profile: ChannelProfileRecord; readonly created: boolean }
  | { readonly ok: false; readonly reason: 'channel-owned-elsewhere' | 'owner-has-another-channel' };

export type UpdateChannelResult =
  | { readonly ok: true; readonly profile: ChannelProfileRecord }
  | { readonly ok: false; readonly reason: 'no-channel' | 'invalid' | 'handle-taken'; readonly message: string };

export interface ChannelProfilesDependencies {
  readonly port: ChannelProfilePort;
  readonly images: ChannelImageStore;
  readonly nowMs?: () => number;
}

export class ChannelProfiles {
  private readonly port: ChannelProfilePort;
  private readonly images: ChannelImageStore;
  private readonly nowMs: () => number;

  constructor(deps: ChannelProfilesDependencies) {
    this.port = deps.port;
    this.images = deps.images;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  /**
   * Create the profile for an operator's channel if it does not exist yet.
   *
   * IDEMPOTENT. The gateway calls this every time an entitled operator lands
   * on their channel, and every call after the first answers with the same
   * row -- the directive says operators land "automatically", and a landing
   * must not depend on remembering whether it is the first.
   */
  async claim(input: ClaimChannelInput): Promise<ClaimChannelResult> {
    const settled = await this.settledClaim(input);
    if (settled !== null) return settled;

    const now = this.nowMs();
    const displayName = this.defaultDisplayName(input);
    for (const handle of defaultChannelHandleCandidates(input.username, input.channelId)) {
      const outcome = await this.port.insert({
        channelId: input.channelId,
        ownerAccountId: input.ownerAccountId,
        handle,
        displayName,
        description: '',
        category: null,
        visibility: 'public',
        avatarRef: null,
        bannerRef: null,
        createdAtMs: now,
        updatedAtMs: now,
      });
      if (outcome === 'handle-taken') continue;
      if (outcome === 'inserted') {
        const created = await this.port.get(input.channelId);
        if (created !== null) return { ok: true, profile: created, created: true };
      }
      // channel-exists / owner-exists: a concurrent claim won the race, or the
      // row belongs to somebody else. Either way the settled answer decides.
      const raced = await this.settledClaim(input);
      if (raced !== null) return raced;
    }
    // Every candidate handle taken: only possible against a deliberate
    // squat on id-suffixed handles. Answer as a conflict rather than invent.
    return { ok: false, reason: 'owner-has-another-channel' };
  }

  /** The answer when a row for this owner or this channel already exists. */
  private async settledClaim(input: ClaimChannelInput): Promise<ClaimChannelResult | null> {
    const mine = await this.port.byOwner(input.ownerAccountId);
    if (mine !== null) {
      return mine.channelId === input.channelId
        ? { ok: true, profile: mine, created: false }
        : { ok: false, reason: 'owner-has-another-channel' };
    }
    const held = await this.port.get(input.channelId);
    if (held !== null) return { ok: false, reason: 'channel-owned-elsewhere' };
    return null;
  }

  /**
   * The person's own name, then their chosen username part, then the word
   * "Channel" -- which only ever appears for an account with no identity at
   * all, which registration does not produce. Never "Channel abc123".
   */
  private defaultDisplayName(input: ClaimChannelInput): string {
    const chosen = input.displayName?.trim() ?? '';
    if (chosen.length > 0) return chosen.slice(0, CHANNEL_DISPLAY_NAME_MAX_LENGTH);
    const local = input.username === null ? '' : usernameLocalPart(input.username);
    return local.length > 0 ? local.slice(0, CHANNEL_DISPLAY_NAME_MAX_LENGTH) : 'Channel';
  }

  mine(ownerAccountId: string): Promise<ChannelProfileRecord | null> {
    return this.port.byOwner(ownerAccountId);
  }

  byId(channelId: string): Promise<ChannelProfileRecord | null> {
    return this.port.get(channelId);
  }

  byIds(channelIds: readonly string[]): Promise<ReadonlyMap<string, ChannelProfileRecord>> {
    return this.port.getMany(channelIds);
  }

  byHandle(handle: string): Promise<ChannelProfileRecord | null> {
    return this.port.byHandle(normaliseChannelHandle(handle));
  }

  /** The owner's edit. Only the owner reaches here: the row is found by their id. */
  async update(ownerAccountId: string, body: unknown): Promise<UpdateChannelResult> {
    const validation = validateChannelProfileUpdate(body);
    if (!validation.ok) return { ok: false, reason: 'invalid', message: validation.message };
    const current = await this.port.byOwner(ownerAccountId);
    if (current === null) {
      return { ok: false, reason: 'no-channel', message: 'You do not have a channel yet.' };
    }
    const patch = validation.patch;
    const next: ChannelProfileRecord = {
      ...current,
      ...(patch.handle !== undefined ? { handle: patch.handle } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      updatedAtMs: this.nowMs(),
    };
    return this.store(next);
  }

  /** The gateway mirrors the visibility it decides. Owner check is the caller's. */
  async setVisibility(channelId: string, visibility: ChannelVisibility): Promise<UpdateChannelResult> {
    const current = await this.port.get(channelId);
    if (current === null) return { ok: false, reason: 'no-channel', message: 'No such channel.' };
    return this.store({ ...current, visibility, updatedAtMs: this.nowMs() });
  }

  /** Store the bytes and stamp a new ref, so every URL for the old picture stops matching. */
  async setImage(
    ownerAccountId: string,
    kind: ChannelImageKind,
    mime: string,
    bytes: Buffer,
  ): Promise<UpdateChannelResult> {
    const current = await this.port.byOwner(ownerAccountId);
    if (current === null) {
      return { ok: false, reason: 'no-channel', message: 'You do not have a channel yet.' };
    }
    await this.images.put(current.channelId, kind, mime, bytes);
    const ref = randomBytes(6).toString('hex');
    return this.store({
      ...current,
      ...(kind === 'avatar' ? { avatarRef: ref } : { bannerRef: ref }),
      updatedAtMs: this.nowMs(),
    });
  }

  async clearImage(ownerAccountId: string, kind: ChannelImageKind): Promise<UpdateChannelResult> {
    const current = await this.port.byOwner(ownerAccountId);
    if (current === null) {
      return { ok: false, reason: 'no-channel', message: 'You do not have a channel yet.' };
    }
    await this.images.remove(current.channelId, kind);
    return this.store({
      ...current,
      ...(kind === 'avatar' ? { avatarRef: null } : { bannerRef: null }),
      updatedAtMs: this.nowMs(),
    });
  }

  image(channelId: string, kind: ChannelImageKind): Promise<StoredImage | null> {
    return this.images.get(channelId, kind);
  }

  private async store(next: ChannelProfileRecord): Promise<UpdateChannelResult> {
    const outcome = await this.port.update(next);
    if (outcome === 'handle-taken') {
      return { ok: false, reason: 'handle-taken', message: 'That handle is taken.' };
    }
    if (outcome === 'missing') {
      return { ok: false, reason: 'no-channel', message: 'No such channel.' };
    }
    return { ok: true, profile: next };
  }
}
