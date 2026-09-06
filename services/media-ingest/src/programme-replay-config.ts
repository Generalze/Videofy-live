/** @author masterzee001 */
/**
 * What this deployment does about Replay, read once, explicitly.
 *
 * NOTHING IS SELECTED BY ACCIDENT. Replay is off unless somebody says
 * `REPLAY_ENABLED=true`, and even then a backend must be named: there is no
 * "well, a directory exists, so presumably filesystem". A deployment that
 * quietly started recording every broadcast because an environment variable
 * happened to be present would be keeping people's video on the strength of an
 * accident, and the first anybody would know is a storage bill or a subject
 * access request.
 *
 * IT FAILS CLOSED FOR REPLAY AND NEVER FOR LIVE. Every problem below produces a
 * REFUSAL -- a sentence naming what is wrong -- rather than a throw. Replay is
 * an optional subsystem; a typo in a bucket name must degrade recording, not
 * stop a broadcast going out. `index.ts` reads the refusal, logs it, and starts
 * the service without Replay.
 *
 * AND NO DEFAULTS THAT DECIDE ANYTHING. There is no default retention here, no
 * default visibility, no default grace and no default cadence: those are
 * product and operational decisions, and this file's job is to report what was
 * chosen, not to choose. The one thing it does supply is a batch size, which is
 * the shape of one pass rather than a decision about anybody's recording -- and
 * even that is overridable.
 *
 * CREDENTIALS ARE READ AND NEVER REPEATED. They live in the resolved object and
 * are handed to the store; `describeReplayConfig` exists so a log line can say
 * what this deployment is doing without saying who it is doing it as.
 */

import { resolve as resolvePath } from 'node:path';

export type ReplayBackendKind = 'filesystem' | 'object';

export interface ReplayObjectConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

export interface ReplayWorkerConfig {
  /**
   * How long after the logical cutoff bytes may still be held.
   *
   * REQUIRED, WITH NO DEFAULT, because the domain refuses to invent one and so
   * does this. Zero is a perfectly good answer and it has to be somebody's.
   */
  readonly cleanupGraceMs: number;
  readonly intervalMs: number;
  readonly batchLimit: number;
}

export interface ReplayComposition {
  readonly enabled: true;
  readonly backend: ReplayBackendKind;
  /** Present exactly when the backend is `filesystem`. */
  readonly filesystemRoot: string | null;
  /** Present exactly when the backend is `object`. */
  readonly object: ReplayObjectConfig | null;
  readonly worker: ReplayWorkerConfig;
  /**
   * Where the resolved retention policy is asked for.
   *
   * The account service owns the persisted channel settings and programme
   * overrides; this is the internal seam to them. Absent, Replay cannot resolve
   * a policy and therefore cannot begin a recording -- which is a refusal, not
   * a guess.
   */
  readonly accountInternalUrl: string;
  readonly internalToken: string;
}

/**
 * DISCRIMINATED ON `kind`, not on the shape of the payload.
 *
 * "Nobody asked for Replay" and "somebody asked and got it wrong" are both
 * `enabled: false` and they call for opposite responses -- silence, and an
 * alarm. Telling them apart by which optional field happens to be present is
 * the sort of distinction a compiler cannot help with and a refactor loses.
 */
export type ReplayConfigOutcome =
  | { readonly enabled: false; readonly kind: 'off'; readonly detail: string }
  | { readonly enabled: false; readonly kind: 'misconfigured'; readonly detail: string }
  | { readonly enabled: true; readonly value: ReplayComposition };

/** Whether an outcome is a misconfiguration rather than a deliberate absence. */
export function isReplayRefusal(outcome: ReplayConfigOutcome): boolean {
  return !outcome.enabled && outcome.kind === 'misconfigured';
}

function text(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

function wholeNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  bounds: { readonly min: number; readonly max: number },
): number | string {
  const raw = text(env, name);
  if (raw === null) return `${name} is required and was not set`;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    return `${name} must be a whole number between ${bounds.min} and ${bounds.max}`;
  }
  return parsed;
}

/**
 * Read the Replay deployment decision, or say why there isn't a usable one.
 *
 * THREE OUTCOMES, AND THEY ARE NOT THE SAME THING:
 *
 *   `enabled: false, reason` -- nobody asked for Replay. Ordinary, silent, and
 *   the state every deployment is in until somebody turns it on.
 *
 *   `enabled: false, refusal` -- somebody asked for Replay and the configuration
 *   does not describe a usable one. That is an operator's mistake and it gets
 *   said out loud, because the failure mode of treating it as the first case is
 *   a deployment that believes it is recording and is not.
 *
 *   `enabled: true, value` -- what to build.
 */
export function readReplayConfig(env: NodeJS.ProcessEnv = process.env): ReplayConfigOutcome {
  const flag = text(env, 'REPLAY_ENABLED');
  if (flag === null || flag.toLowerCase() !== 'true') {
    return { enabled: false, kind: 'off', detail: 'REPLAY_ENABLED is not true' };
  }

  const backend = text(env, 'REPLAY_BACKEND');
  if (backend !== 'filesystem' && backend !== 'object') {
    return {
      enabled: false,
      kind: 'misconfigured',
      detail:
        'REPLAY_BACKEND must be exactly "filesystem" or "object"; a backend is never chosen for you',
    };
  }

  const accountInternalUrl = text(env, 'REPLAY_ACCOUNT_INTERNAL_URL');
  if (accountInternalUrl === null) {
    return {
      enabled: false,
      kind: 'misconfigured',
      detail:
        'REPLAY_ACCOUNT_INTERNAL_URL is required: without it no retention policy can be resolved, and Replay never guesses one',
    };
  }
  const internalToken = text(env, 'INTERNAL_WEBRTC_TOKEN');
  if (internalToken === null) {
    return {
      enabled: false,
      kind: 'misconfigured',
      detail:
        'INTERNAL_WEBRTC_TOKEN is required: the policy seam is authenticated with the existing internal-service token',
    };
  }

  const cleanupGraceMs = wholeNumber(env, 'REPLAY_CLEANUP_GRACE_MS', {
    min: 0,
    max: 365 * 86_400_000,
  });
  if (typeof cleanupGraceMs === 'string') return { enabled: false, kind: 'misconfigured', detail: cleanupGraceMs };

  const intervalMs = wholeNumber(env, 'REPLAY_WORKER_INTERVAL_MS', {
    min: 1_000,
    max: 24 * 3_600_000,
  });
  if (typeof intervalMs === 'string') return { enabled: false, kind: 'misconfigured', detail: intervalMs };

  const batchRaw = text(env, 'REPLAY_WORKER_BATCH');
  const batchLimit = batchRaw === null ? 50 : Number(batchRaw);
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 500) {
    return {
      enabled: false,
      kind: 'misconfigured',
      detail: 'REPLAY_WORKER_BATCH must be a whole number between 1 and 500',
    };
  }

  const worker: ReplayWorkerConfig = { cleanupGraceMs, intervalMs, batchLimit };

  if (backend === 'filesystem') {
    const root = text(env, 'REPLAY_ROOT');
    if (root === null) {
      return {
        enabled: false,
        kind: 'misconfigured',
        detail: 'REPLAY_BACKEND=filesystem requires REPLAY_ROOT, and it is never inferred',
      };
    }
    return {
      enabled: true,
      value: {
        enabled: true,
        backend,
        filesystemRoot: resolvePath(root),
        object: null,
        worker,
        accountInternalUrl,
        internalToken,
      },
    };
  }

  const missing = (
    ['REPLAY_S3_ENDPOINT', 'REPLAY_S3_REGION', 'REPLAY_S3_BUCKET', 'REPLAY_S3_ACCESS_KEY_ID', 'REPLAY_S3_SECRET_ACCESS_KEY'] as const
  ).filter((name) => text(env, name) === null);
  if (missing.length > 0) {
    /*
     * NAMES ONLY, NEVER VALUES. This sentence reaches a log, and a log that
     * quoted the ones that WERE set would quote a secret the day somebody sets
     * four of the five.
     */
    return {
      enabled: false,
      kind: 'misconfigured',
      detail: `REPLAY_BACKEND=object requires ${missing.join(', ')}`,
    };
  }

  return {
    enabled: true,
    value: {
      enabled: true,
      backend,
      filesystemRoot: null,
      object: {
        endpoint: text(env, 'REPLAY_S3_ENDPOINT') ?? '',
        region: text(env, 'REPLAY_S3_REGION') ?? '',
        bucket: text(env, 'REPLAY_S3_BUCKET') ?? '',
        accessKeyId: text(env, 'REPLAY_S3_ACCESS_KEY_ID') ?? '',
        secretAccessKey: text(env, 'REPLAY_S3_SECRET_ACCESS_KEY') ?? '',
        // Path style unless a deployment explicitly asks for virtual host,
        // because path style works everywhere and needs no wildcard DNS.
        forcePathStyle: text(env, 'REPLAY_S3_FORCE_PATH_STYLE') !== 'false',
      },
      worker,
      accountInternalUrl,
      internalToken,
    },
  };
}

/**
 * What this deployment is doing about Replay, safe to log and safe to serve.
 *
 * NO CREDENTIAL, NO BUCKET, NO ENDPOINT, NO PATH. A health endpoint is reachable
 * by more people than an operator expects, and "which bucket" and "which volume"
 * are facts about the infrastructure rather than about whether Replay works. The
 * backend NAME is enough for anybody diagnosing this, and it identifies nothing.
 */
export function describeReplayConfig(outcome: ReplayConfigOutcome): Record<string, string> {
  if (outcome.enabled) {
    return {
      replay: 'enabled',
      backend: outcome.value.backend,
      cleanupGraceMs: String(outcome.value.worker.cleanupGraceMs),
      workerIntervalMs: String(outcome.value.worker.intervalMs),
    };
  }
  return { replay: outcome.kind, detail: outcome.detail };
}
