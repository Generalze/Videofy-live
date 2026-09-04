/**
 * Lint for the React Native app.
 *
 * NOT THE WEB CONFIG. This app has no `window`, no `document` and no DOM; the
 * web configs declare `env: { browser: true }`, which would make every
 * accidental browser global look legitimate here and hide a real crash on a
 * device. What React Native does provide is a Node-ish global set plus
 * `__DEV__`, so those are declared explicitly rather than borrowed.
 *
 * `react-refresh` is deliberately absent: it is a Vite fast-refresh rule about
 * module exports in a browser dev server, and it has nothing to say about
 * Metro. `react-hooks` very much does apply, and is the reason this file earns
 * its place -- a missing dependency in a call-screen effect is exactly the
 * class of defect that reaches a person mid-call.
 */
module.exports = {
  root: true,
  env: { es2021: true, node: true },
  globals: {
    // React Native's own, and the standard web-ish APIs its runtime provides.
    __DEV__: 'readonly',
    fetch: 'readonly',
    Response: 'readonly',
    Request: 'readonly',
    Headers: 'readonly',
    FormData: 'readonly',
    Blob: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    AbortController: 'readonly',
    WebSocket: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    console: 'readonly',
    process: 'readonly',
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['android', 'ios', '.expo', 'dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2021, sourceType: 'module', ecmaFeatures: { jsx: true } },
  rules: {
    /*
     * The native module bridge and the notification payloads genuinely arrive
     * as unknown shapes that are narrowed at the boundary. Warn rather than
     * error so the gate stays meaningful instead of being switched off.
     */
    '@typescript-eslint/no-explicit-any': 'warn',
  },
};
