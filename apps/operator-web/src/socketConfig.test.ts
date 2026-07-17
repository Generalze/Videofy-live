import { describe, expect, it } from 'vitest';
import { createOperatorSocketOptions } from './socketConfig';

describe('createOperatorSocketOptions', () => {
  it('allows Socket.IO to start with polling and upgrade automatically', () => {
    const options = createOperatorSocketOptions();

    expect(options.query).toEqual({ role: 'operator' });
    expect(options.transports).toBeUndefined();
    expect(options.reconnection).toBeUndefined();
  });
});
