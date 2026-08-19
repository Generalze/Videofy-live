/** @author masterzee001 */
/**
 * Durable room records — the Connect Reference half of the product model.
 *
 * A ROOM outlives any single Connect call: the registry survives restarts of
 * both this server and the Videofy gateway, while the room -> call mapping is
 * deliberately ephemeral (see live-calls.ts). Writes are atomic
 * temp-then-rename (house pattern) so a crash cannot truncate the registry,
 * and one writer runs at a time so two saves cannot land out of order.
 *
 * A damaged or absent file loads as empty: guessing at half a record could
 * resurrect an ended room or mangle a host-key hash into one that never
 * matches again.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const RoomModeSchema = z.enum(['normal', 'translated']);
export type RoomMode = z.infer<typeof RoomModeSchema>;

export const RoomRecordSchema = z
  .object({
    /** Public room id: "room_" + 12 random characters. */
    roomId: z.string().min(1),
    name: z.string().min(1).max(80),
    mode: RoomModeSchema,
    /** Optional ISO-8601 moment the host scheduled the room for. */
    scheduledFor: z.string().optional(),
    createdAt: z.string(),
    /** sha256 hex of the "host_..." host key; the key itself is never stored. */
    hostKeyHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Connect Reference-layer policy, enforced by the product web app. */
    transcriptDownloadAllowed: z.boolean(),
    /** Ended rooms persist as history; they can no longer be joined. */
    ended: z.boolean(),
    /**
     * SERVER-SIDE ONLY: the Connect call currently carrying this room, so a
     * Connect Reference restart re-adopts it instead of splitting the room
     * into two concurrent calls. Never serialized into any HTTP response —
     * toPublicRoom names its fields explicitly and this is not one of them.
     */
    liveCallId: z.string().optional(),
  })
  .strict();
export type RoomRecord = z.infer<typeof RoomRecordSchema>;

const SnapshotSchema = z
  .object({
    version: z.literal(1),
    rooms: z.array(RoomRecordSchema),
  })
  .strict();

export interface RoomUpdate {
  mode?: RoomMode;
  ended?: boolean;
  /** null clears the mapping; undefined leaves it untouched. */
  liveCallId?: string | null;
}

export interface RoomStore {
  /** Newest first. */
  list(): RoomRecord[];
  get(roomId: string): RoomRecord | undefined;
  create(record: RoomRecord): Promise<void>;
  update(roomId: string, patch: RoomUpdate): Promise<RoomRecord>;
}

export async function createFileRoomStore(filePath: string): Promise<RoomStore> {
  const target = resolve(filePath);
  const rooms = new Map<string, RoomRecord>();

  let raw: string | null = null;
  try {
    raw = await readFile(target, 'utf8');
  } catch {
    raw = null; // no file yet — a fresh registry
  }
  if (raw !== null) {
    try {
      const parsed = SnapshotSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        for (const record of parsed.data.rooms) rooms.set(record.roomId, record);
      }
    } catch {
      // Damaged file = no rooms. The next save writes a whole valid snapshot.
    }
  }

  let queue: Promise<void> = Promise.resolve();
  function persist(): Promise<void> {
    // Snapshot is captured NOW, in mutation order, so queued writes replay
    // the mutations faithfully even when several are in flight.
    const snapshot = { version: 1 as const, rooms: [...rooms.values()] };
    const write = queue.then(async () => {
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await rename(temporary, target);
    });
    queue = write.catch(() => {});
    return write;
  }

  return {
    list() {
      return [...rooms.values()].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.roomId.localeCompare(b.roomId),
      );
    },

    get(roomId) {
      return rooms.get(roomId);
    },

    async create(record) {
      if (rooms.has(record.roomId)) {
        throw new Error(`room ${record.roomId} already exists`);
      }
      rooms.set(record.roomId, record);
      await persist();
    },

    async update(roomId, patch) {
      const existing = rooms.get(roomId);
      if (existing === undefined) {
        throw new Error(`room ${roomId} does not exist`);
      }
      const updated: RoomRecord = {
        ...existing,
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
        ...(patch.ended !== undefined ? { ended: patch.ended } : {}),
      };
      if (patch.liveCallId === null) delete updated.liveCallId;
      else if (patch.liveCallId !== undefined) updated.liveCallId = patch.liveCallId;
      rooms.set(roomId, updated);
      await persist();
      return updated;
    },
  };
}
