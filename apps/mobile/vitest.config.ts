/** @author masterzee001 */
/**
 * Tests for the parts of this app that are NOT React Native.
 *
 * The session layer is deliberately plain TypeScript -- it takes storage and
 * `fetch` as parameters -- so it can be tested in node without a device, an
 * emulator or a bundler. What it cannot avoid is the top-level
 * `import * as SecureStore from 'expo-secure-store'`, which resolves to a
 * native module that has no node implementation and throws on import.
 *
 * Aliased to a stub rather than mocked per test file: a module that fails at
 * IMPORT time cannot be intercepted by a mock inside the test, and every
 * suite would need the same boilerplate to work around it. The stub is
 * deliberately useless -- every test injects its own storage, so anything
 * reaching the stub is a test that forgot to.
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      'expo-secure-store': resolve(__dirname, 'src/__tests__/stubs/expo-secure-store.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
