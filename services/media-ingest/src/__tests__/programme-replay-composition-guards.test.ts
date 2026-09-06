/** @author masterzee001 */
/**
 * The three composition guards that decide who watches and what gets recorded.
 *
 * WRITTEN BECAUSE A MUTATION RUN FOUND THEM UNTESTED. Each of these was
 * reasoned about carefully, commented at length, and covered by nothing: the
 * configuration that chooses a backend, the probe that decides whether an
 * object provider may carry recordings, and the authority that decides who may
 * watch one. Deleting any of them left every suite green, which is exactly the
 * shape of a defect that reaches production intact.
 */
import express from 'express';
import { describe, expect, it } from 'vitest';
import type { ReplayRecord } from '@videofy-live/programme-replay';
import { InMemoryObjectStore } from '@videofy-live/programme-replay/object';
import { readReplayConfig } from '../programme-replay-config.js';
import { startReplay } from '../programme-replay-startup.js';
import { createReplayAudienceAccess } from '../programme-replay-audience.js';
import type { AudienceVerdict } from '../programme-egress-routes.js';

/* ======================================================= the configuration */

const COMPLETE = {
  REPLAY_ENABLED: 'true',
  REPLAY_BACKEND: 'filesystem',
  REPLAY_ROOT: '/var/lib/videofy/replay',
  REPLAY_ACCOUNT_INTERNAL_URL: 'http://account:3006',
  INTERNAL_WEBRTC_TOKEN: 'internal-token',
  REPLAY_CLEANUP_GRACE_MS: '0',
  REPLAY_WORKER_INTERVAL_MS: '900000',
} satisfies NodeJS.ProcessEnv;

describe('nothing about Replay is selected by accident', () => {
  it('is off unless somebody says so exactly', () => {
    for (const flag of [undefined, '', 'false', '1', 'yes', 'TRUE ']) {
      const outcome = readReplayConfig({ ...COMPLETE, REPLAY_ENABLED: flag });
      // `TRUE ` trims to TRUE and lowercases to true, which IS asking for it.
      expect(outcome.enabled, String(flag)).toBe(flag === 'TRUE ');
    }
  });

  it('REFUSES to pick a backend, and says so rather than going quiet', () => {
    /*
     * THE MUTATION THIS CLOSES defaulted the backend to filesystem. A
     * deployment that quietly started recording every broadcast because a
     * variable was absent would be keeping people's video on the strength of an
     * accident, and the first anybody would know is a storage bill.
     */
    for (const backend of [undefined, '', 'FILESYSTEM', 's3', 'disk']) {
      const outcome = readReplayConfig({ ...COMPLETE, REPLAY_BACKEND: backend });
      expect(outcome.enabled, String(backend)).toBe(false);
      if (outcome.enabled) throw new Error('unreachable');
      expect(outcome.kind).toBe('misconfigured');
      expect(outcome.detail).toContain('never chosen for you');
    }
  });

  it('tells "nobody asked" apart from "somebody asked and got it wrong"', () => {
    // They are both `enabled: false` and they call for opposite responses:
    // silence, and an alarm.
    const off = readReplayConfig({});
    const wrong = readReplayConfig({ ...COMPLETE, REPLAY_ROOT: undefined });
    expect(off.enabled).toBe(false);
    expect(wrong.enabled).toBe(false);
    if (off.enabled || wrong.enabled) throw new Error('unreachable');
    expect(off.kind).toBe('off');
    expect(wrong.kind).toBe('misconfigured');
  });

  it('requires an explicit root, a grace and a cadence, with no defaults', () => {
    for (const missing of [
      'REPLAY_ROOT',
      'REPLAY_ACCOUNT_INTERNAL_URL',
      'INTERNAL_WEBRTC_TOKEN',
      'REPLAY_CLEANUP_GRACE_MS',
      'REPLAY_WORKER_INTERVAL_MS',
    ] as const) {
      const outcome = readReplayConfig({ ...COMPLETE, [missing]: undefined });
      expect(outcome.enabled, missing).toBe(false);
    }
    // Zero grace is a perfectly good answer and must be accepted as one.
    expect(readReplayConfig({ ...COMPLETE, REPLAY_CLEANUP_GRACE_MS: '0' }).enabled).toBe(true);
  });

  it('names the missing object settings without quoting the ones that were set', () => {
    /*
     * A SENTENCE THAT REACHES A LOG. Quoting the values that WERE present would
     * quote a secret the day somebody sets four of the five.
     */
    const outcome = readReplayConfig({
      ...COMPLETE,
      REPLAY_BACKEND: 'object',
      REPLAY_S3_ENDPOINT: 'https://s3.example',
      REPLAY_S3_REGION: 'eu-central-1',
      REPLAY_S3_BUCKET: 'replays',
      REPLAY_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    });
    expect(outcome.enabled).toBe(false);
    if (outcome.enabled) throw new Error('unreachable');
    expect(outcome.detail).toContain('REPLAY_S3_SECRET_ACCESS_KEY');
    expect(outcome.detail).not.toContain('AKIAEXAMPLE');
    expect(outcome.detail).not.toContain('s3.example');
  });
});

/* ========================================================= the object gate */

describe('an object provider must earn its place before it carries anything', () => {
  const objectEnv = {
    ...COMPLETE,
    REPLAY_BACKEND: 'object',
    REPLAY_ROOT: undefined,
    REPLAY_S3_ENDPOINT: 'http://store.invalid',
    REPLAY_S3_REGION: 'us-east-1',
    REPLAY_S3_BUCKET: 'replays',
    REPLAY_S3_ACCESS_KEY_ID: 'key',
    REPLAY_S3_SECRET_ACCESS_KEY: 'secret',
  };

  it('declines a provider that cannot be reached, and does not throw', async () => {
    /*
     * DEGRADED, NOT FAILED. A thrown error at module scope in a media service
     * is a broadcast that does not happen over a recording that would not have.
     */
    const config = readReplayConfig(objectEnv);
    expect(config.enabled).toBe(true);
    if (!config.enabled) throw new Error('unreachable');
    const startup = await startReplay(config.value);
    expect(startup.ready).toBe(false);
    if (startup.ready) throw new Error('unreachable');
    expect(startup.detail.length).toBeGreaterThan(0);
  });

  it('names no endpoint, bucket or credential in what it reports', async () => {
    const config = readReplayConfig(objectEnv);
    if (!config.enabled) throw new Error('unreachable');
    const startup = await startReplay(config.value);
    if (startup.ready) throw new Error('unreachable');
    for (const forbidden of ['store.invalid', 'replays', 'secret', 'http://']) {
      expect(startup.detail, forbidden).not.toContain(forbidden);
    }
  });

  it('a filesystem backend opens, and pairs its own delivery with it', async () => {
    /*
     * PAIRED, ALWAYS. A filesystem archive with object delivery would find
     * nothing; an object archive with filesystem delivery would refuse every
     * reference. Both fail silently until somebody presses play weeks later.
     */
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'videofy-startup-'));
    try {
      const config = readReplayConfig({ ...COMPLETE, REPLAY_ROOT: root });
      if (!config.enabled) throw new Error('unreachable');
      const startup = await startReplay(config.value);
      expect(startup.ready).toBe(true);
      if (!startup.ready) throw new Error('unreachable');
      expect(startup.backend.kind).toBe('filesystem');
      // The candidate source is the archive itself: maintenance reads the
      // archive's own state and never a catalogue.
      expect(startup.backend.candidates).toBe(startup.backend.archive);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('DECLINES a provider that fails the gate, even though the store answers', async () => {
    /*
     * THE MUTATION THIS CLOSES removed the `!verdict.usable` branch, so a
     * provider that ignores conditional creation would have carried recordings.
     * The earlier version of this suite only proved an UNREACHABLE store is
     * declined -- which the probe's own failure would have produced anyway.
     * This one answers every request perfectly and simply lies about the
     * conditional, so the only thing that can refuse it is the gate.
     */
    const ignoring = new InMemoryObjectStore({ ignoreConditionals: true });
    const startup = await startReplay({
      enabled: true,
      backend: 'object',
      filesystemRoot: null,
      object: {
        endpoint: 'http://store.invalid',
        region: 'us-east-1',
        bucket: 'replays',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        forcePathStyle: true,
      },
      worker: { cleanupGraceMs: 0, intervalMs: 900_000, batchLimit: 50 },
      accountInternalUrl: 'http://account:3006',
      internalToken: 'internal-token',
      // The store is supplied so the gate is the only thing that can refuse.
      __storeForTests: ignoring,
    } as never);
    expect(startup.ready).toBe(false);
    if (startup.ready) throw new Error('unreachable');
    expect(startup.detail).toContain('may not carry replay');
    expect(startup.detail).toContain('If-None-Match is not honoured');
  });

  it('the modelled store passes the same probe the real one is held to', async () => {
    // A guard against the probe silently becoming a no-op: a store that
    // honours the conditional must actually pass.
    const { probeObjectCapability } = await import('@videofy-live/programme-replay/object');
    expect(await probeObjectCapability({ store: new InMemoryObjectStore() })).toEqual({
      usable: true,
    });
    expect(
      (await probeObjectCapability({ store: new InMemoryObjectStore({ ignoreConditionals: true }) }))
        .usable,
    ).toBe(false);
  });
});

/* ==================================================== the audience authority */

describe('channel authority first, and the replay tier only ever narrows it', () => {
  function record(visibility: ReplayRecord['visibility']): ReplayRecord {
    return {
      identity: { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_a' },
      retention: { policy: 'keep' },
      visibility,
      status: 'available',
      startedAtMs: 0,
      finalisedAtMs: 1,
      expiresAtMs: null,
      segments: [],
      initialisations: [],
      bytes: 0,
      failure: null,
      history: [],
    };
  }

  function access(
    channelVerdict: AudienceVerdict | 'throw',
    options: { operator?: boolean } = {},
  ) {
    return createReplayAudienceAccess({
      channel: {
        async mayView() {
          if (channelVerdict === 'throw') throw new Error('the authority is away');
          return channelVerdict;
        },
      },
      authenticate: () => (options.operator === true ? 'acct_1' : null),
      entitlement: {
        hasEntitlement: () => options.operator === true,
        allowedCount: options.operator === true ? 1 : 0,
      },
    });
  }

  const request = {} as express.Request;

  it('refuses every replay tier when the channel refuses', async () => {
    /*
     * THE BYPASS THIS FORBIDS. A `public` replay on a channel nobody may reach
     * is not public: replay visibility is an ADDITIONAL permission on a stored
     * object, never a way around the door.
     */
    for (const visibility of ['public', 'unlisted', 'private'] as const) {
      const verdict = await access('forbidden').mayView(record(visibility), request);
      expect(verdict, visibility).toBe('unknown-replay');
    }
  });

  it('refuses every replay tier when the channel does not know the run', async () => {
    for (const visibility of ['public', 'unlisted', 'private'] as const) {
      expect(await access('unknown-run').mayView(record(visibility), request)).toBe('unknown-replay');
    }
  });

  it('fails closed when the authority cannot be consulted at all', async () => {
    // An authority that could not be asked is not an authority that said yes.
    expect(await access('throw').mayView(record('public'), request)).toBe('unknown-replay');
  });

  it('passes a sign-in requirement through rather than swallowing it', async () => {
    expect(await access('sign-in').mayView(record('public'), request)).toBe('sign-in');
  });

  it('admits public and unlisted once the channel has admitted the caller', async () => {
    // The difference between them is LISTING, decided in the catalogue, not
    // admission -- "known link" was never "no authority".
    expect(await access('allow').mayView(record('public'), request)).toBe('allow');
    expect(await access('allow').mayView(record('unlisted'), request)).toBe('allow');
  });

  it('REFUSES a private recording to a caller the channel would admit', async () => {
    /*
     * THE MUTATION THIS CLOSES returned `allow` here. Private means somebody
     * made a decision about who may watch, and knowing the run id is not one --
     * the channel admitting you is not the same as being admitted to this.
     */
    expect(await access('allow').mayView(record('private'), request)).toBe('unknown-replay');
  });

  it('and serves it to the operator, who must be able to see their own', async () => {
    expect(await access('allow', { operator: true }).mayView(record('private'), request)).toBe(
      'allow',
    );
  });

  it('never answers sign-in for a private one, which would confirm it exists', async () => {
    // Anybody who guessed the id could otherwise sign in and look again.
    expect(await access('allow').mayView(record('private'), request)).not.toBe('sign-in');
  });
});
