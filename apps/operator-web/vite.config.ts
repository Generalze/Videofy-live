import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(appDir, '../..');

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, repoRoot, 'VITE_');

  return {
    envDir: repoRoot,
    define: {
      'import.meta.env.VITE_GATEWAY_URL': JSON.stringify(
        rootEnv['VITE_GATEWAY_URL'] ?? 'http://localhost:3001',
      ),
      'import.meta.env.VITE_INGEST_URL': JSON.stringify(
        rootEnv['VITE_INGEST_URL'] ?? 'http://localhost:3002',
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
