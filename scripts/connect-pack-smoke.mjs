#!/usr/bin/env node
/** @owner masterzee001 */
/**
 * P6.5 R10 — the external-consumability proof for the two public SDKs.
 *
 *   node scripts/connect-pack-smoke.mjs [--keep]
 *
 * Stages, in order, all inside a fresh os.tmpdir() project OUTSIDE the repo:
 *
 *   1. `npm pack` packages/connect-sdk (@videofy/connect) and
 *      packages/connect-server-sdk (@videofy/server-sdk) into the workdir.
 *   2. `npm init -y`, then `npm install` of the two tarballs plus typescript
 *      and @types/node pinned to what the repo itself uses — no workspace
 *      links, no registry tricks — and assert the resulting node_modules has
 *      NO @videofy-live/* leakage anywhere (internals must be bundled).
 *   3. Compile a consumer smoke.ts that imports createVideofyConnect
 *      (@videofy/server-sdk) and createVideofyClient (@videofy/connect)
 *      under tsc --strict; compile a second file of deliberately wrong-typed
 *      calls and assert tsc REJECTS every tagged line (and errors on no
 *      untagged one); then compile both shipped .d.ts standalone with
 *      types: [] and skipLibCheck off, proving they need no @types at all.
 *   4. Run the compiled smoke with node: the server SDK's calls.create must
 *      land a correctly shaped request on an injected fake fetch (method,
 *      URL, authorization + Idempotency-Key headers, exact JSON body), a
 *      malformed call id must be refused before any network traffic, and
 *      createVideofyClient must instantiate and guard its config (no join —
 *      no gateway needed).
 *   5. Exit non-zero on any failure with a readable transcript; remove the
 *      workdir either way (--keep retains it for debugging); report timing.
 *
 * Privacy: no real credential exists anywhere in this harness. The smoke's
 * fabricated key is asserted against but never printed, and the transcript
 * scrubs anything vfk_-shaped from relayed child output as defense in depth.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keepWorkdir = process.argv.includes('--keep');
const startedAt = Date.now();
const timings = [];

// -------------------------------------------------------------- transcript --

function scrub(text) {
  // Defense in depth: nothing here handles a real credential, but anything
  // key-shaped a child process echoes is redacted before it is printed.
  return String(text).replace(/vfk_[A-Za-z0-9_]+/g, 'vfk_[REDACTED]');
}

function log(line = '') {
  console.log(scrub(line));
}

class SmokeFailure extends Error {
  constructor(message, output = '') {
    super(message);
    this.output = output;
  }
}

function step(name, fn) {
  const t0 = Date.now();
  log(`\n== ${name}`);
  try {
    const result = fn();
    const ms = Date.now() - t0;
    timings.push({ name, ms, ok: true });
    log(`   ok (${ms} ms)`);
    return result;
  } catch (error) {
    timings.push({ name, ms: Date.now() - t0, ok: false });
    throw error;
  }
}

// ----------------------------------------------------------- child commands --

function quoteArg(value) {
  return /[\s"&|<>()^;]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function run(argv, { cwd, label, expectFailure = false }) {
  const options = { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 };
  // npm needs a shell on Windows (npm.cmd); node subprocesses are spawned
  // directly via the exact executable running this harness.
  const result =
    argv[0] === 'npm'
      ? spawnSync(argv.map(quoteArg).join(' '), { ...options, shell: true })
      : spawnSync(argv[0], argv.slice(1), options);
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const output = `${stdout}\n${stderr}`.trim();
  if (result.error) {
    throw new SmokeFailure(`${label}: could not run (${result.error.message})`, output);
  }
  const failed = (result.status ?? 1) !== 0;
  if (failed && !expectFailure) {
    throw new SmokeFailure(`${label}: exited with status ${result.status}`, output);
  }
  if (!failed && expectFailure) {
    throw new SmokeFailure(`${label}: expected a non-zero exit but it succeeded`, output);
  }
  return { status: result.status ?? 0, stdout, stderr };
}

// ------------------------------------------------------------------ helpers --

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * List a .tgz's entries with the system tar. The filename is passed RELATIVE
 * with cwd set to its directory: GNU tar (first on PATH under Git Bash)
 * parses a "C:\..." absolute path as a remote-host spec, while a bare
 * filename works for GNU tar, bsdtar, and unix tar alike. Returns null when
 * tar is unavailable, in which case the post-install assertions are the
 * fallback proof.
 */
function listTarballEntries(directory, filename) {
  const result = spawnSync('tar', ['-tf', filename], {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error || (result.status ?? 1) !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/\\/g, '/'))
    .filter((entry) => entry.length > 0);
}

function readRepoInstalledVersion(name, fallback) {
  try {
    const manifestPath = path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json');
    const version = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
    if (typeof version === 'string' && version.length > 0) return version;
  } catch {
    // fall through to the recorded fallback
  }
  return fallback;
}

function findDirectoriesNamed(root, target, depthLeft) {
  if (depthLeft < 0) return [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === target) {
      found.push(full);
      continue;
    }
    found.push(...findDirectoriesNamed(full, target, depthLeft - 1));
  }
  return found;
}

const SDK_WORKSPACES = [
  {
    label: 'client SDK',
    dir: path.join(repoRoot, 'packages', 'connect-sdk'),
    publicName: '@videofy/connect',
    expectedRuntimeDeps: ['socket.io-client'],
    // prepack rebuilds dist, so no staleness check is needed here
    requiresPrebuiltDist: false,
  },
  {
    label: 'server SDK',
    dir: path.join(repoRoot, 'packages', 'connect-server-sdk'),
    publicName: '@videofy/server-sdk',
    expectedRuntimeDeps: [],
    // no prepack: npm pack ships the dist that exists on disk
    requiresPrebuiltDist: true,
  },
];

// --------------------------------------------------------- consumer sources --

const TSCONFIG_JSON = `{
  // skipLibCheck stays ON here because @types/node vs DOM-lib drift is
  // third-party noise; tsconfig.dts.json re-checks OUR shipped .d.ts with
  // skipLibCheck OFF and no @types at all.
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "noEmitOnError": true,
    "outDir": "dist-smoke"
  },
  "include": ["smoke.ts"]
}
`;

const TSCONFIG_NEGATIVE_JSON = `{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["smoke-negative.ts"]
}
`;

const TSCONFIG_DTS_JSON = `{
  // types: [] and skipLibCheck OFF: the program is exactly our two shipped
  // .d.ts files plus the TS libs, so any unresolved or unsound type in what
  // we publish fails this compile — no @types can paper over it.
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "types": [],
    "skipLibCheck": false,
    "noEmit": true
  },
  "include": ["dts-standalone.ts"]
}
`;

const SMOKE_TS = `/**
 * Videofy Connect external-consumer smoke (generated by
 * scripts/connect-pack-smoke.mjs — edit the harness, not this file).
 *
 * The top half exercises the public type surfaces under --strict; main()
 * is a minimal runtime against an injected fake fetch. The API key below is
 * a fabricated placeholder: asserted against, never printed.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  createVideofyConnect,
  VideofyApiError,
  VideofyContractError,
  VideofyInputError,
} from '@videofy/server-sdk';
import type {
  Call,
  Capabilities,
  CreateCallInput,
  CreateJoinTokenInput,
  VideofyConnectClient,
  VideofyErrorCode,
  VideofyFetch,
  VideofyFetchRequestInit,
} from '@videofy/server-sdk';
import { createVideofyClient, VideofyConnectError } from '@videofy/connect';
import type {
  CallSnapshot,
  ConnectEventMap,
  JoinOptions,
  VideofyCall,
  VideofyClient,
} from '@videofy/connect';

// ----------------------------------------------------------------- type layer

const createInput: CreateCallInput = {
  type: 'personal',
  mode: 'translated',
  metadata: { orderRef: 'smoke-1' },
};

const joinTokenInput: CreateJoinTokenInput = {
  participant: {
    subject: 'customer_8291',
    displayName: 'Smoke Customer',
    speakLanguage: 'en',
    hearLanguage: 'es',
    audioMode: 'translated',
    captionsEnabled: true,
    voiceGender: 'female',
  },
  expiresInSeconds: 300,
};
void joinTokenInput;

const terminalCode: VideofyErrorCode = 'CALL_ENDED';
void terminalCode;

const capabilityRead: (caps: Capabilities) => number = (caps) =>
  caps.limits.personalParticipants + caps.languages.length;
void capabilityRead;

const joinOptions: JoinOptions = {
  token: 'placeholder-token-never-sent',
  media: { microphone: false, camera: false },
};
void joinOptions;

const stateListener: (snapshot: ConnectEventMap['state']) => void = (snapshot) => {
  const snap: CallSnapshot = snapshot;
  const publicCallId: string = snap.call.id;
  void publicCallId;
};
void stateListener;

type JoinResolves = Awaited<ReturnType<VideofyClient['join']>>;
const joinYieldsCall: JoinResolves extends VideofyCall ? true : never = true;
void joinYieldsCall;

// -------------------------------------------------------------- runtime layer

function fail(message: string): never {
  throw new Error(message);
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return null;
}

const FAKE_API_KEY = 'vfk_dev_' + 'x'.repeat(32); // fabricated; never printed

async function main(): Promise<void> {
  const captured: Array<{ url: string; init: VideofyFetchRequestInit }> = [];
  const fakeFetch: VideofyFetch = async (url, init) => {
    captured.push({ url, init });
    const request = JSON.parse(init.body ?? '{}') as {
      type: 'personal' | 'conference';
      mode: 'normal' | 'translated';
      metadata?: Record<string, unknown>;
    };
    const bodyOut: Record<string, unknown> = {
      callId: 'vc_0123456789abcdef',
      type: request.type,
      mode: request.mode,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    if (request.metadata !== undefined) bodyOut.metadata = request.metadata;
    return {
      ok: true,
      status: 201,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'x-request-id' ? 'req_smoke_0001' : null),
      },
      text: async () => JSON.stringify(bodyOut),
    };
  };

  const server: VideofyConnectClient = createVideofyConnect({
    apiKey: FAKE_API_KEY,
    baseUrl: 'https://connect.smoke.invalid',
    fetch: fakeFetch,
  });

  const created: Call = await server.calls.create(createInput, { idempotencyKey: 'smoke-idem-1' });

  check(captured.length === 1, 'calls.create should make exactly one request, saw ' + captured.length);
  const sent = captured[0]!;
  check(
    sent.url === 'https://connect.smoke.invalid/v1/calls',
    'calls.create hit ' + sent.url + ', expected https://connect.smoke.invalid/v1/calls',
  );
  check(sent.init.method === 'POST', 'calls.create used method ' + sent.init.method + ', expected POST');
  check(
    headerValue(sent.init.headers, 'authorization') === 'Bearer ' + FAKE_API_KEY,
    'authorization header did not carry the Bearer key (values withheld)',
  );
  const contentType = headerValue(sent.init.headers, 'content-type');
  check(
    contentType !== null && contentType.includes('application/json'),
    'content-type was ' + String(contentType),
  );
  check(
    headerValue(sent.init.headers, 'idempotency-key') === 'smoke-idem-1',
    'Idempotency-Key header missing or wrong',
  );
  const sentBody: unknown = JSON.parse(sent.init.body ?? 'null');
  check(
    isDeepStrictEqual(sentBody, {
      type: 'personal',
      mode: 'translated',
      metadata: { orderRef: 'smoke-1' },
    }),
    'calls.create body drifted: ' + JSON.stringify(sentBody),
  );

  check(/^vc_[A-Za-z0-9]{16}$/.test(created.callId), 'callId shape wrong: ' + created.callId);
  check(created.type === 'personal' && created.mode === 'translated', 'type/mode echo wrong');
  check(isDeepStrictEqual(created.metadata, { orderRef: 'smoke-1' }), 'metadata echo wrong');
  check(typeof created.createdAt === 'string' && created.createdAt.length > 0, 'createdAt missing');

  let refusedLocally = false;
  try {
    await server.calls.retrieve('not-a-call-id');
  } catch (error) {
    refusedLocally = true;
    check(error instanceof VideofyInputError, 'malformed call id should raise VideofyInputError');
    check(!error.message.includes(FAKE_API_KEY), 'error message leaked the api key');
  }
  check(refusedLocally, 'malformed call id was not refused');
  check(captured.length === 1, 'a local refusal must not reach the network');

  check(typeof VideofyApiError === 'function', 'VideofyApiError class missing');
  check(typeof VideofyContractError === 'function', 'VideofyContractError class missing');

  const web: VideofyClient = createVideofyClient({ baseUrl: 'http://127.0.0.1:9' });
  check(typeof web.join === 'function', 'createVideofyClient did not yield a join()');

  let guarded = false;
  try {
    createVideofyClient({ baseUrl: '   ' });
  } catch (error) {
    guarded = true;
    check(error instanceof VideofyConnectError, 'config guard should raise VideofyConnectError');
    check(error.code === 'INVALID_REQUEST', 'config guard code drifted: ' + error.code);
  }
  check(guarded, 'blank baseUrl was not refused');

  const publicError = new VideofyConnectError('CALL_ENDED', 'smoke probe').toPublicError();
  check(
    publicError.code === 'CALL_ENDED' && typeof publicError.retryable === 'boolean',
    'toPublicError shape drifted',
  );

  console.log('SMOKE-RUN-OK');
}

main().catch((error: unknown) => {
  const text = String(error instanceof Error ? (error.stack ?? error.message) : error);
  console.error('SMOKE-RUN-FAILED: ' + text.split(FAKE_API_KEY).join('[redacted]'));
  process.exit(1);
});
`;

const SMOKE_NEGATIVE_TS = `/**
 * Negative-compile probes (generated by scripts/connect-pack-smoke.mjs).
 * Every tagged line below must be REJECTED by tsc --strict; the harness
 * fails if any of them compiles, or if any untagged line errors. Nothing
 * here ever runs (noEmit).
 */
import { createVideofyConnect } from '@videofy/server-sdk';
import type { JoinParticipantInput } from '@videofy/server-sdk';
import { createVideofyClient } from '@videofy/connect';
import type { CallSnapshot, VideofyCall } from '@videofy/connect';

const server = createVideofyConnect({ apiKey: 'placeholder', baseUrl: 'https://x.invalid' });
const web = createVideofyClient({ baseUrl: 'https://x.invalid' });
declare const call: VideofyCall;
declare const snap: CallSnapshot;

const participantOk: JoinParticipantInput = {
  subject: 'customer_1',
  displayName: 'A',
  speakLanguage: 'en',
  hearLanguage: 'es',
};

void createVideofyConnect({ baseUrl: 'https://x.invalid' }); // EXPECT-ERROR apiKey is required
void createVideofyConnect({ apiKey: 123, baseUrl: 'https://x.invalid' }); // EXPECT-ERROR apiKey must be a string
void server.calls.create({ type: 'group', mode: 'translated' }); // EXPECT-ERROR 'group' is not a CallType
void server.calls.create({ type: 'personal' }); // EXPECT-ERROR mode is required
void server.calls.setMode('vc_0123456789abcdef', 'loud'); // EXPECT-ERROR 'loud' is not a CallMode
void server.calls.end('vc_0123456789abcdef', { idempotencyKey: 42 }); // EXPECT-ERROR idempotencyKey must be a string
void server.joinTokens.create('vc_0123456789abcdef', { participant: { subject: 'x' } }); // EXPECT-ERROR participant is missing required fields
void server.joinTokens.create('vc_0123456789abcdef', { participant: participantOk, expiresInSeconds: '300' }); // EXPECT-ERROR TTL must be a number
void createVideofyClient({}); // EXPECT-ERROR baseUrl is required
void createVideofyClient({ baseUrl: 42 }); // EXPECT-ERROR baseUrl must be a string
void web.join({ media: { microphone: true } }); // EXPECT-ERROR token is required
void web.join({ token: 'placeholder', media: { videoo: true } }); // EXPECT-ERROR unknown media option
call.on('nonsense', () => {}); // EXPECT-ERROR unknown event name
call.on('state', (snapshot: number) => { void snapshot; }); // EXPECT-ERROR state delivers a CallSnapshot, not a number
void snap.resumeToken; // EXPECT-ERROR resumeToken must not exist on the public snapshot
`;

const DTS_STANDALONE_TS = `/**
 * Compiled with types: [] and skipLibCheck OFF (generated by
 * scripts/connect-pack-smoke.mjs): both shipped .d.ts files must typecheck
 * standalone, with no @types packages in the program at all.
 */
import type { JoinToken, VideofyConnectClient } from '@videofy/server-sdk';
import type { CallSnapshot, VideofyCall } from '@videofy/connect';

declare const serverClient: VideofyConnectClient;
declare const call: VideofyCall;

export type TokenEcho = JoinToken['participant'];
export type SnapshotOfCall = ReturnType<VideofyCall['getSnapshot']>;
declare const snapshotTypesAgree: SnapshotOfCall extends CallSnapshot ? true : never;

export type Probe = [typeof serverClient, typeof call, typeof snapshotTypesAgree];
`;

// --------------------------------------------------------------------- main --

function main() {
  let workdir = null;
  try {
    const pins = step('preflight', () => {
      const typescriptPin = readRepoInstalledVersion('typescript', '5.9.3');
      const typesNodePin = readRepoInstalledVersion('@types/node', '22.20.1');
      log(`   node ${process.version}; pinning typescript@${typescriptPin}, @types/node@${typesNodePin}`);
      for (const ws of SDK_WORKSPACES) {
        const manifestPath = path.join(ws.dir, 'package.json');
        if (!fs.existsSync(manifestPath)) {
          throw new SmokeFailure(`${ws.label}: missing ${manifestPath}`);
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.name !== ws.publicName) {
          throw new SmokeFailure(
            `${ws.label}: expected package name ${ws.publicName}, found ${manifest.name}`,
          );
        }
        ws.tarball = `${ws.publicName.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;
        if (ws.requiresPrebuiltDist) {
          for (const file of ['index.js', 'index.d.ts']) {
            if (!fs.existsSync(path.join(ws.dir, 'dist', file))) {
              throw new SmokeFailure(
                `${ws.label}: dist/${file} is missing and this package has no prepack build — ` +
                  `run "npm run build -w ${ws.publicName}" first`,
              );
            }
          }
        }
        log(`   ${ws.publicName}@${manifest.version} -> ${ws.tarball}`);
      }
      return { typescriptPin, typesNodePin };
    });

    workdir = step('create workdir in os.tmpdir()', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videofy-connect-pack-smoke-'));
      log(`   ${dir}`);
      return dir;
    });

    for (const ws of SDK_WORKSPACES) {
      step(`npm pack ${ws.publicName}`, () => {
        // A concurrent workspace rebuild (tsup writes index.js before
        // index.d.ts) can race npm pack into an incomplete tarball, so the
        // contents are verified and the pack retried a bounded number of
        // times. A tarball that stays incomplete is a real failure.
        const tarballPath = path.join(workdir, ws.tarball);
        const required = ['package/package.json', 'package/dist/index.js', 'package/dist/index.d.ts'];
        let lastProblem = 'npm pack produced nothing';
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          if (attempt > 1) {
            log(`   retrying (attempt ${attempt}) after: ${lastProblem}`);
            sleepMs(2000);
          }
          fs.rmSync(tarballPath, { force: true });
          run(['npm', 'pack', '--pack-destination', workdir], {
            cwd: ws.dir,
            label: `npm pack ${ws.publicName}`,
          });
          if (!fs.existsSync(tarballPath)) {
            const present = fs.readdirSync(workdir).join(', ') || '(nothing)';
            lastProblem = `expected ${ws.tarball} in the workdir, found: ${present}`;
            continue;
          }
          const entries = listTarballEntries(workdir, ws.tarball);
          const sizeNote = `${ws.tarball} (${Math.round(fs.statSync(tarballPath).size / 1024)} kB)`;
          if (entries === null) {
            log(`   ${sizeNote} — tar unavailable, contents verified post-install instead`);
            return;
          }
          const missing = required.filter((entry) => !entries.includes(entry));
          if (missing.length === 0) {
            log(`   ${sizeNote}, ${entries.length} entries, dist complete`);
            return;
          }
          lastProblem = `tarball is missing ${missing.join(', ')} (a concurrent rebuild can race npm pack)`;
        }
        throw new SmokeFailure(`${ws.publicName}: ${lastProblem}`);
      });
    }

    step('npm init -y (temp consumer project)', () => {
      run(['npm', 'init', '-y'], { cwd: workdir, label: 'npm init' });
      const manifestPath = path.join(workdir, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.type = 'module'; // both SDKs are ESM-only
      manifest.private = true;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    });

    step('npm install tarballs + pinned toolchain', () => {
      run(
        [
          'npm',
          'install',
          ...SDK_WORKSPACES.map((ws) => path.join(workdir, ws.tarball)),
          `typescript@${pins.typescriptPin}`,
          `@types/node@${pins.typesNodePin}`,
          '--no-audit',
          '--no-fund',
          '--no-progress',
          '--loglevel=error',
        ],
        { cwd: workdir, label: 'npm install' },
      );
      const resolvedTs = JSON.parse(
        fs.readFileSync(path.join(workdir, 'node_modules', 'typescript', 'package.json'), 'utf8'),
      ).version;
      if (resolvedTs !== pins.typescriptPin) {
        throw new SmokeFailure(
          `typescript resolved to ${resolvedTs}, expected the pin ${pins.typescriptPin}`,
        );
      }
      log(`   typescript@${resolvedTs} resolved in the temp project`);
    });

    step('assert clean, link-free, leak-free install', () => {
      const nodeModules = path.join(workdir, 'node_modules');
      const leaks = findDirectoriesNamed(nodeModules, '@videofy-live', 6);
      if (leaks.length > 0) {
        throw new SmokeFailure(
          `@videofy-live/* leaked into the consumer install (internals must be bundled): ${leaks.join(', ')}`,
        );
      }
      for (const ws of SDK_WORKSPACES) {
        const installed = path.join(nodeModules, ...ws.publicName.split('/'));
        const stats = fs.lstatSync(installed, { throwIfNoEntry: false });
        if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
          throw new SmokeFailure(
            `${ws.publicName} is not a real installed directory (workspace link suspected)`,
          );
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
        const declared = [
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.peerDependencies ?? {}),
          ...Object.keys(manifest.optionalDependencies ?? {}),
        ].sort();
        if (declared.join(',') !== [...ws.expectedRuntimeDeps].sort().join(',')) {
          throw new SmokeFailure(
            `${ws.publicName} runtime deps drifted: [${declared.join(', ')}], ` +
              `expected [${ws.expectedRuntimeDeps.join(', ')}]`,
          );
        }
        for (const file of ['index.js', 'index.d.ts']) {
          const content = fs.readFileSync(path.join(installed, 'dist', file), 'utf8');
          if (content.includes('@videofy-live')) {
            throw new SmokeFailure(
              `${ws.publicName} dist/${file} still references @videofy-live — bundling failed`,
            );
          }
        }
        log(`   ${ws.publicName}: real directory, deps [${declared.join(', ') || 'none'}]`);
      }
      if (!fs.existsSync(path.join(nodeModules, 'socket.io-client'))) {
        throw new SmokeFailure('socket.io-client (the client SDK runtime dependency) was not installed');
      }
    });

    step('write consumer sources', () => {
      const files = {
        'tsconfig.json': TSCONFIG_JSON,
        'tsconfig.negative.json': TSCONFIG_NEGATIVE_JSON,
        'tsconfig.dts.json': TSCONFIG_DTS_JSON,
        'smoke.ts': SMOKE_TS,
        'smoke-negative.ts': SMOKE_NEGATIVE_TS,
        'dts-standalone.ts': DTS_STANDALONE_TS,
      };
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(workdir, name), content);
        log(`   ${name} (${content.split('\n').length} lines)`);
      }
    });

    const tscJs = path.join(workdir, 'node_modules', 'typescript', 'lib', 'tsc.js');

    step('tsc --strict compiles the consumer (smoke.ts)', () => {
      run([process.execPath, tscJs, '-p', 'tsconfig.json', '--pretty', 'false'], {
        cwd: workdir,
        label: 'tsc smoke.ts',
      });
      if (!fs.existsSync(path.join(workdir, 'dist-smoke', 'smoke.js'))) {
        throw new SmokeFailure('tsc succeeded but dist-smoke/smoke.js was not emitted');
      }
    });

    step('tsc REJECTS every wrong-typed call (smoke-negative.ts)', () => {
      const result = run([process.execPath, tscJs, '-p', 'tsconfig.negative.json', '--pretty', 'false'], {
        cwd: workdir,
        label: 'tsc smoke-negative.ts',
        expectFailure: true,
      });
      const combined = `${result.stdout}\n${result.stderr}`;
      const rejectedLines = new Set();
      const strayErrors = [];
      for (const raw of combined.split(/\r?\n/)) {
        const line = raw.trim();
        if (!/\berror TS\d+/.test(line)) continue;
        const located = /^(.+?)\((\d+),\d+\): error TS/.exec(line);
        if (located && located[1].replace(/\\/g, '/').endsWith('smoke-negative.ts')) {
          rejectedLines.add(Number(located[2]));
        } else {
          strayErrors.push(line);
        }
      }
      const source = fs.readFileSync(path.join(workdir, 'smoke-negative.ts'), 'utf8');
      const expectedLines = [];
      source.split(/\r?\n/).forEach((text, index) => {
        if (/\/\/ EXPECT-ERROR\b/.test(text)) expectedLines.push(index + 1);
      });
      if (expectedLines.length === 0) {
        throw new SmokeFailure('smoke-negative.ts has no tagged lines — harness bug');
      }
      const notRejected = expectedLines.filter((line) => !rejectedLines.has(line));
      const unexpected = [...rejectedLines].filter((line) => !expectedLines.includes(line));
      if (notRejected.length > 0) {
        throw new SmokeFailure(
          `tsc ACCEPTED wrong-typed lines ${notRejected.join(', ')} of smoke-negative.ts — ` +
            'the public types are looser than the contract',
          combined,
        );
      }
      if (unexpected.length > 0) {
        throw new SmokeFailure(
          `tsc errored on untagged smoke-negative.ts lines ${unexpected.join(', ')} — ` +
            'the negative probe is broken, not the SDKs',
          combined,
        );
      }
      if (strayErrors.length > 0) {
        throw new SmokeFailure(
          'tsc reported errors outside smoke-negative.ts during the negative compile',
          strayErrors.join('\n'),
        );
      }
      log(`   all ${expectedLines.length} wrong-typed lines refused; zero stray errors`);
    });

    step('shipped .d.ts compile standalone (types: [], skipLibCheck off)', () => {
      run([process.execPath, tscJs, '-p', 'tsconfig.dts.json', '--pretty', 'false'], {
        cwd: workdir,
        label: 'tsc dts-standalone.ts',
      });
    });

    step('runtime smoke (fake fetch; no gateway)', () => {
      const result = run([process.execPath, path.join('dist-smoke', 'smoke.js')], {
        cwd: workdir,
        label: 'node smoke.js',
      });
      if (!result.stdout.includes('SMOKE-RUN-OK')) {
        throw new SmokeFailure(
          'smoke.js exited 0 but did not print SMOKE-RUN-OK',
          `${result.stdout}\n${result.stderr}`,
        );
      }
      for (const line of result.stdout.trim().split(/\r?\n/)) log(`   ${line}`);
    });

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('\n!! FAILURE');
    log(`   ${message}`);
    if (error instanceof SmokeFailure && error.output) {
      log('   ---- child output (tail) ----');
      for (const line of error.output.trim().split(/\r?\n/).slice(-120)) log(`   ${line}`);
      log('   -----------------------------');
    }
    process.exitCode = 1;
    return false;
  } finally {
    if (workdir !== null) {
      if (keepWorkdir) {
        log(`\n== workdir kept: ${workdir}`);
      } else {
        try {
          fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
          log('\n== workdir removed');
        } catch (cleanupError) {
          const why = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          log(`\n== WARNING: could not remove workdir ${workdir}: ${why}`);
        }
      }
    }
  }
}

const passed = main();

log('\n== timing');
for (const t of timings) {
  log(`   ${t.ok ? 'ok  ' : 'FAIL'} ${String(t.ms).padStart(7)} ms  ${t.name}`);
}
const totalMs = Date.now() - startedAt;
log(`   total ${totalMs} ms`);
log(passed ? `\nPACK-SMOKE OK (${totalMs} ms)` : `\nPACK-SMOKE FAILED (${totalMs} ms)`);
