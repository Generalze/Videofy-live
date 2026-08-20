/** @author masterzee001 */
/**
 * Configuration is where a production incident usually begins.
 *
 * The rule these tests exist to hold: NO SECURITY-CRITICAL VALUE HAS A DEFAULT.
 * A default credential is an unlocked door with a sign on it, and a default
 * route is calls quietly translated for the wrong customer. Both are failures
 * that look like success.
 */
import { describe, expect, it } from 'vitest';
import {
  SIP_ROUTE_MAP_VARIABLE,
  SipRuntimeConfigError,
  describeConfig,
  loadSipRuntimeConfig,
} from '../config.js';

const COMPLETE = {
  ADAPTER_SERVICE_TOKEN: 'adapter-service-token-0123456789',
  SIP_ROUTE_CREDENTIAL: 'vfr_r_sip_primary.operator-chosen-secret-0123456789abcdef',
  GATEWAY_ADAPTER_CONTROL_URL: 'https://gateway.example/internal/adapter/v1',
  GATEWAY_ADAPTER_MEDIA_URL: 'wss://gateway.example/internal/adapter/v1/media',
  SIP_ADVERTISED_ADDRESS: '203.0.113.10',
  [SIP_ROUTE_MAP_VARIABLE]: JSON.stringify({ '441234': 'route_17' }),
};

describe('required configuration', () => {
  it('loads a complete environment', () => {
    const config = loadSipRuntimeConfig(COMPLETE);
    expect(config.advertisedAddress).toBe('203.0.113.10');
    expect(config.routesByDialledNumber).toEqual({ '441234': 'route_17' });
    // Non-security values default, because a deployment that must specify a
    // pump interval before it can answer a telephone will not be configured
    // correctly either.
    expect(config.sipPort).toBe(5060);
    expect(config.pumpIntervalMs).toBe(20);
  });

  it('PIN: no security-critical value has a default', () => {
    for (const name of [
      'ADAPTER_SERVICE_TOKEN',
      'SIP_ROUTE_CREDENTIAL',
      'GATEWAY_ADAPTER_CONTROL_URL',
      'GATEWAY_ADAPTER_MEDIA_URL',
      'SIP_ADVERTISED_ADDRESS',
      SIP_ROUTE_MAP_VARIABLE,
    ]) {
      const env: Record<string, string> = { ...COMPLETE };
      delete env[name];
      expect(() => loadSipRuntimeConfig(env), name).toThrow(SipRuntimeConfigError);
    }
  });

  it('PIN: an empty string is not configuration', () => {
    // `VAR=` in a .env file is the most common way a required value goes
    // missing while looking present.
    expect(() =>
      loadSipRuntimeConfig({ ...COMPLETE, ADAPTER_SERVICE_TOKEN: '   ' }),
    ).toThrow(SipRuntimeConfigError);
  });

  it('PIN: every problem is reported at once', () => {
    try {
      loadSipRuntimeConfig({});
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SipRuntimeConfigError);
      // An operator fixes them in one pass instead of restarting once per
      // missing variable.
      const problems = (error as SipRuntimeConfigError).problems;
      expect(problems.length).toBeGreaterThanOrEqual(6);
      expect(problems.join('\n')).toContain('SIP_ADVERTISED_ADDRESS');
      expect(problems.join('\n')).toContain('ADAPTER_SERVICE_TOKEN');
    }
  });
});

describe('the route map', () => {
  it('PIN: an unusable route map is refused rather than half applied', () => {
    for (const raw of [
      'not json',
      '[]',
      '"a string"',
      '{}',
      JSON.stringify({ '441234': '' }),
      JSON.stringify({ '441234': 42 }),
      JSON.stringify({ '': 'route_17' }),
    ]) {
      expect(() =>
        loadSipRuntimeConfig({ ...COMPLETE, [SIP_ROUTE_MAP_VARIABLE]: raw }),
        raw,
      ).toThrow(SipRuntimeConfigError);
    }
  });

  it('PIN: there is no fallback route', () => {
    // A call to a number nobody configured must be refused with a 404, not
    // silently mapped onto whichever route happened to be first.
    const config = loadSipRuntimeConfig(COMPLETE);
    expect(config.routesByDialledNumber['999999']).toBeUndefined();
    expect(Object.keys(config.routesByDialledNumber)).toEqual(['441234']);
  });
});

describe('numeric configuration', () => {
  it('refuses values that are not positive integers', () => {
    for (const value of ['0', '-1', 'abc', '5.5']) {
      expect(() => loadSipRuntimeConfig({ ...COMPLETE, SIP_PORT: value }), value).toThrow(
        SipRuntimeConfigError,
      );
    }
  });

  it('PIN: an inverted RTP range is caught at startup', () => {
    // Otherwise the port pool is empty and every call is refused with a 503
    // that looks like capacity rather than configuration.
    expect(() =>
      loadSipRuntimeConfig({ ...COMPLETE, SIP_RTP_PORT_MIN: '40100', SIP_RTP_PORT_MAX: '40000' }),
    ).toThrow(SipRuntimeConfigError);
  });
});

describe('what may be logged', () => {
  it('PIN: the startup summary contains no credential', () => {
    // `logger.info('config', config)` is how a secret ends up in a log
    // aggregator forever, so the summary is a deliberate function.
    const config = loadSipRuntimeConfig(COMPLETE);
    const serialised = JSON.stringify(describeConfig(config));
    expect(serialised).not.toContain(COMPLETE.ADAPTER_SERVICE_TOKEN);
    expect(serialised).not.toContain(COMPLETE.SIP_ROUTE_CREDENTIAL);
    expect(serialised).not.toContain('operator-chosen-secret');
    // While still carrying what an operator actually needs to see.
    expect(serialised).toContain('203.0.113.10');
    expect(serialised).toContain('route_17');
  });
});
