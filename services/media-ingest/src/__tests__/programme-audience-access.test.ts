/** @author masterzee001 */
/**
 * The rule that decides whether somebody's broadcast is public.
 *
 * Getting this wrong in one direction costs an audience a programme; getting
 * it wrong in the other publishes something that was not meant to be seen, and
 * that one cannot be taken back. So the unknown cases are asserted as loudly
 * as the known ones: an account service that will not answer, a channel with
 * no profile, and a visibility tier this code has never heard of.
 */
import type express from 'express';
import { describe, expect, it } from 'vitest';
import {
  VISIBILITY_UNRESOLVABLE,
  createChannelVisibilityClient,
  createProgrammeAudienceAccess,
  type ChannelVisibilityPort,
} from '../programme-audience-access.js';
import { INTERNAL_TOKEN_HEADER } from '../programme-control-auth.js';
import type { AuthenticateRequest } from '../account-authentication.js';
import type { ChannelVisibility } from '@videofy-live/shared-types';

/** A request carrying only the headers a test cares about. */
function requestWith(headers: Record<string, string> = {}): express.Request {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name: string) => lower.get(name.toLowerCase()) } as unknown as express.Request;
}

function fixedVisibility(visibility: ChannelVisibility | null): ChannelVisibilityPort {
  return { visibilityOf: async () => visibility };
}

const NOBODY: AuthenticateRequest = () => null;
const NO_OPERATORS = { allowedCount: 0, hasEntitlement: () => false };

function access(options: {
  visibility?: ChannelVisibilityPort;
  channelOf?: (runId: string) => string | null;
  authenticate?: AuthenticateRequest;
  entitlement?: { allowedCount: number; hasEntitlement: (id: string) => boolean };
  internalToken?: string;
}): ReturnType<typeof createProgrammeAudienceAccess> {
  return createProgrammeAudienceAccess({
    channelOf: options.channelOf ?? (() => 'ch_1'),
    visibility: options.visibility ?? fixedVisibility('public'),
    authenticate: options.authenticate ?? NOBODY,
    entitlement: options.entitlement ?? NO_OPERATORS,
    internalTokenAllowed: (presented) =>
      options.internalToken !== undefined && presented === options.internalToken,
  });
}

describe('the visibility tiers, as the founder defined them', () => {
  it('lets anybody watch a public channel', async () => {
    expect(await access({ visibility: fixedVisibility('public') }).mayView('run_1', requestWith()))
      .toBe('allow');
  });

  it('lets a link-holder watch a private channel, because that is what private means', async () => {
    /*
     * "A doorbell without a sign, not a lock." Somebody holding a run id was
     * given it. Refusing here would be enforcing a control the tier does not
     * claim to be, and would break every share link in the product.
     */
    expect(await access({ visibility: fixedVisibility('private') }).mayView('run_1', requestWith()))
      .toBe('allow');
  });

  it('refuses a locked channel, because the join code is not ours to check', async () => {
    const locked = access({ visibility: fixedVisibility('locked') });
    // Anonymous is asked to sign in; that is the only step this service can
    // usefully suggest. It cannot admit them either way.
    expect(await locked.mayView('run_1', requestWith())).toBe('sign-in');
  });

  it('refuses a locked channel to a signed-in viewer who is not the operator', async () => {
    const locked = access({
      visibility: fixedVisibility('locked'),
      authenticate: () => 'acct_viewer',
    });
    expect(await locked.mayView('run_1', requestWith())).toBe('forbidden');
  });
});

describe('what happens when visibility cannot be established', () => {
  it('refuses when the channel has no profile', async () => {
    // Not "probably public". An unresolved channel is refused, because the
    // failure that matters is publishing somebody's private broadcast.
    expect(await access({ visibility: fixedVisibility(null) }).mayView('run_1', requestWith()))
      .toBe('forbidden');
  });

  it('refuses everybody when nothing can resolve visibility at all', async () => {
    const dark = access({ visibility: VISIBILITY_UNRESOLVABLE });
    expect(await dark.mayView('run_1', requestWith())).toBe('forbidden');
  });

  it('answers unknown-run for a broadcast this process is not running', async () => {
    const elsewhere = access({ channelOf: () => null });
    expect(await elsewhere.mayView('run_absent', requestWith())).toBe('unknown-run');
  });
});

describe('the two callers that are admitted before visibility is consulted', () => {
  it('admits the gateway presenting this deployment internal token', async () => {
    const gateway = access({
      visibility: fixedVisibility(null),
      internalToken: 'the-internal-token',
    });
    // Unresolvable visibility, and still allowed: this credential already
    // creates sessions and injects audio, so watching grants it nothing new.
    expect(
      await gateway.mayView('run_1', requestWith({ [INTERNAL_TOKEN_HEADER]: 'the-internal-token' })),
    ).toBe('allow');
  });

  it('refuses a wrong internal token rather than treating it as anonymous luck', async () => {
    const gateway = access({
      visibility: fixedVisibility('locked'),
      internalToken: 'the-internal-token',
    });
    expect(await gateway.mayView('run_1', requestWith({ [INTERNAL_TOKEN_HEADER]: 'guessed' })))
      .toBe('sign-in');
  });

  it('lets the operator watch their own locked programme', async () => {
    const operator = access({
      visibility: fixedVisibility('locked'),
      authenticate: () => 'acct_operator',
      entitlement: { allowedCount: 1, hasEntitlement: (id) => id === 'acct_operator' },
    });
    // Otherwise the one person who must see the output is the one person who
    // cannot, and a locked broadcast becomes unmonitorable.
    expect(await operator.mayView('run_1', requestWith())).toBe('allow');
  });
});

describe('reading visibility from the account service', () => {
  function clientOver(
    handler: (url: string) => Promise<Response> | Response,
    now: () => number = () => 1_000,
  ): ChannelVisibilityPort {
    return createChannelVisibilityClient({
      accountServiceUrl: 'http://account.internal/',
      internalToken: 'internal-token',
      now,
      warn: () => undefined,
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => handler(String(input))) as typeof fetch,
    });
  }

  const ok = (visibility: string): Response =>
    new Response(JSON.stringify({ profiles: { ch_1: { visibility } } }), { status: 200 });

  it('reads the tier the account service holds', async () => {
    const client = clientOver(() => ok('locked'));
    expect(await client.visibilityOf('ch_1')).toBe('locked');
  });

  it('presents the internal token and asks for exactly one channel', async () => {
    let seen = '';
    const client = createChannelVisibilityClient({
      accountServiceUrl: 'http://account.internal',
      internalToken: 'internal-token',
      warn: () => undefined,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seen = String(input);
        const headers = new Headers(init?.headers);
        expect(headers.get(INTERNAL_TOKEN_HEADER)).toBe('internal-token');
        return ok('public');
      }) as typeof fetch,
    });
    await client.visibilityOf('ch_1');
    expect(seen).toBe('http://account.internal/internal/channels/profiles?ids=ch_1');
  });

  it('asks once for many viewers arriving together', async () => {
    let calls = 0;
    const client = clientOver(() => {
      calls += 1;
      return ok('public');
    });
    await Promise.all([
      client.visibilityOf('ch_1'),
      client.visibilityOf('ch_1'),
      client.visibilityOf('ch_1'),
    ]);
    // A popular programme must not turn one join into thousands of reads.
    expect(calls).toBe(1);
  });

  it('treats a tier it has never heard of as unknown, not as public', async () => {
    const client = clientOver(() => ok('super-public'));
    // A default branch written today must not admit a tier invented tomorrow.
    expect(await client.visibilityOf('ch_1')).toBeNull();
  });

  it('treats an error response as unknown', async () => {
    const client = clientOver(() => new Response('nope', { status: 500 }));
    expect(await client.visibilityOf('ch_1')).toBeNull();
  });

  it('serves a visibility it has already read when the account service stops answering', async () => {
    let at = 1_000;
    let healthy = true;
    const client = clientOver(
      () => {
        if (!healthy) throw new Error('connection refused');
        return ok('public');
      },
      () => at,
    );

    expect(await client.visibilityOf('ch_1')).toBe('public');
    healthy = false;
    // Past the TTL, inside the grace window: a value read a minute ago is not
    // a guess, and dropping an audience because another service restarted
    // would be an outage we inflicted on ourselves.
    at += 90_000;
    expect(await client.visibilityOf('ch_1')).toBe('public');
  });

  it('stops serving it once the grace window has passed', async () => {
    let at = 1_000;
    let healthy = true;
    const client = clientOver(
      () => {
        if (!healthy) throw new Error('connection refused');
        return ok('public');
      },
      () => at,
    );
    await client.visibilityOf('ch_1');
    healthy = false;
    at += 3_600_000;
    // Stale has a limit. Beyond it this is a guess again, and it fails closed.
    expect(await client.visibilityOf('ch_1')).toBeNull();
  });

  it('gives no grace to a channel it has never resolved', async () => {
    const client = clientOver(() => {
      throw new Error('connection refused');
    });
    expect(await client.visibilityOf('ch_never')).toBeNull();
  });
});
