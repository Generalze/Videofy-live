/** @author masterzee001 */
/**
 * Does the built artefact actually start?
 *
 * NOTHING IN THIS REPOSITORY ASKED THAT UNTIL NOW, and it cost a failed
 * staging deploy on an exact SHA whose CI was fully green. The composition
 * root asked a lazily-intended question eagerly -- a closure reading a
 * module-level const was passed somewhere that called it immediately -- and
 * the service died at import with `Cannot access 'translationGate' before
 * initialization`. Build passed. Type-check passed. Twelve hundred unit tests
 * passed. Integration smoke passed. The binary could not start.
 *
 * Every one of those checks exercises MODULES. Only index.ts has the top-level
 * ordering that produced the fault, and nothing imported index.ts, so nothing
 * could see it. This is the same family as the require-in-ESM defect and the
 * unwired seams: the parts were all sound and the assembly was never run.
 *
 * So this runs the real artefact, the way systemd does, and requires it to
 * reach the point where it is listening.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(
  new URL('../../dist/services/media-ingest/src/index.js', import.meta.url),
);

/**
 * The smallest environment a deployment can have.
 *
 * Deliberately minimal: the boot path most likely to break is the one a
 * sparse deployment takes, and a fixture that sets everything would only
 * prove the richest configuration works.
 */
/**
 * A port the operating system has just confirmed is free.
 *
 * A COUNTER WAS NOT ENOUGH, and it failed in CI rather than here: the previous
 * probe's child is killed, its socket is not released instantly, and the next
 * spawn lands on EADDRINUSE. Incrementing a number makes that less likely
 * without making it impossible, and a gate that fails for reasons unrelated to
 * what it guards trains everybody to re-run CI.
 *
 * Binding zero and reading back what the kernel chose, then releasing it, is
 * the same question the service is about to ask. Paired with waiting for each
 * child to actually exit, there is no window for two probes to collide.
 */
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

const MINIMAL_ENV = {
  NODE_ENV: 'test',
  // Info, because the line that proves the listener is bound is an info line.
  LOG_LEVEL: 'info',
  AUDIO_CHUNK_DIR: fileURLToPath(new URL('../../.boot-probe/audio', import.meta.url)),
  WEBRTC_AUDIO_CHUNK_STAGING_DIR: fileURLToPath(new URL('../../.boot-probe/webrtc', import.meta.url)),
  MEDIA_INGEST_UPLOAD_DIR: fileURLToPath(new URL('../../.boot-probe/uploads', import.meta.url)),
  VIDEOFY_AUTH_SECRET: 'boot-probe-secret-not-a-real-credential',
  /*
   * Required, and the service refuses to start without it -- correctly: an
   * unset internal token would leave the internal media API accepting audio
   * from anyone who can reach the port. A throwaway value, so this fixture
   * exercises the same refusal a real deployment does rather than the escape
   * hatch beside it.
   */
  INTERNAL_WEBRTC_TOKEN: 'boot-probe-internal-token-not-a-real-credential',
};

interface BootResult {
  readonly listening: boolean;
  readonly exitCode: number | null;
  readonly output: string;
}

async function boot(extraEnv: Record<string, string> = {}): Promise<BootResult> {
  const port = await freePort();
  return new Promise<BootResult>((resolve) => {
    /*
     * A DISTINCT PORT PER PROBE. The service reads INGEST_PORT and defaults to
     * 3002, so two probes in a row raced for the same socket: the first child
     * is killed, the port has not been released, and the second exits 1 for a
     * reason that has nothing to do with what is being tested. It passed alone
     * and failed in the full suite, which is the signature of exactly this.
     */
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, ...MINIMAL_ENV, INGEST_PORT: String(port), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const finish = (listening: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ listening, exitCode, output });
        return;
      }
      /*
       * WAIT FOR THE CHILD TO ACTUALLY GO. Resolving on the kill signal
       * returns while the process still holds its socket, and the next probe
       * spawns into it. That is the EADDRINUSE that failed CI.
       */
      child.once('exit', () => resolve({ listening, exitCode, output }));
      child.kill('SIGKILL');
    };
    const read = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      /*
       * The service's own words from inside the listen callback, so the
       * listener is genuinely bound. Anything earlier only proves the process
       * began importing -- which is exactly what the failed deploy achieved.
       */
      if (output.includes('Media ingest endpoint started')) {
        finish(true, null);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (code) => finish(false, code));
    const timer = setTimeout(() => finish(false, null), 25_000);
  });
}

describe('the built artefact starts', () => {
  it('has been built at all', () => {
    /*
     * A FAILURE, NEVER A SKIP. A boot check that quietly skips when the build
     * is missing is a gate that passes hardest exactly when it has least to
     * go on -- and CI builds before it tests, so absence here means something
     * is wrong with the run, not with the check.
     */
    expect(existsSync(ENTRY), `${ENTRY} is missing: run npm run build first`).toBe(true);
  });

  it('REACHES ITS LISTENER RATHER THAN DYING AT IMPORT', { timeout: 40_000 }, async () => {
    const result = await boot();
    expect(result.output).not.toMatch(/ReferenceError|Cannot access/u);
    expect(result.listening, `the service exited ${result.exitCode}:\n${result.output}`).toBe(true);
  });

  it('starts with a protected spool configured, which is the deployment we ship', {
    timeout: 40_000,
  }, async () => {
    /*
     * The protected path has its own composition -- spool probe, keeper,
     * relay policy -- and a deployment that boots without it proves nothing
     * about the one that boots with it.
     */
    const result = await boot({
      PROGRAMME_MEDIA_SPOOL: fileURLToPath(new URL('../../.boot-probe/spool', import.meta.url)),
      PROGRAMME_MEDIA_DELIVERY: 'delayed',
      PROGRAMME_SAFETY_DELAY_MS: '45000',
    });
    expect(result.output).not.toMatch(/ReferenceError|Cannot access/u);
    expect(result.listening, `the service exited ${result.exitCode}:\n${result.output}`).toBe(true);
  });

  it('refuses to start on a configuration it cannot honour, and says why', {
    timeout: 40_000,
  }, async () => {
    // The other half of booting: a service that starts on nonsense is worse
    // than one that stops. A delay live delivery cannot hold is refused.
    const result = await boot({
      PROGRAMME_MEDIA_DELIVERY: 'live',
      PROGRAMME_SAFETY_DELAY_MS: '45000',
    });
    expect(result.listening).toBe(false);
    expect(result.output).toMatch(/cannot be held while the gateway relays/u);
  });
});
