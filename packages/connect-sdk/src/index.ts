/** @owner masterzee001 */
/**
 * @videofy/connect — the public client SDK for Videofy Connect.
 *
 * Everything exported here is public contract. The state model and event
 * vocabulary are re-exported from the Connect contracts so an integrator
 * needs exactly one import.
 */
export { createVideofyClient } from './client';
export { VideofyConnectError } from './errors';
export type {
  AudioOutputCapabilities,
  AudioOutputDeviceInfo,
  ConnectLogger,
  JoinMediaOptions,
  JoinOptions,
  VideoElementSurface,
  VideofyCall,
  VideofyClient,
  VideofyClientConfig,
} from './publicTypes';
export type {
  AudioMode,
  AudioOutputCapability,
  CallCaptionView,
  CallMode,
  CallParticipantView,
  CallSelfView,
  CallSnapshot,
  CallType,
  ConnectErrorCode,
  ConnectEventMap,
  ConnectEventName,
  ConnectPublicError,
  ConnectionState,
  DeliveryState,
  LanguageTag,
  PublicCallId,
  VoiceGender,
} from '@videofy-live/connect-contracts';
