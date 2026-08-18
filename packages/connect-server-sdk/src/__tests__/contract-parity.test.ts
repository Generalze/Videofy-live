/** @owner masterzee001 */
/**
 * The SDK's hand-written public types must stay structurally true to
 * @videofy-live/connect-contracts. The type-level assertions below fail the
 * package typecheck the moment the contract drifts; the runtime test pins the
 * error-code taxonomy list-for-list.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { CONNECT_ERROR_CODES } from '@videofy-live/connect-contracts';
import type {
  AudioMode as ContractAudioMode,
  CallMode as ContractCallMode,
  CallStateResponse,
  CallType as ContractCallType,
  CapabilitiesResponse,
  ConnectErrorCode,
  CreateCallRequestSchema,
  JoinParticipantEcho,
  JoinTokenRequestSchema,
  JoinTokenResponse,
  VoiceGender as ContractVoiceGender,
} from '@videofy-live/connect-contracts';
import type {
  AudioMode,
  CallMode,
  CallState,
  CallType,
  Capabilities,
  CreateCallInput,
  CreateJoinTokenInput,
  JoinParticipant,
  JoinToken,
  VideofyErrorCode,
  VideofyFetch,
  VoiceGender,
} from '../index.js';

type Extends<A, B> = [A] extends [B] ? true : false;
type Mutual<A, B> = Extends<A, B> extends true ? Extends<B, A> : false;
type Expect<T extends true> = T;

/* eslint-disable @typescript-eslint/no-unused-vars */
type _errorCodes = Expect<Mutual<VideofyErrorCode, ConnectErrorCode>>;
type _callType = Expect<Mutual<CallType, ContractCallType>>;
type _callMode = Expect<Mutual<CallMode, ContractCallMode>>;
type _audioMode = Expect<Mutual<AudioMode, ContractAudioMode>>;
type _voiceGender = Expect<Mutual<VoiceGender, ContractVoiceGender>>;
type _capabilities = Expect<Mutual<Capabilities, CapabilitiesResponse>>;
type _joinEcho = Expect<Mutual<JoinParticipant, JoinParticipantEcho>>;
type _joinToken = Expect<Mutual<JoinToken, JoinTokenResponse>>;
type _callState = Expect<Extends<CallStateResponse, CallState>>;
type _createInput = Expect<Extends<CreateCallInput, z.input<typeof CreateCallRequestSchema>>>;
type _joinInput = Expect<Extends<CreateJoinTokenInput, z.input<typeof JoinTokenRequestSchema>>>;
/** Node 18+ global fetch must satisfy the SDK's structural fetch type. */
type _nativeFetch = Expect<Extends<typeof fetch, VideofyFetch>>;
/* eslint-enable @typescript-eslint/no-unused-vars */

const PUBLIC_ERROR_CODES: VideofyErrorCode[] = [
  'AUTH_INVALID_KEY',
  'AUTH_INVALID_TOKEN',
  'AUTH_EXPIRED_TOKEN',
  'AUTH_TOKEN_USED',
  'FORBIDDEN_PROJECT',
  'FORBIDDEN_ORIGIN',
  'CALL_NOT_FOUND',
  'CALL_FULL',
  'CALL_ENDED',
  'SUBJECT_ALREADY_ACTIVE',
  'DISPLAY_NAME_TAKEN',
  'OWNER_REQUIRED',
  'INVALID_MODE',
  'INVALID_LANGUAGE',
  'INVALID_REQUEST',
  'MEDIA_PERMISSION_DENIED',
  'MEDIA_UNAVAILABLE',
  'CONNECTION_LOST',
  'TRANSLATION_UNAVAILABLE',
  'GENERATED_AUDIO_UNAVAILABLE',
  'UNSUPPORTED_CAPABILITY',
  'RATE_LIMITED',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL',
];

describe('contract parity', () => {
  it('the public error-code union covers exactly the 24-code contract taxonomy', () => {
    expect(CONNECT_ERROR_CODES).toHaveLength(24);
    expect([...PUBLIC_ERROR_CODES].sort()).toEqual([...CONNECT_ERROR_CODES].sort());
  });
});
