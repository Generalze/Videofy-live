/** @author masterzee001 */
/**
 * The two things Replay must be independent OF, checked mechanically.
 *
 * FROM THE LIVE BROADCAST. A recording is a by-product. The day an object
 * store is slow must not be the day a programme goes off air, and the way that
 * promise usually breaks is not a decision anybody took -- it is a durable
 * implementation, written later, that throws where the port said it would
 * refuse, inside a live segment handler.
 *
 * FROM THE AI STACK. Recording a broadcast is media infrastructure. It has
 * nothing to do with transcription, translation, synthesised speech, provider
 * certification or language routes, and the moment it imports one of them, a
 * channel that records will start requiring an AI provider to be certified
 * before it can keep its own video. That is checked here against the manifest
 * and the imports rather than remembered, because a single import statement is
 * all it would take.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REPLAY_FAILURE_LIVE_IMPACT,
  REPLAY_FAILURE_REASONS,
  replayFailure,
  withoutFailingTheProgramme,
  type ReplayOutcome,
} from './outcome.js';
import { InMemoryReplayArchive } from './memory-archive.js';

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(SOURCE_DIRECTORY, '..');

/* --------------------------------------------- independence from the live path */

describe('a replay failure never has to end a broadcast', () => {
  it('states, in the type, that the live programme is unaffected', () => {
    const failure = replayFailure('archive-unavailable', 'the volume went away');
    expect(failure.liveImpact).toBe(REPLAY_FAILURE_LIVE_IMPACT);
    expect(REPLAY_FAILURE_LIVE_IMPACT).toBe('none');
  });

  it('says so for every reason there is, with no exception', () => {
    // A boolean would invite one reason to be the special case that stops a
    // programme. There is no value here that could express that.
    for (const reason of REPLAY_FAILURE_REASONS) {
      expect(replayFailure(reason, 'x').liveImpact).toBe('none');
    }
  });

  it('turns a throwing archive into an ordinary refusal', async () => {
    // The failure this guards against: a durable implementation written later
    // that throws inside a live segment handler.
    const outcome = await withoutFailingTheProgramme(async () => {
      throw new Error('the object store hung up');
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failure.reason).toBe('archive-unavailable');
    expect(outcome.failure.liveImpact).toBe('none');
    // The original complaint survives, so an operator can act on it.
    expect(outcome.failure.detail).toContain('the object store hung up');
  });

  it('survives an implementation that throws something that is not an Error', async () => {
    const outcome = await withoutFailingTheProgramme(async () => {
      throw 'a string, because somebody was in a hurry';
    });
    expect(outcome.ok).toBe(false);
  });

  it('passes a success through untouched', async () => {
    const outcome = await withoutFailingTheProgramme<number>(async () => ({
      ok: true,
      value: 7,
    }));
    expect(outcome).toEqual({ ok: true, value: 7 });
  });

  it('lets every archive refusal be recorded rather than thrown', async () => {
    // What the future live caller does: try, and on refusal write down what
    // happened and carry on broadcasting.
    const archive = new InMemoryReplayArchive(() => 0);
    const noted: string[] = [];

    const attempts: readonly (() => Promise<ReplayOutcome<unknown>>)[] = [
      () => archive.finalise('run_nobody'),
      () => archive.delete('run_nobody'),
      () => archive.expire('run_nobody', 0),
      () =>
        archive.retainSegment('run_nobody', {
          runId: 'run_nobody',
          segmentId: 's0',
          startProgrammeTimeMs: 0,
          endProgrammeTimeMs: 2000,
          keyframeAligned: true,
          hasVideo: true,
          hasAudio: true,
          storageReference: '/spool/s0.m4s',
          bytes: 1,
        }),
      () =>
        archive.retainInitialisation('run_nobody', {
          runId: 'run_nobody',
          generation: 0,
          storageReference: '/spool/init.mp4',
          bytes: 1,
        }),
    ];

    for (const attempt of attempts) {
      const outcome = await withoutFailingTheProgramme(attempt);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('unreachable');
      expect(outcome.failure.liveImpact).toBe('none');
      noted.push(outcome.failure.reason);
    }

    // Every one of them produced something to write down, and nothing threw.
    expect(noted).toHaveLength(attempts.length);
  });
});

/* ----------------------------------------------- independence from the AI stack */

/** Every dependency this package is permitted to declare, and nothing else. */
const PERMITTED_DEPENDENCIES = ['@videofy-live/media-ingress-wire', '@videofy-live/programme-timeline'];

/**
 * Packages a Replay contract must never reach for.
 *
 * Listed by name as well as covered by the allow-list above, so the intent is
 * legible to somebody reading the failure rather than only to the check.
 */
const FORBIDDEN_DEPENDENCIES = [
  '@videofy-live/language-catalogue',
  '@videofy-live/language-specialist',
  '@videofy-live/translation-routes',
  '@videofy-live/programme-vocabulary',
  '@videofy-live/programme-quality',
  '@videofy-live/speech-activity',
  '@videofy-live/ai-registry',
];

function manifest(): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

/** The module specifiers imported by the package's own source, tests aside. */
function importedModules(): readonly string[] {
  const files = readdirSync(SOURCE_DIRECTORY).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  expect(files.length).toBeGreaterThan(0);

  const specifiers: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(SOURCE_DIRECTORY, file), 'utf8');
    for (const match of source.matchAll(/\bfrom\s+'([^']+)'/g)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe('replay recording is media infrastructure, not an AI capability', () => {
  it('declares only the two media contracts it actually needs', () => {
    const declared = Object.keys(manifest().dependencies ?? {});
    expect(declared.sort()).toEqual([...PERMITTED_DEPENDENCIES].sort());
  });

  it('declares none of the AI packages, as a dependency or a dev dependency', () => {
    const everything = {
      ...(manifest().dependencies ?? {}),
      ...(manifest().devDependencies ?? {}),
    };
    for (const forbidden of FORBIDDEN_DEPENDENCIES) {
      expect(Object.keys(everything)).not.toContain(forbidden);
    }
  });

  it('imports nothing beyond its own modules and those two contracts', () => {
    // A single import statement is all it would take for a channel to need a
    // certified provider before it could keep its own video.
    for (const specifier of importedModules()) {
      if (specifier.startsWith('.')) continue;
      expect(PERMITTED_DEPENDENCIES).toContain(specifier);
    }
  });

  it('imports no runtime at all: no node builtins, no sockets, no disk', () => {
    // The contracts are pure. Storage arrives behind the port, in a later
    // wave, in a package that is allowed to touch a filesystem.
    for (const specifier of importedModules()) {
      expect(specifier.startsWith('node:')).toBe(false);
    }
  });
});
