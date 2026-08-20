/** @author masterzee001 */
/**
 * The HTTPS control plane, as the client sees it.
 *
 * An interface rather than a concrete fetch, so every test in this package runs
 * without a network and every concurrency race can be made deterministic. The
 * HTTP implementation lives behind it and is the only part that needs a socket.
 *
 * Step 5 owns credential issuance and validation. These signatures thread the
 * reserved opaque slots — `sessionCapability` in, and out of `createSession` —
 * without inspecting them, so adding authority later is not a transport
 * redesign. No interim shared secret is invented here.
 */
import type { CreateSessionResponse } from '@videofy-live/adapter-wire';

export interface CreateSessionInput {
  readonly adapterSessionRef: string;
  readonly routeRef: string;
  readonly idempotencyKey: string;
  readonly platformSessionRef: string;
}

export interface ParticipantInput {
  readonly adapterSessionRef: string;
  readonly sessionCapability: string;
  readonly participantId: string;
  readonly displayName?: string;
}

export interface CloseSessionInput {
  readonly adapterSessionRef: string;
  readonly sessionCapability: string;
  readonly reason: string;
}

export interface ControlPlaneClient {
  createSession(input: CreateSessionInput): Promise<CreateSessionResponse>;
  announceParticipant(input: ParticipantInput): Promise<void>;
  withdrawParticipant(input: Omit<ParticipantInput, 'displayName'>): Promise<void>;
  closeSession(input: CloseSessionInput): Promise<void>;
}
