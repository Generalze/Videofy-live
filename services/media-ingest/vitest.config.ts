/** @author masterzee001 */
/**
 * No test in this service may reach the network.
 *
 * A suite that makes real outbound calls depends on somebody else's uptime and
 * on DNS resolution, and it fails in the way that is hardest to read: a timeout
 * in a full run that passes every time in isolation.
 *
 * That is not hypothetical. The synthesis wiring injected its transport into
 * the Nigerian specialist only, so a test that made the specialist fail fell
 * through to the general chain, which used the global fetch and made a real
 * request to ElevenLabs with a fixture key. It passed -- slowly -- until a full
 * run under load pushed it past a five-second timeout. The wiring is fixed; the
 * setup file below is what stops the next one being written.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/network-trap.setup.ts'],
  },
});
