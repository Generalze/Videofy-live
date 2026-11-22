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
      /*
       * The Google web OAuth client id. PUBLIC -- it travels in every request
       * Google's own script makes -- so it is compiled in like the rest.
       *
       * IT NEEDS A LINE HERE OR IT DOES NOT EXIST. The deploy script exports
       * these into the process environment, and vite only auto-exposes VITE_
       * values that came from an .env FILE. Without this define the bundle
       * compiles `undefined`, the Google button is silently never drawn, and
       * nothing fails -- which is precisely how VITE_ACCOUNT_URL once shipped
       * production pointing at the visitor's own machine.
       *
       * Empty by default, and empty means the button is not offered. That is
       * the right failure: a button Google would reject is worse than none.
       */
      'import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID': JSON.stringify(
        fromEnv(rootEnv, 'VITE_GOOGLE_WEB_CLIENT_ID', ''),
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
