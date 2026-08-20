/** @author masterzee001 */
/**
 * `MediaAdapterPort` over the remote wire: the client half of P6.9.
 *
 * See docs/P6_9_REMOTE_ADAPTER_WIRE_CONTRACT.md. Nothing here knows what a
 * language, a voice or a provider is, and nothing here validates a credential.
 */
export { AdapterConnection, SYSTEM_TIMERS } from './connection.js';
export type {
  AdapterConnectionDeps,
  AdapterSocket,
  AdapterSocketFactory,
  AdapterSocketHandlers,
  ConnectionState,
  ConnectionTimers,
  RemoteMediaLedger,
  StreamBinding,
} from './connection.js';

export { OutboundQueue } from './outbound-queue.js';
export type {
  CommittedFrame,
  OutboundQueueDeps,
  OutboundQueueLimits,
  QueuedFrame,
} from './outbound-queue.js';

export { RemoteMediaAdapterError, RemoteMediaAdapterPort } from './remote-port.js';
export type { RemoteMediaAdapterPortDeps } from './remote-port.js';

export type {
  CloseSessionInput,
  ControlPlaneClient,
  CreateSessionInput,
  ParticipantInput,
} from './control-client.js';
