/** @author masterzee001 */
/**
 * The gateway's end of the remote adapter wire.
 *
 * A package rather than a file inside the gateway, so the protocol can be
 * tested without a gateway, a chunker or a socket. The gateway HOSTS this in
 * Step 6 and supplies the two injected pieces — how a stream resolves to a
 * session, and what happens to an accepted frame — which is where adapter
 * ingress genuinely belongs.
 */
export { AdapterIngressConnection } from './ingress-server.js';
export type {
  AdapterMediaSink,
  IngressConnectionDeps,
  IngressMediaFrame,
  IngressSocket,
  ResolvedStream,
  StreamResolver,
} from './ingress-server.js';
