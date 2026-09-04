/**
 * The visual harness's build. TEST-ONLY, and deliberately a SEPARATE Vite
 * entry rather than a mode flag on the production build.
 *
 * Founder directive 30 Aug 2026, SS13: the deterministic render fixtures
 * "must NOT leak into production business logic". A flag would leak: it puts
 * both branches in one module graph and leaves a switch somebody can flip in
 * a deployment. A separate root cannot -- `npm run build` starts at
 * ./index.html -> src/main.tsx and never resolves visual/ at all, so the
 * production bundle is incapable of containing a fixture.
 *
 * It reuses the production config's plugins and aliases so the fixture build
 * compiles the same source the console does; only the root and the output
 * directory differ.
 */
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('./visual', import.meta.url)),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@videofy-live/shared-types': fileURLToPath(
        new URL('../../packages/shared-types/src/index.ts', import.meta.url),
      ),
    },
  },
  /*
   * The gateway/ingest/account origins the console reads at module scope.
   * A fixture render must not reach a real service, so they are pointed at
   * an unroutable .invalid host; nothing in a fixture render dials them.
   */
  define: {
    'import.meta.env.VITE_GATEWAY_URL': JSON.stringify('http://fixture.invalid/gateway'),
    'import.meta.env.VITE_INGEST_URL': JSON.stringify('http://fixture.invalid/ingest'),
    'import.meta.env.VITE_ACCOUNT_URL': JSON.stringify('http://fixture.invalid/account'),
    'import.meta.env.VITE_WEBRTC_ICE_SERVERS': JSON.stringify(''),
    'import.meta.env.VITE_SOCKET_TRANSPORT': JSON.stringify(undefined),
  },
  build: {
    outDir: fileURLToPath(new URL('./dist-visual', import.meta.url)),
    emptyOutDir: true,
  },
});
