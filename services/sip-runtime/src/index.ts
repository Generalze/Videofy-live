/** @author masterzee001 */
/**
 * The SIP runtime process.
 *
 * Startup is: resolve configuration or refuse; compose; bind; announce. There
 * is no path where a missing credential produces a running process, and none
 * where a partially bound runtime reports itself ready.
 *
 * Shutdown is ORDERED and BOUNDED, driven by `RuntimeLifecycle`. SIGTERM on a
 * container arrives while calls are in progress, and the difference between a
 * clean drain and a killed process is audible to whoever is mid-sentence.
 */
import '@videofy-live/service-env/auto';
import { HttpControlPlaneClient } from './gateway-clients.js';
import { RuntimeLifecycle } from './lifecycle.js';
import { SipRuntime } from './runtime.js';
import { SipRuntimeConfigError, describeConfig, loadSipRuntimeConfig } from './config.js';

function emit(level: string, message: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: 'sip-runtime',
      message,
      ...detail,
    })}\n`,
  );
}

const log = (line: string, detail?: Record<string, unknown>): void => emit('info', line, detail ?? {});

async function main(): Promise<void> {
  let config;
  try {
    config = loadSipRuntimeConfig();
  } catch (error) {
    if (error instanceof SipRuntimeConfigError) {
      // Every problem at once, so an operator fixes them in one pass rather
      // than restarting once per missing variable.
      emit('error', 'Refusing to start', { problems: error.problems });
      process.exit(1);
    }
    throw error;
  }

  const control = new HttpControlPlaneClient({
    baseUrl: config.gatewayControlUrl,
    serviceToken: config.serviceToken,
    routeCredential: config.routeCredential,
    log,
  });
  const runtime = new SipRuntime({ config, control, log });

  const lifecycle = new RuntimeLifecycle({
    deadlineMs: config.shutdownDeadlineMs,
    log: (line, detail) => emit('info', line, detail ?? {}),
    // The order is not decorative. Closing sockets before ending calls would
    // tell the seam about a hangup it can no longer receive the last audio
    // for; releasing timers first would stop the pump that is draining it.
    steps: [
      { name: 'stop-accepting', run: () => runtime.stopAccepting() },
      { name: 'end-calls', run: () => runtime.endAllCalls('service shutting down') },
      { name: 'close-transports', run: () => runtime.closeTransports() },
      { name: 'close-remote', run: () => runtime.closeRemote() },
      { name: 'release-timers', run: () => runtime.releaseTimers() },
    ],
  });

  await runtime.start();
  lifecycle.ready();
  emit('info', 'SIP runtime started', describeConfig(config));

  const stop = (signal: string): void => {
    void lifecycle.shutdown(signal).then((report) => {
      emit(report.timedOut || report.failed.length > 0 ? 'warn' : 'info', 'SIP runtime stopped', {
        ...report,
      });
      process.exit(report.timedOut || report.failed.length > 0 ? 1 : 0);
    });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

void main().catch((error: unknown) => {
  emit('error', 'SIP runtime failed to start', {
    message: error instanceof Error ? error.message : 'unknown',
  });
  process.exit(1);
});
