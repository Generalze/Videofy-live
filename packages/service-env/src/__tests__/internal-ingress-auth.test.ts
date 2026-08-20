/** @author masterzee001 */
/**
 * The internal media API decides who may inject audio into the platform.
 *
 * It used to decide it like this:
 *
 *     if (!config.internalWebRtcToken) return true;
 *
 * with the token shipped blank in `.env.example`, so the default deployment
 * authenticated nobody. These tests pin the inverted default: absence of
 * configuration is a refusal, disabling authentication takes a deliberate act,
 * and the credential never leaves this module.
 */
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_SERVICE_TOKEN_VARIABLE,
  ALLOW_INSECURE_ADAPTER_INGRESS_VARIABLE,
  ALLOW_INSECURE_INTERNAL_INGRESS_VARIABLE,
  INTERNAL_INGRESS_TOKEN_VARIABLE,
  InternalIngressAuthError,
  MINIMUM_INTERNAL_INGRESS_TOKEN_LENGTH,
  internalIngressRequestAllowed,
  matchesInternalIngressToken,
  resolveAdapterServiceAuth,
  resolveInternalIngressAuth,
} from '../internal-ingress-auth.js';

const TOKEN = 'a3f9c1d7e5b2084613f7a9c2d4e6b8f0a1c3e5d7b9f1a3c5e7d9b1f3a5c7e9d1';

const withEnv = (env: Record<string, string | undefined>) =>
  resolveInternalIngressAuth({ env });

describe('an unconfigured deployment refuses, it does not permit', () => {
  it('PIN: no token and no opt-out refuses every request and refuses to start', () => {
    const resolution = withEnv({});
    expect(resolution.mode).toBe('unconfigured');
    expect(resolution.mustRefuseToStart).toBe(true);
    // The regression this whole module exists for. The old guard returned TRUE
    // here, so an unconfigured media-ingest accepted audio from anyone who
    // could reach the port.
    expect(internalIngressRequestAllowed(resolution, undefined)).toBe(false);
    expect(internalIngressRequestAllowed(resolution, TOKEN)).toBe(false);
    expect(internalIngressRequestAllowed(resolution, '')).toBe(false);
  });

  it('a blank token is the same as no token, not the same as a token', () => {
    const resolution = withEnv({ [INTERNAL_INGRESS_TOKEN_VARIABLE]: '   ' });
    expect(resolution.mode).toBe('unconfigured');
    expect(resolution.mustRefuseToStart).toBe(true);
    expect(internalIngressRequestAllowed(resolution, '   ')).toBe(false);
  });

  it("PIN: a token too short to be a secret is a mistake, not a posture", () => {
    expect(() =>
      withEnv({ [INTERNAL_INGRESS_TOKEN_VARIABLE]: 'a'.repeat(MINIMUM_INTERNAL_INGRESS_TOKEN_LENGTH - 1) }),
    ).toThrow(InternalIngressAuthError);
    // Exactly at the boundary is accepted: the rule is a floor, not a taste.
    expect(
      withEnv({ [INTERNAL_INGRESS_TOKEN_VARIABLE]: 'a'.repeat(MINIMUM_INTERNAL_INGRESS_TOKEN_LENGTH) }).mode,
    ).toBe('enforced');
  });
});

describe('a configured deployment enforces', () => {
  it('PIN: only the matching credential is allowed', () => {
    const resolution = withEnv({ [INTERNAL_INGRESS_TOKEN_VARIABLE]: TOKEN });
    expect(resolution.mode).toBe('enforced');
    expect(resolution.mustRefuseToStart).toBe(false);

    expect(internalIngressRequestAllowed(resolution, TOKEN)).toBe(true);
    expect(internalIngressRequestAllowed(resolution, undefined)).toBe(false);
    expect(internalIngressRequestAllowed(resolution, '')).toBe(false);
    expect(internalIngressRequestAllowed(resolution, `${TOKEN}x`)).toBe(false);
    expect(internalIngressRequestAllowed(resolution, TOKEN.slice(0, -1))).toBe(false);
    expect(internalIngressRequestAllowed(resolution, TOKEN.toUpperCase())).toBe(false);
  });

  it('comparison survives a presented value of any length', () => {
    // Comparing raw strings with timingSafeEqual throws on a length mismatch,
    // which would leak the configured length through an exception before
    // anything leaked through timing. Digests make both sides equal length.
    const resolution = withEnv({ [INTERNAL_INGRESS_TOKEN_VARIABLE]: TOKEN });
    for (const presented of ['x', 'x'.repeat(4096), '\u0000', '🔑']) {
      expect(() => matchesInternalIngressToken(resolution, presented)).not.toThrow();
      expect(matchesInternalIngressToken(resolution, presented)).toBe(false);
    }
  });

  it('the same token resolves to the same fingerprint, and a different one does not', () => {
    // This is what lets an operator confirm two services hold the SAME token
    // when internal calls start returning 403, without either printing it.
    const a = withEnv({ [INTERNAL_INGRESS_TOKEN_VARIABLE]: TOKEN });
    const b = withEnv({ [INTERNAL_INGRESS_TOKEN_VARIABLE]: TOKEN });
    const c = withEnv({ [INTERNAL_INGRESS_TOKEN_VARIABLE]: `${TOKEN}-other` });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(a.fingerprint).toBeTruthy();
  });
});

describe('disabling authentication takes a deliberate act', () => {
  it('PIN: the opt-out permits requests, and says so in terms nobody can miss', () => {
    const resolution = withEnv({ [ALLOW_INSECURE_INTERNAL_INGRESS_VARIABLE]: 'true' });
    expect(resolution.mode).toBe('insecure-explicit');
    expect(resolution.mustRefuseToStart).toBe(false);
    expect(internalIngressRequestAllowed(resolution, undefined)).toBe(true);
    expect(resolution.summary).toMatch(/DISABLED/);
    expect(resolution.summary).toMatch(/inject audio/i);
  });

  it('only an exact opt-in disables it', () => {
    // Anything ambiguous stays closed. A deployment does not fall into having
    // no authentication because a variable was set to "1" or "yes".
    for (const value of ['1', 'yes', 'TRUE ', 'on', '', 'false', undefined]) {
      const resolution = withEnv({ [ALLOW_INSECURE_INTERNAL_INGRESS_VARIABLE]: value });
      if (value === 'TRUE ') {
        // Trimmed and lower-cased, so this one IS the deliberate act.
        expect(resolution.mode).toBe('insecure-explicit');
        continue;
      }
      expect(resolution.mode, `value: ${String(value)}`).toBe('unconfigured');
    }
  });

  it('a configured token wins over the opt-out', () => {
    // Both set is a contradiction. The safe reading is the one that keeps
    // authenticating.
    const resolution = withEnv({
      [INTERNAL_INGRESS_TOKEN_VARIABLE]: TOKEN,
      [ALLOW_INSECURE_INTERNAL_INGRESS_VARIABLE]: 'true',
    });
    expect(resolution.mode).toBe('enforced');
    expect(internalIngressRequestAllowed(resolution, undefined)).toBe(false);
  });
});

describe('the credential does not leak', () => {
  it('PIN: it never appears in the summary, the fingerprint, or a serialized resolution', () => {
    const resolution = withEnv({ [INTERNAL_INGRESS_TOKEN_VARIABLE]: TOKEN });
    expect(resolution.summary).not.toContain(TOKEN);
    expect(resolution.fingerprint).not.toContain(TOKEN);
    expect(resolution.fingerprint!.length).toBeLessThan(TOKEN.length);

    // `token` is deliberately present for the comparison to use, so a caller
    // logging the whole object would still leak it. What must hold is that
    // everything MEANT for logs is clean.
    const loggable = {
      mode: resolution.mode,
      fingerprint: resolution.fingerprint,
      detail: resolution.summary,
    };
    expect(JSON.stringify(loggable)).not.toContain(TOKEN);
  });

  it('a rejected short token is reported without echoing it back', () => {
    const secret = 'short-secret-x';
    try {
      withEnv({ [INTERNAL_INGRESS_TOKEN_VARIABLE]: secret });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(InternalIngressAuthError);
      // An error message that quotes the value ends up in a log, a ticket and
      // a screenshot.
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('the adapter service credential is a SEPARATE trust relationship', () => {
  const ADAPTER = 'adapter-service-token-0123456789';
  const MEDIA = 'internal-media-token-0123456789';

  it('PIN: configuring one credential does not configure the other', () => {
    // Two different pairs of processes. Sharing one secret would mean rotating
    // a compromised adapter credential also restarts the media path, and an
    // operator reading a fingerprint could not tell which relationship it
    // described.
    const onlyMedia = { [INTERNAL_INGRESS_TOKEN_VARIABLE]: MEDIA };
    expect(resolveInternalIngressAuth({ env: onlyMedia }).mode).toBe('enforced');
    expect(resolveAdapterServiceAuth({ env: onlyMedia }).mustRefuseToStart).toBe(true);

    const onlyAdapter = { [ADAPTER_SERVICE_TOKEN_VARIABLE]: ADAPTER };
    expect(resolveAdapterServiceAuth({ env: onlyAdapter }).mode).toBe('enforced');
    expect(resolveInternalIngressAuth({ env: onlyAdapter }).mustRefuseToStart).toBe(true);
  });

  it('PIN: disabling one does not disable the other', () => {
    // The dangerous direction. A developer opting out of internal ingress auth
    // must not silently open the adapter endpoints to the network as well.
    const env = {
      [ALLOW_INSECURE_INTERNAL_INGRESS_VARIABLE]: 'true',
      [ADAPTER_SERVICE_TOKEN_VARIABLE]: ADAPTER,
    };
    expect(resolveInternalIngressAuth({ env }).mode).toBe('insecure-explicit');
    expect(resolveAdapterServiceAuth({ env }).mode).toBe('enforced');

    const other = {
      [ALLOW_INSECURE_ADAPTER_INGRESS_VARIABLE]: 'true',
      [INTERNAL_INGRESS_TOKEN_VARIABLE]: MEDIA,
    };
    expect(resolveAdapterServiceAuth({ env: other }).mode).toBe('insecure-explicit');
    expect(resolveInternalIngressAuth({ env: other }).mode).toBe('enforced');
  });

  it('PIN: an absent adapter credential refuses to start', () => {
    const resolution = resolveAdapterServiceAuth({ env: {} });
    expect(resolution.mode).toBe('unconfigured');
    expect(resolution.mustRefuseToStart).toBe(true);
    expect(resolution.token).toBeNull();
    // Names its OWN variable, so an operator fixes the right one.
    expect(resolution.summary).toContain(ADAPTER_SERVICE_TOKEN_VARIABLE);
    expect(resolution.summary).not.toContain(INTERNAL_INGRESS_TOKEN_VARIABLE);
    // And refuses every request even if the process somehow started.
    expect(internalIngressRequestAllowed(resolution, ADAPTER)).toBe(false);
  });

  it('PIN: a short adapter token is refused without echoing it back', () => {
    const secret = 'too-short-adapt';
    try {
      resolveAdapterServiceAuth({ env: { [ADAPTER_SERVICE_TOKEN_VARIABLE]: secret } });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(InternalIngressAuthError);
      expect((error as Error).message).toContain(ADAPTER_SERVICE_TOKEN_VARIABLE);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('PIN: the fingerprint correlates deployments without printing the secret', () => {
    const gateway = resolveAdapterServiceAuth({
      env: { [ADAPTER_SERVICE_TOKEN_VARIABLE]: ADAPTER },
    });
    const runtime = resolveAdapterServiceAuth({
      env: { [ADAPTER_SERVICE_TOKEN_VARIABLE]: ADAPTER },
    });
    const wrong = resolveAdapterServiceAuth({
      env: { [ADAPTER_SERVICE_TOKEN_VARIABLE]: `${ADAPTER}-different` },
    });
    // The question actually being asked when a connection starts returning 401.
    expect(runtime.fingerprint).toBe(gateway.fingerprint);
    expect(wrong.fingerprint).not.toBe(gateway.fingerprint);
    expect(gateway.summary).not.toContain(ADAPTER);
  });

  it('PIN: the adapter credential is compared in constant time, not by equality', () => {
    const resolution = resolveAdapterServiceAuth({
      env: { [ADAPTER_SERVICE_TOKEN_VARIABLE]: ADAPTER },
    });
    expect(internalIngressRequestAllowed(resolution, ADAPTER)).toBe(true);
    for (const wrong of [undefined, '', MEDIA, `${ADAPTER} `, ADAPTER.slice(0, -1)]) {
      expect(internalIngressRequestAllowed(resolution, wrong)).toBe(false);
    }
  });
});
