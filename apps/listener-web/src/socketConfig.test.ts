import { describe, expect, it } from 'vitest';
import { createListenerSocketOptions } from './socketConfig';

describe('createListenerSocketOptions', () => {
  it('allows Socket.IO to start with polling and upgrade automatically', () => {
    const options = createListenerSocketOptions();

    expect(options.query).toEqual({ role: 'listener' });
    expect(options.transports).toBeUndefined();
    expect(options.reconnection).toBeUndefined();
  });
});
