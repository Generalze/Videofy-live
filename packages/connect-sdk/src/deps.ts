/** @owner masterzee001 */
/**
 * Injectable platform dependencies. The default set targets a real browser;
 * node tests hand in fakes, reusing the injection points the relocated
 * call-client-core modules already expose.
 */
import { io } from 'socket.io-client';
import {
  createBrowserGeneratedAudioPlayer,
  createCallSocketOptions,
  defaultResumeStorage,
} from '@videofy-live/call-client-core';
import type {
  AudioOutputPlatformDeps,
  CallAudioOutputController,
  CallGeneratedAudioPlayer,
  LifecycleDocumentLike,
  LifecycleTargetLike,
  RemoteAudioElementLike,
  ResumeStorageLike,
} from '@videofy-live/call-client-core';
import type { VideofyClientConfig } from './publicTypes';

/**
 * The socket shape the engine drives. socket.io's Socket satisfies it; the
 * test fake implements it directly (including timeout().emit acks).
 */
export interface ConnectSocketLike {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  emit(event: string, payload?: unknown, ack?: (...args: any[]) => void): void;
  timeout(ms: number): {
    emit(event: string, payload: unknown, cb: (err: unknown, ack?: any) => void): void;
  };
}

export interface ConnectSdkDeps {
  createSocket(gatewayUrl: string): ConnectSocketLike;
  /** Where resume credentials persist across a reload; null disables that. */
  resumeStorage: ResumeStorageLike | null;
  /** Null when the platform cannot capture media at all. */
  getUserMedia: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null;
  createGeneratedAudioPlayer(output: CallAudioOutputController): CallGeneratedAudioPlayer;
  /** Element factory for per-speaker original playback; browser default when absent. */
  createSpeakerElement?: () => RemoteAudioElementLike;
  /** RTCPeerConnection factory; absent in node, where peers fail closed. */
  createPeerConnection?: () => RTCPeerConnection;
  audioOutputPlatform?: AudioOutputPlatformDeps;
  lifecycleDocument?: LifecycleDocumentLike | null;
  lifecycleWindow?: LifecycleTargetLike | null;
  now(): number;
}

export function defaultConnectSdkDeps(_config: VideofyClientConfig): ConnectSdkDeps {
  return {
    createSocket: (gatewayUrl) =>
      io(gatewayUrl, createCallSocketOptions()) as unknown as ConnectSocketLike,
    resumeStorage: defaultResumeStorage(),
    getUserMedia:
      typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
        ? (constraints) => navigator.mediaDevices.getUserMedia(constraints)
        : null,
    createGeneratedAudioPlayer: (output) =>
      createBrowserGeneratedAudioPlayer({ outputController: output }),
    now: () => Date.now(),
  };
}
