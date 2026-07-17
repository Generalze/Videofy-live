import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

describe('Express app health endpoint', () => {
  it('createApp returns an express application', () => {
    const app = createApp();
    expect(typeof app).toBe('function');
    expect(app.listen).toBeDefined();
  });
});
