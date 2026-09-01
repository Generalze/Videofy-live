/** @author masterzee001 */
/**
 * The ROOT sweep, and the one workspace it must not sweep.
 *
 * WHY THIS FILE EXISTS. Running `vitest` from the repository root with no
 * config picks up every `*.test.ts` in the tree -- including `apps/mobile`,
 * whose tests only work under its OWN config, because that config aliases
 * `expo-secure-store` to a stub. A native module with no node implementation
 * throws at import time and cannot be intercepted by a per-test mock, which is
 * why the alias lives in config rather than in the suites.
 *
 * Swept without that alias, four mobile files fail to LOAD, and a failure to
 * load looks exactly like a broken dependency install. It cost a real
 * misdiagnosis: the four files were reported twice as a pre-existing
 * environment defect when the environment was fine and the invocation was
 * wrong. Excluding them here makes a root sweep tell the truth.
 *
 * MOBILE IS STILL GATED, and more so than before: `apps/mobile` is now in the
 * root `npm test` enumeration, which runs it through its own config where it
 * passes. Excluded from the ad-hoc sweep, included in the real gate.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      // Has its own config. Run it with `npm run test -w apps/mobile`.
      'apps/mobile/**',
    ],
  },
});
