import type { OperatorProgrammeSessionConfig } from '@videofy-live/shared-types';
import { SOCKET_EVENTS } from '@videofy-live/shared-types';

export interface ProgrammeSessionConfigAckEvent {
  action: string;
  accepted: boolean;
}

/** Minimal structural view of a socket.io client used for config delivery. */
export interface ProgrammeSessionConfigSocket {
  emit(event: string, payload: unknown): unknown;
  on(event: string, listener: (ack: ProgrammeSessionConfigAckEvent) => void): unknown;
  off(event: string, listener: (ack: ProgrammeSessionConfigAckEvent) => void): unknown;
}

export interface DeliverProgrammeSessionConfigOptions {
  /** Wait before the first re-emit; doubles on every retry. Default 1500 ms. */
  attemptTimeoutMs?: number;
  /** Hard cap on total delivery time. Default 10000 ms. */
  maxTotalMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
}

export class ProgrammeSessionConfigDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgrammeSessionConfigDeliveryError';
  }
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_TOTAL_MS = 10_000;
const CONFIG_ACK_ACTION = 'programme-session-config';

/**
 * Emits the operator programme session configuration and resolves only once
 * the gateway acknowledges it with a CONTROL_ACK for
 * `programme-session-config`. The emit is retried with exponential backoff
 * until the ack arrives or the hard cap elapses, in which case the returned
 * promise rejects so callers can surface the failure and block transport
 * startup instead of silently proceeding.
 */
export function deliverProgrammeSessionConfig(
  socket: ProgrammeSessionConfigSocket,
  config: OperatorProgrammeSessionConfig,
  options: DeliverProgrammeSessionConfigOptions = {},
): Promise<void> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const maxTotalMs = options.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
  const setTimer =
    options.setTimer ??
    ((callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number);
  const clearTimer =
    options.clearTimer ??
    ((timer) => globalThis.clearTimeout(timer as unknown as ReturnType<typeof setTimeout>));

  return new Promise<void>((resolve, reject) => {
    let attempt = 0;
    let retryTimer: number | null = null;
    let deadlineTimer: number | null = null;

    const cleanup = (): void => {
      socket.off(SOCKET_EVENTS.CONTROL_ACK, handleAck);
      if (retryTimer !== null) clearTimer(retryTimer);
      if (deadlineTimer !== null) clearTimer(deadlineTimer);
      retryTimer = null;
      deadlineTimer = null;
    };

    const handleAck = (ack: ProgrammeSessionConfigAckEvent): void => {
      if (ack?.action !== CONFIG_ACK_ACTION) return;
      cleanup();
      if (ack.accepted === false) {
        reject(
          new ProgrammeSessionConfigDeliveryError(
            'The gateway rejected the programme session configuration.',
          ),
        );
        return;
      }
      resolve();
    };

    const sendAttempt = (): void => {
      attempt += 1;
      socket.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, config);
      retryTimer = setTimer(sendAttempt, attemptTimeoutMs * 2 ** (attempt - 1));
    };

    socket.on(SOCKET_EVENTS.CONTROL_ACK, handleAck);
    deadlineTimer = setTimer(() => {
      cleanup();
      reject(
        new ProgrammeSessionConfigDeliveryError(
          'The gateway did not acknowledge the programme session configuration. Check the gateway connection and start interpretation again.',
        ),
      );
    }, maxTotalMs);
    sendAttempt();
  });
}
