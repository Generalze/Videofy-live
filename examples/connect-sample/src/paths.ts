/** @author masterzee001 */
/**
 * Where the static halves of the sample live.
 *
 * The join page runs the REAL public browser SDK: the built ESM bundle is
 * aliased straight out of packages/connect-sdk/dist (falling back to the
 * workspace-linked node_modules copy), never re-bundled by the sample. Its one
 * external runtime dependency, socket.io-client, is served the same way and
 * mapped in the page with an import map.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file sits one level below the package root in BOTH src/ and dist/, so
// the same hop works under tsx and after a tsc build.
const sampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(sampleRoot, '..', '..');

export function samplePublicDir(): string {
  return path.join(sampleRoot, 'public');
}

function firstDirContaining(candidates: string[], marker: string, hint: string): string {
  for (const dir of candidates) {
    if (existsSync(path.join(dir, marker))) return dir;
  }
  throw new Error(`${hint} Looked in:\n  ${candidates.join('\n  ')}`);
}

/** Directory holding the built @videofy/connect ESM bundle (index.js). */
export function connectSdkDistDir(): string {
  return firstDirContaining(
    [
      path.join(repoRoot, 'packages', 'connect-sdk', 'dist'),
      path.join(repoRoot, 'node_modules', '@videofy', 'connect', 'dist'),
      path.join(sampleRoot, 'node_modules', '@videofy', 'connect', 'dist'),
    ],
    'index.js',
    'The @videofy/connect browser bundle is not built yet — run: npm run build -w @videofy/connect.',
  );
}

/** Directory holding socket.io-client's browser ESM bundle. */
export function socketIoClientDistDir(): string {
  return firstDirContaining(
    [
      path.join(repoRoot, 'node_modules', 'socket.io-client', 'dist'),
      path.join(sampleRoot, 'node_modules', 'socket.io-client', 'dist'),
    ],
    'socket.io.esm.min.js',
    'socket.io-client is not installed — run npm install at the repo root.',
  );
}
