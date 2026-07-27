import { describe, expect, it } from 'vitest';
import {
  createBroadcasterSocketOptions,
  createOperatorSocketOptions,
  resolveSocketTransportOptions,
} from './socketConfig';

describe('createOperatorSocketOptions', () => {
  it('allows Socket.IO to start with polling and upgrade automatically', () => {
    const options = createOperatorSocketOptions();

    expect(options.query).toEqual({ role: 'operator' });
    expect(options.transports).toBeUndefined();
    expect(options.reconnection).toBeUndefined();
  });

  it('supports a polling-only local development override', () => {
    expect(resolveSocketTransportOptions('polling')).toEqual({
      transports: ['polling'],
      upgrade: false,
    });
  });

  it('creates a dedicated broadcaster signalling role', () => {
    expect(createBroadcasterSocketOptions().query).toEqual({ role: 'broadcaster' });
  });
});
