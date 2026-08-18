/** @owner masterzee001 */
/**
 * The Connect project registry: who may call /v1, from which origins, and the
 * private mapping between public vc_ call ids and the gateway's internal ids.
 *
 * Two very different lifetimes live here on purpose, stated so nobody
 * "fixes" one to match the other:
 *
 * - Project records come from connect-projects.json, written by the
 *   provisioning script (hash-only; the raw vfk_ key is printed once at
 *   provisioning time and never stored). The file is read once at gateway
 *   startup. Absent file → the registry is DISABLED and /v1 says so; a
 *   MALFORMED file → this module throws and gateway startup fails visibly
 *   (R12) — a registry we cannot read is not a registry we half-trust.
 *
 * - The live-call map is in-memory and dies with the process (R13). That is
 *   the documented restart truth: outstanding join tokens fail closed on
 *   live-registry membership, and partners re-create calls.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { CallMetadata, CallMode, CallType } from '@videofy-live/connect-contracts';

export const CONNECT_PROJECT_ID_PREFIX = 'proj_';
export const CONNECT_PROJECT_KEY_PREFIX = 'vfk_';

const ProjectRecordSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  /** sha256 hex of the full raw key. Never the key itself. */
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** No wildcard origins, ever (R7). Exact string matches only. */
  allowedOrigins: z.array(z.string().min(1)),
  allowOriginless: z.boolean(),
  createdAt: z.string(),
  active: z.boolean(),
});
export type ConnectProjectRecord = z.infer<typeof ProjectRecordSchema>;

const ProjectsFileSchema = z.object({
  version: z.literal(1),
  projects: z.array(ProjectRecordSchema),
});
export type ConnectProjectsFile = z.infer<typeof ProjectsFileSchema>;

export type ConnectRegistryState =
  | { readonly status: 'active'; readonly registry: ConnectProjectRegistry }
  /** No registry file: /v1 is cleanly disabled, and the reason is printable. */
  | { readonly status: 'disabled'; readonly reason: string };

/**
 * Load the registry file. ENOENT is the one forgivable outcome (disabled
 * state); anything else — unreadable, unparseable, wrong shape — throws, so a
 * gateway with a broken registry fails at startup instead of running with a
 * half-understood authorization database.
 */
export function loadConnectProjectRegistry(filePath: string): ConnectRegistryState {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'disabled',
        reason: `no Connect project registry at ${filePath}`,
      };
    }
    throw new Error(
      `Connect project registry at ${filePath} could not be read: ${
        error instanceof Error ? error.message : 'unknown read failure'
      }`,
    );
  }
  return { status: 'active', registry: parseConnectProjectRegistry(raw, filePath) };
}

/** Parse registry JSON. Malformed content throws with the offending path named. */
export function parseConnectProjectRegistry(
  raw: string,
  sourceName: string,
): ConnectProjectRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Connect project registry at ${sourceName} is not valid JSON.`);
  }
  const result = ProjectsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Connect project registry at ${sourceName} is malformed: ${result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return new ConnectProjectRegistry(result.data.projects);
}

export type ConnectAuthenticationResult =
  | { readonly ok: true; readonly project: ConnectProjectRecord }
  /**
   * 'invalid-key' → AUTH_INVALID_KEY; 'inactive-project' → FORBIDDEN_PROJECT.
   * A real key on a deactivated project is a different conversation from a
   * key we have never seen.
   */
  | { readonly ok: false; readonly reason: 'invalid-key' | 'inactive-project' };

export class ConnectProjectRegistry {
  private readonly records: readonly ConnectProjectRecord[];

  constructor(records: readonly ConnectProjectRecord[]) {
    this.records = [...records];
  }

  /**
   * Authenticate a presented bearer key: sha256 the key once, then compare
   * against EVERY record with timingSafeEqual — no early exit on match, so the
   * comparison cost does not depend on which project (if any) the key belongs
   * to. Only after the sweep does active/inactive matter.
   */
  authenticate(bearerKey: string | null): ConnectAuthenticationResult {
    if (!bearerKey || !bearerKey.startsWith(CONNECT_PROJECT_KEY_PREFIX)) {
      return { ok: false, reason: 'invalid-key' };
    }
    const presented = Buffer.from(
      createHash('sha256').update(bearerKey, 'utf8').digest('hex'),
      'utf8',
    );
    let matched: ConnectProjectRecord | null = null;
    for (const record of this.records) {
      const stored = Buffer.from(record.keyHash, 'utf8');
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
        matched = matched ?? record;
      }
    }
    if (!matched) return { ok: false, reason: 'invalid-key' };
    if (!matched.active) return { ok: false, reason: 'inactive-project' };
    return { ok: true, project: matched };
  }

  getProject(projectId: string): ConnectProjectRecord | null {
    return this.records.find((record) => record.projectId === projectId) ?? null;
  }

  /**
   * R7: origin is AUTHORIZATION. Exact match against the project's list; a
   * missing origin passes only under an explicit allowOriginless. No wildcards.
   */
  isOriginAllowed(project: ConnectProjectRecord, origin: string | null): boolean {
    if (origin === null || origin === '') return project.allowOriginless;
    return project.allowedOrigins.includes(origin);
  }

  /** Union of ACTIVE projects' origins, for the Socket.IO CORS callback (R7: necessary, never sufficient). */
  activeOrigins(): string[] {
    const origins = new Set<string>();
    for (const record of this.records) {
      if (!record.active) continue;
      for (const origin of record.allowedOrigins) origins.add(origin);
    }
    return [...origins];
  }
}

/** One Connect call as the control plane tracks it. */
export interface ConnectLiveCallRecord {
  readonly publicCallId: string;
  /** Internal `connect_<proj8>_<rand12>` id. NEVER serialized into a /v1 response. */
  readonly internalCallId: string;
  readonly projectId: string;
  readonly callType: CallType;
  /** Best-known mode: updated on authority changes and final reads, seeded at create. */
  mode: CallMode;
  readonly createdAt: string;
  readonly metadata?: CallMetadata;
  /** Once true, the call is history: joins refuse CALL_ENDED, reads echo the last-known shape. */
  ended: boolean;
}

/**
 * The public↔internal call-id map, project-scoped. In-memory ONLY (R13):
 * a restart empties it, which is exactly what makes outstanding join tokens
 * die with the process — membership here is checked on every connect join.
 */
export class ConnectLiveCallRegistry {
  private readonly byPublic = new Map<string, ConnectLiveCallRecord>();
  private readonly byInternal = new Map<string, ConnectLiveCallRecord>();

  register(record: ConnectLiveCallRecord): void {
    if (this.byPublic.has(record.publicCallId) || this.byInternal.has(record.internalCallId)) {
      throw new Error('A Connect call with this id is already registered.');
    }
    this.byPublic.set(record.publicCallId, record);
    this.byInternal.set(record.internalCallId, record);
  }

  /**
   * Project-scoped lookup: a public id resolved under the WRONG project is a
   * miss, indistinguishable from a call that never existed — cross-project
   * probing learns nothing (R12 fail-closed).
   */
  lookup(projectId: string, publicCallId: string): ConnectLiveCallRecord | null {
    const record = this.byPublic.get(publicCallId);
    if (!record || record.projectId !== projectId) return null;
    return record;
  }

  lookupByInternalId(internalCallId: string): ConnectLiveCallRecord | null {
    return this.byInternal.get(internalCallId) ?? null;
  }

  markEnded(publicCallId: string): void {
    const record = this.byPublic.get(publicCallId);
    if (record) record.ended = true;
  }

  count(): number {
    return this.byPublic.size;
  }
}
