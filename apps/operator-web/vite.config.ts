import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(appDir, '../..');

/**
 * Build-time configuration comes from a .env file OR the process environment.
 *
 * `loadEnv` reads .env files ONLY. A deployment that exports VITE_GATEWAY_URL
 * as a shell variable -- which is exactly what a build script does -- was
 * silently ignored, and the bundle fell back to `localhost`. Every browser then
 * resolved that to the visitor's own machine, so the app failed for everyone
 * except somebody running the stack locally. It fails quietly, too: the page
 * loads perfectly and only the connection dies.
 */
function fromEnv(rootEnv: Record<string, string>, name: string, fallback: string): string {
  return rootEnv[name] ?? process.env[name] ?? fallback;
}

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, repoRoot, 'VITE_');

  return {
    envDir: repoRoot,
    define: {
      'import.meta.env.VITE_GATEWAY_URL': JSON.stringify(
        fromEnv(rootEnv, 'VITE_GATEWAY_URL', 'http://localhost:3001'),
      ),
      'import.meta.env.VITE_INGEST_URL': JSON.stringify(
        fromEnv(rootEnv, 'VITE_INGEST_URL', 'http://localhost:3002'),
      ),
      'import.meta.env.VITE_WEBRTC_ICE_SERVERS': JSON.stringify(
        fromEnv(rootEnv, 'VITE_WEBRTC_ICE_SERVERS', ''),
      ),
      'import.meta.env.VITE_SOCKET_TRANSPORT': JSON.stringify(
        rootEnv['VITE_SOCKET_TRANSPORT'] ?? process.env['VITE_SOCKET_TRANSPORT'],
      ),
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@videofy-live/shared-types': fileURLToPath(
          new URL('../../packages/shared-types/src/index.ts', import.meta.url),
        ),
      },
    },
    server: {
      port: 5174,
    },
  };
});
