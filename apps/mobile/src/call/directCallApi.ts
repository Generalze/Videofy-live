/** @author masterzee001 */
/**
 * The telephone's three questions a device asks BEFORE it is in the call's
 * socket room -- against the gateway, with the account session:
 *
 *   should I ring for this push?   GET  /calls/direct/:callId
 *   I am showing the incoming call POST /calls/direct/:callId/ringing
 *   the person declined            POST /calls/direct/:callId/decline
 *
 * A push is only a wake-up (founder ruling 2026-08-28): a stale one is
 * answered 'expired' by the server and must stay silent. Every failure here
 * resolves to "don't ring" or "no effect" -- never a thrown error into a
 * notification handler.
 */

export interface DirectCallCheck {
  readonly ring: boolean;
  readonly state: string;
  readonly mode: 'normal' | 'translated';
  readonly callerAccountId: string;
  readonly callerName: string;
}

export interface DirectCallApi {
  check(callId: string): Promise<DirectCallCheck | null>;
  ackRinging(callId: string): Promise<boolean>;
  decline(callId: string): Promise<boolean>;
}

export function createDirectCallApi(options: {
  readonly gatewayUrl: string;
  readonly sessionToken: () => string | null;
  readonly fetchImpl?: typeof fetch;
}): DirectCallApi {
  const base = options.gatewayUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const call = async (path: string, method: 'GET' | 'POST'): Promise<unknown | null> => {
    const token = options.sessionToken();
    if (token === null) return null;
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  };
  return {
    async check(callId) {
      const body = (await call(`/calls/direct/${encodeURIComponent(callId)}`, 'GET')) as
        | (Partial<DirectCallCheck> & { ring?: unknown })
        | null;
      if (body === null || typeof body.state !== 'string') return null;
      return {
        ring: body.ring === true,
        state: body.state,
        mode: body.mode === 'translated' ? 'translated' : 'normal',
        callerAccountId: typeof body.callerAccountId === 'string' ? body.callerAccountId : '',
        callerName: typeof body.callerName === 'string' ? body.callerName : 'Caller',
      };
    },
    async ackRinging(callId) {
      const body = (await call(`/calls/direct/${encodeURIComponent(callId)}/ringing`, 'POST')) as
        | { live?: unknown }
        | null;
      return body?.live === true;
    },
    async decline(callId) {
      const body = (await call(`/calls/direct/${encodeURIComponent(callId)}/decline`, 'POST')) as
        | { declined?: unknown }
        | null;
      return body?.declined === true;
    },
  };
}

/** The words for the server's state, with the person's name where it belongs. */
export function directStateWords(state: string, peerName: string): string {
  switch (state) {
    case 'calling':
      return `Calling ${peerName}…`;
    case 'ringing':
      return 'Ringing…';
    case 'answered':
      return `${peerName} answered`;
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Network issue — reconnecting…';
    case 'busy':
      return `${peerName} is busy`;
    case 'declined':
      return 'Call declined';
    case 'no_answer':
      return 'No answer';
    case 'unavailable':
      return `${peerName} couldn’t be reached`;
    case 'network':
      return 'Call ended because of a network problem';
    case 'ended':
      return 'Call ended';
    default:
      return state;
  }
}

export const TERMINAL_DIRECT_STATES: ReadonlySet<string> = new Set([
  'busy',
  'declined',
  'no_answer',
  'unavailable',
  'network',
  'ended',
]);
