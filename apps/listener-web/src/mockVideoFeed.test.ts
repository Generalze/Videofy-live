import { describe, expect, it } from 'vitest';
import { shouldUseMockVideoFeed } from './mockVideoFeed';

describe('mock video feed selection', () => {
  it('starts the synthetic feed only for the explicit Phase 1 mock source', () => {
    expect(shouldUseMockVideoFeed(undefined)).toBe(false);
    expect(shouldUseMockVideoFeed('local-file')).toBe(false);
    expect(shouldUseMockVideoFeed('webrtc')).toBe(false);
    expect(shouldUseMockVideoFeed('mock')).toBe(true);
  });
});
