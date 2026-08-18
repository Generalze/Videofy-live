/** @owner masterzee001 */
/**
 * Test fakes, following the injection patterns the call-client-core suites
 * established: scripted socket acks, a settle-immediately player, in-memory
 * storage and fake media streams.
 */
import type { CallGeneratedAudioPlayer, ResumeStorageLike } from '@videofy-live/call-client-core';
import type { CallStateSnapshot } from '@videofy-live/call-client-core';
import type { ConnectSdkDeps, ConnectSocketLike } from '../deps';
import type { VideofyClientConfig } from '../publicTypes';

export const TEST_PUBLIC_CALL_ID = 'vc_Abc123Def456Gh78';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export interface TestTokenOverrides {
  aud?: unknown;
  call?: unknown;
  sub?: unknown;
  name?: unknown;
  prefs?: unknown;
}

/** A structurally valid (unverified) Connect join token for tests. */
export function buildTestToken(overrides: TestTokenOverrides = {}): string {
  const claims = {
    aud: 'vc-join',
    proj: 'proj_test00000',
    call: TEST_PUBLIC_CALL_ID,
    sub: 'customer_8291',
    name: 'Ana',
    prefs: { speak: 'es', hear: 'es', audioMode: 'translated', captions: true, voiceGender: 'female' },
    jti: 'jti-test',
    iat: 1_755_500_000,
    exp: 1_755_500_300,
    ...overrides,
  };
  return `${base64Url(JSON.stringify(claims))}.${base64Url('signature')}`;
}

type Listener = (...args: unknown[]) => void;

/**
 * A scripted socket. `respond` decides the ack for each emitted event; events
 * with no scripted response time out (timeout-emits) or go unacked.
 */
export class FakeSocket implements ConnectSocketLike {
  connected = false;
  readonly sent: { event: string; payload: unknown }[] = [];
  respond: ((event: string, payload: unknown) => unknown) | null = null;
  private readonly handlers = new Map<string, Set<Listener>>();

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.fire('connect');
  }

  disconnect(): void {
    this.connected = false;
  }

  on(event: string, listener: Listener): void {
    let bucket = this.handlers.get(event);
    if (!bucket) {
      bucket = new Set();
      this.handlers.set(event, bucket);
    }
    bucket.add(listener);
  }

  off(event: string, listener: Listener): void {
    this.handlers.get(event)?.delete(listener);
  }

  emit(event: string, payload?: unknown, ack?: (...args: unknown[]) => void): void {
    this.sent.push({ event, payload });
    const response = this.respond?.(event, payload);
    if (ack && response !== undefined) {
      queueMicrotask(() => ack(response));
    }
  }

  timeout(_ms: number): {
    emit(event: string, payload: unknown, cb: (err: unknown, ack?: unknown) => void): void;
  } {
    return {
      emit: (event, payload, cb) => {
        this.sent.push({ event, payload });
        const response = this.respond?.(event, payload);
        queueMicrotask(() => {
          if (response === undefined) cb(new Error('ack timeout'));
          else cb(null, response);
        });
      },
    };
  }

  /** Deliver a server-pushed event to the client. */
  fire(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.handlers.get(event) ?? [])]) {
      listener(...args);
    }
  }

  /** Network drop as socket.io reports it. */
  dropConnection(): void {
    this.connected = false;
    this.fire('disconnect');
  }

  /** Transport recovered; socket.io fires connect again. */
  reconnect(): void {
    this.connected = true;
    this.fire('connect');
  }

  sentOf(event: string): { event: string; payload: unknown }[] {
    return this.sent.filter((entry) => entry.event === event);
  }
}

export class MemoryStorage implements ResumeStorageLike {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  size(): number {
    return this.map.size;
  }
}

export function fakePlayer(): CallGeneratedAudioPlayer {
  return {
    volume: 1,
    onended: null,
    onerror: null,
    play: async () => {},
    pause: () => {},
    unlock: async () => true,
    dispose: () => {},
  };
}

interface FakeTrack {
  kind: string;
  enabled: boolean;
  readyState: string;
  contentHint: string;
  stop(): void;
}

export function fakeMediaStream(kind: 'audio' | 'video' = 'audio'): MediaStream {
  const track: FakeTrack = {
    kind,
    enabled: true,
    readyState: 'live',
    contentHint: '',
    stop() {
      this.readyState = 'ended';
    },
  };
  const stream = {
    getAudioTracks: () => (kind === 'audio' ? [track] : []),
    getVideoTracks: () => (kind === 'video' ? [track] : []),
    getTracks: () => [track],
  };
  return stream as unknown as MediaStream;
}

export interface TestHarness {
  config: VideofyClientConfig;
  deps: ConnectSdkDeps;
  socket: FakeSocket;
  storage: MemoryStorage;
}

/**
 * Deps wired for node: the fake socket auto-connects on a microtask (like a
 * real transport), media is granted instantly, and there is no WebRTC — peer
 * establishment fails closed exactly as it does in an old browser.
 */
export function makeHarness(): TestHarness {
  const socket = new FakeSocket();
  const storage = new MemoryStorage();
  const deps: ConnectSdkDeps = {
    createSocket: () => {
      queueMicrotask(() => socket.connect());
      return socket;
    },
    resumeStorage: storage,
    getUserMedia: async (constraints) =>
      fakeMediaStream(constraints && 'video' in (constraints as object) ? 'video' : 'audio'),
    createGeneratedAudioPlayer: () => fakePlayer(),
    lifecycleDocument: null,
    lifecycleWindow: null,
    now: () => 1_755_500_100_000,
  };
  return { config: { baseUrl: 'http://gateway.test' }, deps, socket, storage };
}

export function wireSnapshot(overrides: Partial<CallStateSnapshot> = {}): CallStateSnapshot {
  return {
    callId: 'connect_projtest_abc123def456',
    state: 'active',
    callType: 'personal',
    callMode: 'translated',
    ownerParticipantId: 'participant_1',
    transcriptDownloadAllowed: true,
    participants: [
      {
        participantId: 'participant_1',
        displayName: 'Ana',
        speakLanguage: 'es',
        hearLanguage: 'es',
        joined: true,
      },
    ],
    ...overrides,
  };
}

export function okJoinAck(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    participantId: 'participant_1',
    resumeToken: 'resume-secret-1',
    snapshot: wireSnapshot(),
    ...overrides,
  };
}

/** Waits until queued microtasks and scripted acks have settled. */
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}
