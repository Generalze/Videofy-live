// owner: masterzee001
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(appDir, '../..');

/** .env file OR process environment; see the note in the Videofy app configs. */
function fromEnv(rootEnv: Record<string, string>, name: string, fallback: string): string {
  return rootEnv[name] ?? process.env[name] ?? fallback;
}

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, repoRoot, 'VITE_');

  return {
    envDir: repoRoot,
    define: {
      // Where the C7 identity service lives. Same-origin behind the proxy.
      'import.meta.env.VITE_ACCOUNT_URL': JSON.stringify(
        fromEnv(rootEnv, 'VITE_ACCOUNT_URL', 'http://localhost:3006'),
      ),
      // Where VIDEOFY-LIVE Call is served. A PATH, not a host, so the bundle
      // stays correct wherever it is deployed.
      'import.meta.env.VITE_CALL_PATH': JSON.stringify(
        fromEnv(rootEnv, 'VITE_CALL_PATH', '/call/'),
      ),
    },
    plugins: [react()],
    server: { port: 5176 },
  };
});
