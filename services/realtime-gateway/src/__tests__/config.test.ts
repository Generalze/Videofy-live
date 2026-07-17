import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const ORIGINAL_ENV = { ...process.env };

describe('gateway config', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('trims comma-separated CORS origins', () => {
    process.env['CORS_ORIGINS'] = ' http://localhost:5173, http://localhost:5174 ';

    expect(loadConfig().corsOrigins).toEqual([
      'http://localhost:5173',
      'http://localhost:5174',
    ]);
  });

  it('rejects invalid numeric ports with a useful error', () => {
    process.env['GATEWAY_PORT'] = 'NaN';

    expect(() => loadConfig()).toThrow(/GATEWAY_PORT/);
  });
});
