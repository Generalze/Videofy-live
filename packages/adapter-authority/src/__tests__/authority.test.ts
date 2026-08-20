/** @author masterzee001 */
/**
 * The negative-security matrix, as tests rather than intentions.
 *
 * Every row here is an attack or a misconfiguration that must be refused. A
 * security matrix that passes by accident is worse than none, because it is
 * believed — so each of these is mutation-checked, the defect reintroduced and
 * the pin required to fail.
 */
import { describe, expect, it } from 'vitest';
import { AdapterAuthority } from '../authority.js';

const HOUR = 60 * 60 * 1000;

function authority(startMs = 1_000_000) {
  const clock = { now: startMs };
  const auth = new AdapterAuthority({
    now: () => clock.now,
    capabilityTtlMs: HOUR,
  });
  return { auth, clock };
}

/** A route credential and one live session on it, the ordinary starting point. */
function liveSession(startMs = 1_000_000) {
  const { auth, clock } = authority(startMs);
  const route = auth.issueRouteCredential({ adapterId: 'sip-adapter-1', routes: ['route_17'] });
  const grant = auth.createSession({
    credential: route.credential,
    adapterSessionRef: 'sc_1',
    routeRef: 'route_17',
    idempotencyKey: 'sip-adapter-1:route_17:sc_1',
  });
  if (typeof grant === 'string') throw new Error(`expected a grant, got ${grant}`);
  auth.announceParticipant(grant.capability, 'sp_1');
  return { auth, clock, route, grant };
}

describe('a capability resolves the session; it never accepts one', () => {
  it('PIN: session identity is an OUTPUT, minted by the platform', () => {
    const { grant } = liveSession();
    // Nothing the adapter sent contributes to it. `authorize` has no parameter
    // for a session, so "write into someone else's session" cannot be said.
    expect(grant.videofySessionId).toMatch(/^cs_/);
    expect(grant.videofySessionId).not.toContain('sc_1');
  });

  it('PIN: capability A cannot touch session B', () => {
    const { auth, route } = liveSession();
    const second = auth.createSession({
      credential: route.credential,
      adapterSessionRef: 'sc_2',
      routeRef: 'route_17',
      idempotencyKey: 'sip-adapter-1:route_17:sc_2',
    });
    if (typeof second === 'string') throw new Error(second);
    const first = liveSession().grant;

    // Each capability resolves to its own session and no other. There is no
    // argument by which one could name the other.
    const a = auth.authorize(second.capability, 'stop-session');
    expect(typeof a === 'string' ? a : a.videofySessionId).toBe(second.videofySessionId);
    expect(second.videofySessionId).not.toBe(first.videofySessionId);
  });
});

describe('a route credential may create sessions, and nothing else', () => {
  it('PIN: a route credential used as a capability is refused', () => {
    const { auth, route } = liveSession();
    // Refused on SHAPE, before any table is consulted: the prefixes differ, so
    // this is not a check somebody could forget on one path.
    expect(auth.authorize(route.credential, 'push-audio', 'sp_1')).toBe('rejected-auth');
    expect(auth.authorize(route.credential, 'stop-session')).toBe('rejected-auth');
    expect(auth.announceParticipant(route.credential, 'sp_2')).toBe('rejected-auth');
  });

  it('PIN: a capability used as a route credential is refused', () => {
    const { auth, grant } = liveSession();
    expect(
      auth.createSession({
        credential: grant.capability,
        adapterSessionRef: 'sc_9',
        routeRef: 'route_17',
        idempotencyKey: 'k9',
      }),
    ).toBe('rejected-auth');
  });

  it('PIN: an adapter cannot originate on a route it was not given', () => {
    const { auth, route } = liveSession();
    expect(
      auth.createSession({
        credential: route.credential,
        adapterSessionRef: 'sc_x',
        routeRef: 'route_99',
        idempotencyKey: 'kx',
      }),
    ).toBe('rejected-route');
  });

  it('PIN: one adapter cannot use another adapter route credential', () => {
    const { auth } = authority();
    const mine = auth.issueRouteCredential({ adapterId: 'adapter-a', routes: ['route_a'] });
    const theirs = auth.issueRouteCredential({ adapterId: 'adapter-b', routes: ['route_b'] });
    // Holding my own credential does not let me originate on their route.
    expect(
      auth.createSession({
        credential: mine.credential,
        adapterSessionRef: 'sc_1',
        routeRef: 'route_b',
        idempotencyKey: 'k1',
      }),
    ).toBe('rejected-route');
    expect(theirs.credential).not.toBe(mine.credential);
  });
});

describe('nothing works without the right secret', () => {
  it('PIN: no credential at all is refused', () => {
    const { auth } = authority();
    for (const bogus of ['', 'nonsense', 'vfr_', 'vfr_x', 'vfr_x.', 'vfc_x.y']) {
      expect(
        auth.createSession({
          credential: bogus,
          adapterSessionRef: 'sc_1',
          routeRef: 'route_17',
          idempotencyKey: 'k',
        }),
      ).toBe('rejected-auth');
      expect(auth.authorize(bogus, 'push-audio', 'sp_1')).toBe('rejected-auth');
    }
  });

  it('PIN: the right id with the wrong secret is refused', () => {
    const { auth, route, grant } = liveSession();
    const routeId = route.credential.split('.')[0]!;
    const capabilityId = grant.capability.split('.')[0]!;
    expect(
      auth.createSession({
        credential: `${routeId}.deadbeef`,
        adapterSessionRef: 'sc_1',
        routeRef: 'route_17',
        idempotencyKey: 'k',
      }),
    ).toBe('rejected-auth');
    expect(auth.authorize(`${capabilityId}.deadbeef`, 'push-audio', 'sp_1')).toBe('rejected-auth');
  });
});

describe('expiry, revocation and rotation', () => {
  it('PIN: an expired capability is refused', () => {
    const { auth, clock, grant } = liveSession();
    expect(typeof auth.authorize(grant.capability, 'push-audio', 'sp_1')).toBe('object');
    clock.now += HOUR + 1;
    expect(auth.authorize(grant.capability, 'push-audio', 'sp_1')).toBe('rejected-stale');
  });

  it('PIN: a revoked capability is refused without waiting for expiry', () => {
    const { auth, grant } = liveSession();
    auth.revokeCapability(grant.capabilityId);
    expect(auth.authorize(grant.capability, 'push-audio', 'sp_1')).toBe('rejected-auth');
  });

  it('PIN: a capability stops working the moment its session closes', () => {
    const { auth, grant } = liveSession();
    expect(typeof auth.closeSession(grant.capability)).toBe('object');
    expect(auth.authorize(grant.capability, 'push-audio', 'sp_1')).toBe('rejected-stale');
    expect(auth.closeSession(grant.capability)).toBe('rejected-stale');
  });

  it('PIN: a revoked route credential creates no further sessions', () => {
    const { auth, route } = liveSession();
    auth.revokeRouteCredential(route.id);
    expect(
      auth.createSession({
        credential: route.credential,
        adapterSessionRef: 'sc_new',
        routeRef: 'route_17',
        idempotencyKey: 'k-new',
      }),
    ).toBe('rejected-auth');
  });

  it('PIN: an expired route credential creates no further sessions', () => {
    const { auth, clock } = authority();
    const route = auth.issueRouteCredential({
      adapterId: 'a',
      routes: ['route_17'],
      expiresAtMs: clock.now + HOUR,
    });
    clock.now += HOUR + 1;
    expect(
      auth.createSession({
        credential: route.credential,
        adapterSessionRef: 'sc_1',
        routeRef: 'route_17',
        idempotencyKey: 'k',
      }),
    ).toBe('rejected-auth');
  });

  it('PIN: rotation invalidates the old secret and keeps the sessions it made', () => {
    const { auth, route, grant } = liveSession();
    const rotated = auth.rotateRouteCredential(route.id)!;
    expect(rotated.credential).not.toBe(route.credential);

    // The old secret is dead.
    expect(
      auth.createSession({
        credential: route.credential,
        adapterSessionRef: 'sc_after',
        routeRef: 'route_17',
        idempotencyKey: 'k-after',
      }),
    ).toBe('rejected-auth');
    // The new one works, and an already-live session is untouched — rotation
    // is not revocation, and a call in progress has its own capability.
    expect(
      typeof auth.createSession({
        credential: rotated.credential,
        adapterSessionRef: 'sc_after',
        routeRef: 'route_17',
        idempotencyKey: 'k-after',
      }),
    ).toBe('object');
    expect(typeof auth.authorize(grant.capability, 'push-audio', 'sp_1')).toBe('object');
  });
});

describe('session creation is retry-safe', () => {
  it('PIN: a duplicate create yields the same session, not a second one', () => {
    const { auth, route, grant } = liveSession();
    const retry = auth.createSession({
      credential: route.credential,
      adapterSessionRef: 'sc_1',
      routeRef: 'route_17',
      idempotencyKey: 'sip-adapter-1:route_17:sc_1',
    });
    if (typeof retry === 'string') throw new Error(retry);
    // SIP retransmits. A lost response must not leave a second session alive
    // holding resources nothing will ever close.
    expect(retry.videofySessionId).toBe(grant.videofySessionId);
    expect(retry.idempotentReplay).toBe(true);
    // A fresh secret, so a response captured in transit is not reusable.
    expect(retry.capability).not.toBe(grant.capability);
    expect(typeof auth.authorize(retry.capability, 'stop-session')).toBe('object');
  });

  it('PIN: another adapter cannot adopt a binding by guessing its key', () => {
    const { auth } = authority();
    const mine = auth.issueRouteCredential({ adapterId: 'adapter-a', routes: ['shared_route'] });
    const theirs = auth.issueRouteCredential({ adapterId: 'adapter-b', routes: ['shared_route'] });
    const key = 'a-guessable-key';
    const first = auth.createSession({
      credential: mine.credential,
      adapterSessionRef: 'sc_1',
      routeRef: 'shared_route',
      idempotencyKey: key,
    });
    expect(typeof first).toBe('object');
    // Same key, same route, different adapter: refused rather than handed
    // somebody else's live session.
    expect(
      auth.createSession({
        credential: theirs.credential,
        adapterSessionRef: 'sc_1',
        routeRef: 'shared_route',
        idempotencyKey: key,
      }),
    ).toBe('rejected-auth');
  });
});

describe('media follows the participant, not the session alone', () => {
  it('PIN: audio for an unannounced participant is refused', () => {
    const { auth, grant } = liveSession();
    expect(auth.authorize(grant.capability, 'push-audio', 'sp_stranger')).toBe('rejected-participant');
    expect(auth.authorize(grant.capability, 'push-audio')).toBe('rejected-participant');
  });

  it('PIN: a withdrawn participant may no longer be spoken for', () => {
    const { auth, grant } = liveSession();
    expect(typeof auth.authorize(grant.capability, 'push-audio', 'sp_1')).toBe('object');
    auth.withdrawParticipant(grant.capability, 'sp_1');
    expect(auth.authorize(grant.capability, 'push-audio', 'sp_1')).toBe('rejected-participant');
  });
});

describe('secrets do not leak', () => {
  it('PIN: nothing but issuance ever returns a secret', () => {
    const { auth, route, grant } = liveSession();
    const routeSecret = route.credential.split('.')[1]!;
    const capabilitySecret = grant.capability.split('.')[1]!;

    const resolved = auth.authorize(grant.capability, 'stop-session');
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain(routeSecret);
    expect(serialized).not.toContain(capabilitySecret);

    // The refusal path is where a careless implementation echoes the input
    // back, and refusals are exactly what ends up in logs and tickets.
    expect(JSON.stringify(auth.authorize('vfc_nope.secret-value', 'stop-session'))).not.toContain(
      'secret-value',
    );
  });

  it('secrets are long enough not to be guessed', () => {
    const { route, grant } = liveSession();
    expect(route.credential.split('.')[1]!.length).toBeGreaterThanOrEqual(64);
    expect(grant.capability.split('.')[1]!.length).toBeGreaterThanOrEqual(64);
    expect(route.credential).not.toBe(liveSession().route.credential);
  });
});
