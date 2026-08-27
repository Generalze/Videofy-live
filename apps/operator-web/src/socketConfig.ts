import type { ManagerOptions, SocketOptions } from 'socket.io-client';

export type SocketClientOptions = Partial<ManagerOptions & SocketOptions>;

export function resolveSocketTransportOptions(
  transport: string | undefined,
): Pick<SocketClientOptions, 'transports' | 'upgrade'> {
  if (transport === 'polling') {
    return {
      transports: ['polling'],
      upgrade: false,
    };
  }

  return {};
}

/**
 * The C7 session, from the key every browser surface now shares.
 *
 * THIS WAS THE MISSING HALF OF THE OPERATOR GATE. The gateway's
 * operator-authority was built, tested and enforcing -- it reads
 * `handshake.auth.token` and refuses without one -- while this file sent
 * `role: 'operator'` and nothing else, so the console could not operate at
 * all. Worse, socketConfig.test.ts ASSERTED the token-less shape, locking the
 * defect in place: anybody fixing the client broke a green test and could
 * reasonably conclude they were wrong.
 *
 * The key and shape match call-web's accountSession and ecosystem-web's
 * sign-in writer. Reading it here is a third copy of that knowledge, which is
 * one more than is comfortable; lifting the session reader into a shared
 * package is the recorded follow-up.
 */
export function readOperatorSessionToken(): string | null {
  try {
    // `typeof` guard rather than `window.`: this also runs under node in
    // tests, where window does not exist and localStorage may be stubbed.
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem('videofy-account:session');
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
}

export function createOperatorSocketOptions(): SocketClientOptions {
  const token = readOperatorSessionToken();
  return {
    query: { role: 'operator' },
    /*
     * Included even when null would be tidier omitted: the gateway's one
     * refusal message tells the person to sign in, and a console that never
     * presented a credential gets exactly the same answer as one that
     * presented a bad one -- by design, on both sides.
     */
    ...(token === null ? {} : { auth: { token } }),
    ...resolveSocketTransportOptions(import.meta.env['VITE_SOCKET_TRANSPORT']),
  };
}

export function createBroadcasterSocketOptions(): SocketClientOptions {
  return {
    query: { role: 'broadcaster' },
    ...resolveSocketTransportOptions(import.meta.env['VITE_SOCKET_TRANSPORT']),
  };
}
