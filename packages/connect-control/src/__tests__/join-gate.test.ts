/** @owner masterzee001 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConnectJoinGate } from '../join-gate.js';
import { ConnectJtiRegistry, issueConnectJoinToken } from '../join-token.js';
import {
  ConnectLiveCallRegistry,
  ConnectProjectRegistry,
  type ConnectProjectRecord,
} from '../project-registry.js';

const SECRET = Buffer.from('connect-secret-0123456789abcdef0123456789abcdef', 'utf8');
const WRONG_SECRET = Buffer.from('wrong-secret-000123456789abcdef0123456789abcdef', 'utf8');
const NOW = 1_755_500_000;
const ORIGIN = 'https://support.acme.example';
const PUBLIC_ID = 'vc_aaaaaaaaaaaaaaaa';

function project(overrides: Partial<ConnectProjectRecord> = {}): ConnectProjectRecord {
  return {
    projectId: 'proj_abc123def456',
    name: 'Acme',
    keyHash: createHash('sha256').update('vfk_dev_x', 'utf8').digest('hex'),
    allowedOrigins: [ORIGIN],
    allowOriginless: false,
    createdAt: '2026-08-18T00:00:00.000Z',
    active: true,
    ...overrides,
  };
}

function harness(options: {
  projects?: ConnectProjectRecord[];
  secret?: Buffer | null;
  registerCall?: boolean;
  ended?: boolean;
} = {}) {
  const liveCalls = new ConnectLiveCallRegistry();
  if (options.registerCall !== false) {
    liveCalls.register({
      publicCallId: PUBLIC_ID,
      internalCallId: 'connect_abc123de_000000000001',
      projectId: 'proj_abc123def456',
      callType: 'personal',
      mode: 'translated',
      createdAt: '2026-08-18T00:00:00.000Z',
      ended: options.ended ?? false,
    });
  }
  const jti = new ConnectJtiRegistry();
  const gate = new ConnectJoinGate({
    secret: options.secret === undefined ? SECRET : options.secret,
    registry: new ConnectProjectRegistry(options.projects ?? [project()]),
    liveCalls,
    jti,
    nowSeconds: () => NOW,
  });
  return { gate, jti, liveCalls };
}

function mint(overrides: Partial<Parameters<typeof issueConnectJoinToken>[0]> = {}): string {
  return issueConnectJoinToken({
    secret: SECRET,
    proj: 'proj_abc123def456',
    call: PUBLIC_ID,
    sub: 'customer_8291',
    name: 'Ana',
    prefs: { speak: 'en', hear: 'es', audioMode: 'translated', captions: true, voiceGender: 'female' },
    jti: 'jti_unit_1',
    nowSeconds: NOW,
    ...overrides,
  }).token;
}

describe('ConnectJoinGate decision order', () => {
  it('grants a valid token and rederives every join value from registry + token', () => {
    const { gate } = harness();
    const decision = gate.authorizeJoin(mint(), ORIGIN);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.grant).toEqual({
      internalCallId: 'connect_abc123de_000000000001',
      publicCallId: PUBLIC_ID,
      projectId: 'proj_abc123def456',
      subject: 'customer_8291',
      displayName: 'Ana',
      speakLanguage: 'en',
      hearLanguage: 'es',
      audioMode: 'translated',
      captionsEnabled: true,
      voiceGender: 'female',
      callType: 'personal',
      callMode: 'translated',
    });
  });

  it('an UNSIGNED token can never burn a jti — signature comes before the claim', () => {
    const { gate, jti } = harness();
    const forged = mint({ secret: WRONG_SECRET });
    expect(gate.authorizeJoin(forged, ORIGIN)).toMatchObject({ ok: false, code: 'AUTH_INVALID_TOKEN' });
    expect(jti.size).toBe(0); // nothing claimed
    // The genuine token with the same jti still works afterwards.
    expect(gate.authorizeJoin(mint(), ORIGIN).ok).toBe(true);
  });

  it('burns the jti even when a LATER check fails (R6: burned-on-failure)', () => {
    const { gate, jti } = harness();
    const token = mint();
    const refusedOnOrigin = gate.authorizeJoin(token, 'https://evil.example');
    expect(refusedOnOrigin).toMatchObject({ ok: false, code: 'FORBIDDEN_ORIGIN' });
    expect(jti.size).toBe(1);
    // Retrying with the CORRECT origin now fails on the burned token, not the origin.
    expect(gate.authorizeJoin(token, ORIGIN)).toMatchObject({ ok: false, code: 'AUTH_TOKEN_USED' });
  });

  it('fails closed when unconfigured: no secret or no registry means AUTH_INVALID_TOKEN', () => {
    expect(harness({ secret: null }).gate.authorizeJoin(mint(), ORIGIN)).toMatchObject({
      ok: false,
      code: 'AUTH_INVALID_TOKEN',
    });
    const noRegistry = new ConnectJoinGate({
      secret: SECRET,
      registry: null,
      liveCalls: new ConnectLiveCallRegistry(),
      jti: new ConnectJtiRegistry(),
      nowSeconds: () => NOW,
    });
    expect(noRegistry.authorizeJoin(mint(), ORIGIN)).toMatchObject({
      ok: false,
      code: 'AUTH_INVALID_TOKEN',
    });
  });

  it('walks the refusal ladder: expired, unknown project, inactive project, missing call, ended call', () => {
    const expired = harness();
    expect(
      expired.gate.authorizeJoin(mint({ nowSeconds: NOW - 301 }), ORIGIN),
    ).toMatchObject({ ok: false, code: 'AUTH_EXPIRED_TOKEN' });

    const unknownProject = harness();
    expect(
      unknownProject.gate.authorizeJoin(mint({ proj: 'proj_nobody000000' }), ORIGIN),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN_PROJECT' });

    const inactive = harness({ projects: [project({ active: false })] });
    expect(inactive.gate.authorizeJoin(mint(), ORIGIN)).toMatchObject({
      ok: false,
      code: 'FORBIDDEN_PROJECT',
    });

    const restart = harness({ registerCall: false }); // fresh live map = post-restart truth (R13)
    expect(restart.gate.authorizeJoin(mint(), ORIGIN)).toMatchObject({
      ok: false,
      code: 'CALL_NOT_FOUND',
    });

    const ended = harness({ ended: true });
    expect(ended.gate.authorizeJoin(mint(), ORIGIN)).toMatchObject({
      ok: false,
      code: 'CALL_ENDED',
    });
  });

  it('originless joins pass only under explicit allowOriginless (R7)', () => {
    const strict = harness();
    expect(strict.gate.authorizeJoin(mint(), null)).toMatchObject({
      ok: false,
      code: 'FORBIDDEN_ORIGIN',
    });
    const permissive = harness({ projects: [project({ allowOriginless: true })] });
    expect(permissive.gate.authorizeJoin(mint(), null).ok).toBe(true);
  });
});
