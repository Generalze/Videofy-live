import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_EVENTS, type OperatorProgrammeSessionConfig } from '@videofy-live/shared-types';
import {
  ProgrammeSessionConfigDeliveryError,
  deliverProgrammeSessionConfig,
  type ProgrammeSessionConfigAckEvent,
} from './programmeSessionConfigDelivery';

function fakeSocket() {
  const listeners = new Set<(ack: ProgrammeSessionConfigAckEvent) => void>();
  return {
    emit: vi.fn(),
    on: vi.fn((event: string, listener: (ack: ProgrammeSessionConfigAckEvent) => void) => {
      if (event === SOCKET_EVENTS.CONTROL_ACK) listeners.add(listener);
    }),
    off: vi.fn((event: string, listener: (ack: ProgrammeSessionConfigAckEvent) => void) => {
      if (event === SOCKET_EVENTS.CONTROL_ACK) listeners.delete(listener);
    }),
    ack(ack: ProgrammeSessionConfigAckEvent): void {
      [...listeners].forEach((listener) => listener(ack));
    },
    listenerCount(): number {
      return listeners.size;
    },
  };
}

function config(): OperatorProgrammeSessionConfig {
  return {
    sessionId: 'wrs_demo',
    broadcastId: 'broadcast_demo',
    sourceRevision: 0,
    programmeSourceType: 'camera',
    targetLanguage: 'es',
    targetLanguages: ['es'],
    sourceLanguage: 'en',
    sourceLanguageMode: 'manual',
  };
}

describe('deliverProgrammeSessionConfig', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves once the gateway acknowledges the programme session config', async () => {
    const socket = fakeSocket();

    const delivery = deliverProgrammeSessionConfig(socket, config());
    socket.ack({ action: 'programme-session-config', accepted: true });

    await expect(delivery).resolves.toBeUndefined();
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG,
      config(),
    );
    expect(socket.listenerCount()).toBe(0);
  });

  it('retries the emit with backoff and ignores unrelated control acks', async () => {
    const socket = fakeSocket();

    const delivery = deliverProgrammeSessionConfig(socket, config());
    socket.ack({ action: 'start-mock-stream', accepted: true });
    expect(socket.emit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(socket.emit).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(socket.emit).toHaveBeenCalledTimes(3);

    socket.ack({ action: 'programme-session-config', accepted: true });
    await expect(delivery).resolves.toBeUndefined();
    expect(socket.listenerCount()).toBe(0);
  });

  it('rejects after the hard cap when the gateway never acknowledges', async () => {
    const socket = fakeSocket();

    const delivery = deliverProgrammeSessionConfig(socket, config());
    const expectation = expect(delivery).rejects.toThrow(
      /did not acknowledge the programme session configuration/,
    );

    await vi.advanceTimersByTimeAsync(10_000);

    await expectation;
    expect(socket.emit.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(socket.listenerCount()).toBe(0);
  });

  it('rejects when the gateway refuses the programme session config', async () => {
    const socket = fakeSocket();

    const delivery = deliverProgrammeSessionConfig(socket, config());
    const expectation = expect(delivery).rejects.toBeInstanceOf(
      ProgrammeSessionConfigDeliveryError,
    );
    socket.ack({ action: 'programme-session-config', accepted: false });

    await expectation;
    expect(socket.listenerCount()).toBe(0);
  });
});
