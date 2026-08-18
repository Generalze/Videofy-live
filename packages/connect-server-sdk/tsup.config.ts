/** @author masterzee001 */
/**
 * R10: the public server SDK must be externally consumable. Everything
 * internal (@videofy-live/connect-contracts, and zod through it) is bundled
 * INTO dist so the published tarball has zero runtime dependencies and no
 * workspace aliases; the only runtime requirement is Node 18+ global fetch.
 */
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: false,
  platform: 'node',
  target: 'node18',
  treeshake: true,
  noExternal: [/^@videofy-live\//, 'zod'],
});
