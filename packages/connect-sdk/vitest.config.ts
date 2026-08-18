/** @owner masterzee001 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // package-surface.test.ts shells out to `npm pack`.
    testTimeout: 120_000,
  },
});
