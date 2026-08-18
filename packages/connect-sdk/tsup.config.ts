/** @owner masterzee001 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  // resolve: true inlines the @videofy-live/* declaration files into
  // dist/index.d.ts. zod stays a type-level import here (its declarations are
  // path-mapped, which the resolver treats as external); the build script's
  // finalize-dts step then replaces that single import with a local type shim
  // so the published declarations stand alone exactly like the runtime.
  dts: { resolve: true },
  sourcemap: false,
  clean: true,
  // R10: every @videofy-live/* internal package is bundled INTO dist so the
  // tarball installs outside the workspace with no workspace aliases. zod is
  // named explicitly because it rides in through the bundled internals
  // (call-wire, connect-contracts); it must never surface as a runtime
  // dependency of the public package. The ONLY external runtime dependency
  // is socket.io-client.
  external: ['socket.io-client'],
  noExternal: [/^@videofy-live\//, 'zod'],
});
