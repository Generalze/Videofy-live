/** @author masterzee001 */
/**
 * A call, on a phone.
 *
 * WHAT THIS DOES NOT CONTAIN, and that is the point of it being short. Join
 * payloads, code validation, and the perfect-negotiation video mesh all come
 * from `@videofy-live/call-client-core` -- the same modules the web client runs.
 * Event names come from `@videofy-live/call-wire`, the same constants the
 * gateway relays on, rather than string literals that can drift on one side.
 *
 * TWO THINGS ARE GENUINELY DIFFERENT ON A PHONE, and they are all this file
 * supplies: where an `RTCPeerConnection` comes from, and where the camera and
 * microphone come from. `callVideoMesh` already accepted an injected
 * `createPeerConnection`, so the platform seam existed before this file did and
 * nothing in the mesh changed to run here. That is the reuse React Native was
 * chosen for, actually collected.
 *
 * NORMAL MODE ONLY, DELIBERATELY. Camera and microphone between participants and
 * nothing else -- no transcription, no translated audio, no generated-audio
 * queue. Normal mode is free on every channel and is the whole product for
 * anybody who shares a language, so proving it on a real handset is the question
 * worth answering before stacking a translation pipeline on top.
 *
 * MEDIA NEVER TOUCHES THE SERVER. Signalling is relayed by the gateway, which
 * validates the sender's binding and forwards to the target's private room;
 * audio and video travel peer to peer. Unchanged by this file.
 */
/*
 * ALIASED, because importing `RTCPeerConnection` under its own name SHADOWS the
 * DOM type of the same name -- and the mesh's `createPeerConnection` is typed
 * against the DOM one. Without the alias, `as unknown as RTCPeerConnection`
 * casts to the type it already had and asserts nothing, while looking exactly
 * like a cast that works.
 *
 * The two are API-compatible at RUNTIME, which is what makes the mesh portable;
 * they are not structurally identical to TypeScript, because react-native-webrtc
 * omits DOM-only members the mesh never touches.
 */
import { RTCPeerConnection as NativePeerConnection, mediaDevices } from 'react-native-webrtc';
import { io, type Socket } from 'socket.io-client';
import { CALL_EVENTS } from '@videofy-live/call-wire';
import {
  CallVideoMesh,
  type CallVideoIcePayload,
  type CallVideoSdpPayload,
} from '@videofy-live/call-client-core';

/** What the mesh hands back for a tile. Kept loose: RN streams are not DOM ones. */
export type RemoteStream = { toURL(): string } | null;

export interface CallConnectionOptions {
  readonly gatewayUrl: string;
  readonly callId: string;
  readonly participantId: string;
  readonly displayName: string;
  /**
   * ICE servers. WITHOUT THESE A CALL WORKS ON ONE WI-FI AND NOWHERE ELSE.
   *
   * Two phones on mobile data need a relay to cross carrier NAT, and the
   * failure mode is the worst kind: the call connects, reports no error, and
   * shows a black rectangle. Supplied by the deployment rather than guessed.
   */
  readonly iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  readonly onRemoteStream: (participantId: string, stream: RemoteStream) => void;
  readonly onPeerState: (participantId: string, state: string) => void;
  readonly onError: (message: string) => void;
}

/** The gateway's view of who is in the call. Only the ids are needed here. */
interface CallStatePayload {
  participants?: { participantId?: unknown }[];
}

export class CallConnection {
  private readonly options: CallConnectionOptions;
  private socket: Socket | null = null;
  private mesh: CallVideoMesh | null = null;
  private local: { toURL(): string; getTracks(): { stop(): void }[] } | null = null;

  constructor(options: CallConnectionOptions) {
    this.options = options;
  }

  /** The local camera and microphone, opened once. */
  async openLocalMedia(): Promise<{ toURL(): string }> {
    if (this.local !== null) return this.local;
    /*
     * react-native-webrtc's `mediaDevices`, not the browser's. The constraint
     * shape is identical -- which is what makes the surrounding code portable --
     * but the implementation is native and the permission prompt is Android's.
     */
    const stream = (await mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: 'user' },
    })) as unknown as { toURL(): string; getTracks(): { stop(): void }[] };
    this.local = stream;
    return stream;
  }

  async join(): Promise<void> {
    const local = await this.openLocalMedia();

    const socket = io(this.options.gatewayUrl, {
      transports: ['websocket'],
      // A phone changes network constantly; reconnecting is the normal case.
      reconnection: true,
    });
    this.socket = socket;

    const mesh = new CallVideoMesh({
      callId: this.options.callId,
      selfParticipantId: this.options.participantId,
      ...(this.options.iceServers === undefined
        ? {}
        : { iceServers: this.options.iceServers as RTCIceServer[] }),
      // THE PLATFORM SEAM. Everything else is shared with the web client.
      createPeerConnection: () =>
        new NativePeerConnection({
          iceServers: this.options.iceServers ?? [],
        }) as unknown as RTCPeerConnection,
      sendOffer: (payload: CallVideoSdpPayload) => socket.emit(CALL_EVENTS.VIDEO_OFFER, payload),
      sendAnswer: (payload: CallVideoSdpPayload) => socket.emit(CALL_EVENTS.VIDEO_ANSWER, payload),
      sendIce: (payload: CallVideoIcePayload) => socket.emit(CALL_EVENTS.VIDEO_ICE, payload),
      onRemoteStream: (participantId: string, stream: MediaStream | null) =>
        this.options.onRemoteStream(participantId, stream as unknown as RemoteStream),
      onPeerState: (participantId: string, state: RTCPeerConnectionState) =>
        this.options.onPeerState(participantId, String(state)),
    });
    this.mesh = mesh;
    mesh.setLocalStream(local as unknown as MediaStream);

    /*
     * The SENDER is in the payload, not in a separate argument: the gateway
     * relays the object the sender built, and `participantId` on it is whoever
     * sent it. Passing the target by mistake would make every peer negotiate
     * with itself.
     */
    socket.on(CALL_EVENTS.VIDEO_OFFER, (payload: CallVideoSdpPayload) => {
      void mesh.handleOffer(payload.participantId, payload);
    });
    socket.on(CALL_EVENTS.VIDEO_ANSWER, (payload: CallVideoSdpPayload) => {
      void mesh.handleAnswer(payload.participantId, payload);
    });
    socket.on(CALL_EVENTS.VIDEO_ICE, (payload: CallVideoIcePayload) => {
      void mesh.handleIce(payload.participantId, payload);
    });

    /*
     * Membership drives the mesh. `syncParticipants` creates and tears down
     * peers, so the mesh follows the gateway's view rather than keeping its own
     * -- two views of who is in a call is how a departed peer keeps a tile.
     */
    socket.on(CALL_EVENTS.STATE, (payload: CallStatePayload) => {
      const remotes = (payload?.participants ?? [])
        .map((entry) => String(entry?.participantId ?? ''))
        .filter((id) => id.length > 0 && id !== this.options.participantId);
      mesh.syncParticipants(remotes);
    });

    socket.on(CALL_EVENTS.ERROR, (payload: { message?: string }) =>
      this.options.onError(payload?.message ?? 'The call service refused this call.'),
    );
    socket.on('connect_error', () => this.options.onError('Could not reach the call service.'));

    socket.emit(CALL_EVENTS.JOIN, {
      callId: this.options.callId,
      participantId: this.options.participantId,
      displayName: this.options.displayName,
    });
  }

  setCameraEnabled(enabled: boolean): void {
    this.mesh?.setCameraEnabled(enabled);
  }

  /**
   * Leave, and release the camera.
   *
   * Tracks are stopped EXPLICITLY rather than left to garbage collection. On
   * Android an un-stopped camera track keeps the hardware held and the privacy
   * indicator lit, which looks exactly like an app watching somebody after they
   * hung up.
   */
  leave(): void {
    try {
      this.socket?.emit(CALL_EVENTS.LEAVE, {
        callId: this.options.callId,
        participantId: this.options.participantId,
      });
    } catch {
      // Best effort; the gateway times a participant out regardless.
    }

    this.mesh?.dispose();
    this.mesh = null;
    this.socket?.disconnect();
    this.socket = null;

    for (const track of this.local?.getTracks() ?? []) track.stop();
    this.local = null;
  }
}
