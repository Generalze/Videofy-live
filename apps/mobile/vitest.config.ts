/** @author masterzee001 */
/**
 * Tests for this app, including -- as of 20 Sep 2026 -- the RENDERED ones.
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
 *
 * THE SAME TRICK, FOR THE SCREENS. `react-native` and `react-native-svg` are
 * Flow source and native bindings respectively; neither can be imported in
 * node. Both are aliased to stubs that render their primitives as HOST
 * component names, so `react-test-renderer` produces a tree a test can read.
 * This is what closes the hole three review rounds named: 22 mutants planted in
 * the screen, the components and the styles survived a green suite, because the
 * only instrument pointed at them matched SOURCE TEXT and a prop is not text.
 * See src/__tests__/stubs/react-native.tsx for what the stubs refuse to do.
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      'expo-secure-store': resolve(__dirname, 'src/__tests__/stubs/expo-secure-store.ts'),
      'react-native-svg': resolve(__dirname, 'src/__tests__/stubs/react-native-svg.tsx'),
      // Exact, so `react-native-webrtc` and friends are not caught by it.
      'react-native': resolve(__dirname, 'src/__tests__/stubs/react-native.tsx'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    /*
     * Metro resolves a bundled image through `require('...png')` (ui/c7.tsx
     * does this for the launcher logo). That is a real CommonJS require, so a
     * module alias cannot catch it and node would parse the bytes as a script;
     * the setup file teaches node's loader that a .png is an opaque source.
     */
    setupFiles: ['src/__tests__/stubs/image-asset.ts'],
  },
});
