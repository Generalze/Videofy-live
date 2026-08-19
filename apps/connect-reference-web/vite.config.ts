// owner: masterzee001
import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(appDir, '../..');
const workspaceSdkDist = resolve(repoRoot, 'packages/connect-sdk/dist/index.js');

/**
 * Connect Reference is built as an external Videofy customer would build it:
 * the ONLY Videofy code it touches is the public dist of @videofy/connect.
 * The alias points at that dist directly so dev velocity never depends on
 * workspace install state, and the dev server proxies /api to the
 * Connect Reference server (port 8790) so the browser speaks room ids and
 * join tokens only — never project keys.
 */
export default defineConfig({
  envDir: repoRoot,
  plugins: [react()],
  resolve: {
    // In the workspace, point straight at the public dist; packed installs
    // (the external-customer proof) resolve @videofy/connect normally.
    alias: existsSync(workspaceSdkDist) ? { '@videofy/connect': workspaceSdkDist } : {},
  },
  server: {
    port: 5300,
    proxy: {
      '/api': {
        target: process.env['REF_SERVER_URL'] ?? 'http://localhost:8790',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
  },
});
