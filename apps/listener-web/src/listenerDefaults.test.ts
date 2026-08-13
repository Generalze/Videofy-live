import { describe, expect, it } from 'vitest';
import { DEFAULT_LISTENER_TARGET_LANGUAGE } from './App';

describe('listener defaults', () => {
  it('joins the partner-preview Spanish target by default', () => {
    expect(DEFAULT_LISTENER_TARGET_LANGUAGE).toBe('es');
  });
});
