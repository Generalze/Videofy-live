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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

  it('separates a source that was never there from an archive that would not take it', () => {
    /*
     * The two failures a live producer can hand this package, and the reason
     * they are not one reason. `archive-unavailable` means the bytes were fine
     * and the store refused; `source-media-unavailable` means the programme's
     * own media could not be made durable, so there was nothing to store. An
     * operator retries the first and never trusts the second.
     */
    expect(REPLAY_FAILURE_REASONS).toContain('source-media-unavailable');
    expect(REPLAY_FAILURE_REASONS).toContain('archive-unavailable');
    expect(replayFailure('source-media-unavailable', 'x').reason).not.toBe('archive-unavailable');
  });

  it('separates an encoder that died from a broadcast that ended', () => {
    // A truncated recording and a complete one must not reach the same status
    // by the same route, so the reason for the truncation has a name.
    expect(REPLAY_FAILURE_REASONS).toContain('media-origin-failed');
    expect(replayFailure('media-origin-failed', 'x').liveImpact).toBe('none');
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
 * The storage boundary, stated as a boundary rather than as a permission.
 *
 * WP-R1-A held that NOTHING here imported a node builtin, which was true while
 * the package was contracts and an in-memory double. WP-R1-C added a durable
 * archive, which cannot own bytes without a filesystem -- and the tempting
 * response, "the package may now import fs", would have thrown away the
 * property that mattered. It was never "no builtins". It was that anyone
 * importing the Replay CONTRACTS gets contracts, and does not quietly acquire
 * a filesystem dependency they have no use for and may not even have.
 *
 * So the boundary is drawn instead of moved. There are two entrypoints: the
 * root, whose whole reachable graph is storage-neutral, and `./filesystem`,
 * which is the only way to a durable archive. The tests below pin both halves
 * -- that the root cannot reach storage, and that storage reaches for nothing
 * beyond the three builtins it genuinely needs.
 */
const ROOT_ENTRY = 'index.ts';
const FILESYSTEM_ENTRY = 'filesystem.ts';
const STORAGE_MODULES = [FILESYSTEM_ENTRY, 'filesystem-archive.ts', 'filesystem-layout.ts'];
const PERMITTED_NODE_BUILTINS = ['node:crypto', 'node:fs/promises', 'node:path'];

/**
 * Source with its comments removed.
 *
 * The scans below look for import statements, and this file's own subject
 * matter means the prose is full of things that LOOK like them -- a doc
 * comment showing a caller how to reach the filesystem subpath reads exactly
 * like an import of it. Stripping comments first is the difference between
 * asserting about code and asserting about writing.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every module reachable from an entrypoint by following its own imports. */
function graphFrom(entry: string): readonly string[] {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = withoutComments(readFileSync(join(SOURCE_DIRECTORY, file), 'utf8'));
    for (const match of source.matchAll(/\bfrom\s+'(\.[^']+)'/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      // Source is written with the emitted '.js' extension; the file is '.ts'.
      const next = specifier.replace(/^\.\//u, '').replace(/\.js$/u, '.ts');
      if (!seen.has(next)) pending.push(next);
    }
  }
  return [...seen];
}

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

/**
 * Every module specifier the package's own source imports, and who imports it.
 *
 * Paired with its file because the interesting rules are now per-module: the
 * contracts may not touch a disk and storage may.
 */
function importedModules(): readonly (readonly [string, string])[] {
  const files = readdirSync(SOURCE_DIRECTORY).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  expect(files.length).toBeGreaterThan(0);

  const specifiers: (readonly [string, string])[] = [];
  for (const file of files) {
    const source = withoutComments(readFileSync(join(SOURCE_DIRECTORY, file), 'utf8'));
    for (const match of source.matchAll(/\bfrom\s+'([^']+)'/g)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push([file, specifier]);
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

  it('imports nothing beyond its own modules, those two contracts, and a disk', () => {
    // A single import statement is all it would take for a channel to need a
    // certified provider before it could keep its own video.
    for (const [file, specifier] of importedModules()) {
      if (specifier.startsWith('.')) continue;
      if (specifier.startsWith('node:')) continue;
      expect(
        PERMITTED_DEPENDENCIES,
        `${file} imports ${specifier}`,
      ).toContain(specifier);
    }
  });

  it('keeps every contract module free of any runtime at all', () => {
    // The contracts are pure: no sockets, no disk, no clock but the one a
    // caller passes in. Only storage is allowed to know what a filesystem is.
    for (const [file, specifier] of importedModules()) {
      if (!specifier.startsWith('node:')) continue;
      expect(STORAGE_MODULES, `${file} imports ${specifier}`).toContain(file);
    }
  });

  it('lets storage reach only for the builtins it genuinely needs', () => {
    // Not a socket, not a child process, not an HTTP client. A durable archive
    // copies bytes and hashes a name; anything else in this list would be a
    // question worth asking out loud.
    for (const [file, specifier] of importedModules()) {
      if (!specifier.startsWith('node:')) continue;
      expect(PERMITTED_NODE_BUILTINS, `${file} imports ${specifier}`).toContain(specifier);
    }
  });
});

/* ------------------------------------------- the root is storage-neutral */

describe('the root entrypoint gives you contracts, not a filesystem', () => {
  it('reaches no storage module at all', () => {
    /*
     * THE REGRESSION THIS EXISTS FOR is a one-line re-export. Adding the
     * durable archive back to the barrel would read as tidiness and would
     * quietly give every importer of the Replay contracts a hard dependency on
     * `node:fs` -- including the ones running somewhere without one.
     */
    const reachable = graphFrom(ROOT_ENTRY);
    for (const storage of STORAGE_MODULES) {
      expect(reachable, `the root entry reaches ${storage}`).not.toContain(storage);
    }
  });

  it('reaches no node builtin through anything it imports', () => {
    for (const file of graphFrom(ROOT_ENTRY)) {
      const source = withoutComments(readFileSync(join(SOURCE_DIRECTORY, file), 'utf8'));
      for (const match of source.matchAll(/\bfrom\s+'(node:[^']+)'/g)) {
        expect.fail(`${file} imports ${String(match[1])} but is reachable from the root entry`);
      }
    }
  });

  it('names the filesystem archive only behind its own subpath', () => {
    const reachable = graphFrom(FILESYSTEM_ENTRY);
    expect(reachable).toContain('filesystem-archive.ts');

    const exported = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    expect(Object.keys(exported.exports ?? {}).sort()).toEqual(['.', './filesystem']);
  });

  it('keeps the adapter out of the built root bundle too', () => {
    /*
     * The source graph is the rule; this reads what was actually emitted, in
     * case a build ever resolves things differently from the way they are
     * written.
     */
    const built = join(PACKAGE_ROOT, 'dist', 'index.js');
    if (!existsSync(built)) {
      // Nothing has been compiled in this working tree. The source-graph tests
      // above still hold, and this assertion is not silently skipped: it says
      // so.
      expect(graphFrom(ROOT_ENTRY)).not.toContain('filesystem-archive.ts');
      return;
    }
    const emitted = withoutComments(readFileSync(built, 'utf8'));
    expect(emitted).not.toContain('filesystem-archive');
    expect(emitted).not.toContain('node:fs');
    expect(existsSync(join(PACKAGE_ROOT, 'dist', 'filesystem.js'))).toBe(true);
  });
});
