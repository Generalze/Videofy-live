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
  CALL_REMOTE_SLOT_COUNT,
  CallPeer,
  CallVideoMesh,
  buildCallIcePayload,
  buildCallJoinPayload,
  buildCallSdpPayload,
  createCallSocketOptions,
  createInitialCallJoinForm,
  fetchIceServers,
  type CallJoinAck,
  type CallSdpAck,
  type CallStateSnapshot,
  type CallVideoIcePayload,
  type CallVideoSdpPayload,
} from '@videofy-live/call-client-core';

/** Long enough for a cold gateway, short enough that nobody stares at a spinner. */
const ACK_TIMEOUT_MS = 15_000;

/** What the mesh hands back for a tile. Kept loose: RN streams are not DOM ones. */
export type RemoteStream = { toURL(): string } | null;

export interface CallConnectionOptions {
  readonly gatewayUrl: string;
  readonly callId: string;
  readonly displayName: string;
  /**
   * The signed session token, or null.
   *
   * REQUIRED TO CREATE A CALL. The gateway checks `session.host` before the
   * store is touched, and an unsigned join that would create a call is refused
   * with `host-not-authorized`. Joining a call that already exists does not
   * need one -- which is exactly the product rule: verified accounts start
   * calls, anybody can be invited into one.
   *
   * There is deliberately no participantId here. The gateway derives it from
   * this token, because a client that could name an account could name
   * somebody else's.
   */
  readonly sessionToken: string | null;
  /**
   * ICE servers, if a caller wants to override.
   *
   * NORMALLY LEFT UNSET. The gateway serves them at `/webrtc/ice` with
   * short-lived TURN credentials minted from a static secret, which is where
   * the web client gets them and is the only source that can rotate. Baking
   * them into the app would freeze a credential into every install.
   */
  readonly iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  readonly onRemoteStream: (participantId: string, stream: RemoteStream) => void;
  readonly onPeerState: (participantId: string, state: string) => void;
  readonly onError: (message: string) => void;
  /**
   * The OTHER joined participants the gateway reports, names included.
   *
   * Surfaced because "nobody else is here" and "somebody is here and the media
   * has not connected" are different problems with different fixes -- and
   * because a tile labelled `participant_2` is a person stripped of the name
   * they typed at the door.
   */
  readonly onRoster?: (
    roster: readonly { participantId: string; displayName: string }[],
  ) => void;
  /** How many ICE servers were actually obtained. Zero is worth showing. */
  readonly onIceServers?: (count: number) => void;
}

/**
 * The gateway's view of who is in the call.
 *
 * `CallStateSnapshot` from the shared package is the authority on this shape;
 * this narrows to the two fields the mesh needs. `joined` is NOT optional to
 * ignore: a participant who has a seat but has not joined yet is somebody to
 * negotiate with LATER, and creating a peer for them now produces an offer
 * nobody answers.
 */
type CallStatePayload = CallStateSnapshot;

export class CallConnection {
  private readonly options: CallConnectionOptions;
  private socket: Socket | null = null;
  private mesh: CallVideoMesh | null = null;
  private local: {
    toURL(): string;
    getTracks(): { stop(): void }[];
    getAudioTracks(): { enabled: boolean }[];
  } | null = null;
  /** Assigned by the gateway on a successful join, never invented locally. */
  private participantId: string | null = null;
  /*
   * THE AUDIO LEGS. Voice does not travel over the video mesh on this
   * platform: the mic PUBLISHES to the gateway (which is also what feeds the
   * translation pipeline) and everybody's voices come back on a RECEIVE peer
   * with one transceiver per speaker slot. The phone client originally built
   * only the mesh -- video connected, and the call was silent in both
   * directions, because the legs that carry voice were never opened.
   */
  private publishPeer: CallPeer | null = null;
  private receivePeer: CallPeer | null = null;

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
    })) as unknown as {
      toURL(): string;
      getTracks(): { stop(): void }[];
      getAudioTracks(): { enabled: boolean }[];
    };
    this.local = stream;
    return stream;
  }

  /**
   * Join, and report what the gateway actually said.
   *
   * THE RESULT COMES BACK IN AN ACK, not an event. `socket.emit(JOIN, payload)`
   * without a callback sends the request and discards the answer -- which is
   * what this did at first, and the symptom was a call screen sitting on
   * "waiting for someone to join" while the gateway had already refused the
   * join outright. A silent refusal is indistinguishable from an empty call.
   */
  /**
   * The ICE servers this call will use.
   *
   * FETCHED, NOT CONFIGURED. `/webrtc/ice` returns STUN plus TURN with
   * credentials that expire, so they cannot be shipped in a bundle -- and
   * without TURN a call reaches only devices that can already see each other
   * directly, which on mobile data is nobody. The shared `fetchIceServers`
   * falls back rather than throwing, because a call with STUN only is worth
   * more than no call at all.
   */
  private async resolveIceServers(): Promise<RTCIceServer[]> {
    if (this.options.iceServers !== undefined) {
      return this.options.iceServers as RTCIceServer[];
    }
    return fetchIceServers(this.options.gatewayUrl, { timeoutMs: 5000 });
  }

  async join(): Promise<CallJoinAck> {
    const local = await this.openLocalMedia();
    const ice = await this.resolveIceServers();
    this.options.onIceServers?.(ice.length);

    /*
     * `createCallSocketOptions` CARRIES `role: 'call-participant'` IN THE
     * HANDSHAKE QUERY, and omitting it is why this silently did nothing.
     *
     * The gateway decides which handlers a socket gets from that role. Without
     * it the connection is treated as a LISTENER, no call handlers are
     * registered, and `call:join` is received by nobody -- no error, no refusal,
     * no ack, just silence until the client's own timeout. The log said
     * "Listener connected" and then "disconnected, role: listener" fifteen
     * seconds later, which is the shape of a client that connected perfectly
     * and was never in the conversation it thought it was having.
     *
     * The shared package has always known this. Building the options by hand
     * meant re-deriving a contract that was already written down, and getting
     * it wrong in the one field with no visible failure.
     */
    const socket = io(this.options.gatewayUrl, {
      ...createCallSocketOptions(),
      // A phone changes network constantly; reconnecting is the normal case.
      reconnection: true,
    });
    this.socket = socket;

    const form = {
      ...createInitialCallJoinForm(),
      displayName: this.options.displayName,
      callCode: this.options.callId,
    };

    /*
     * `.timeout()` IS WHAT MAKES THE CALLBACK TWO-ARGUMENT, and omitting it
     * produced the most misleading bug of the lot.
     *
     * Socket.IO passes a plain ack as ONE argument: `ack(payload)`. Written as
     * `(error, reply) => ...` without `.timeout()`, the SUCCESSFUL ack arrives
     * as `error`, is truthy, and the join is reported as "the call service did
     * not respond" -- while the gateway has in fact accepted it. The other side
     * saw a participant appear and immediately vanish, because this client then
     * disconnected a socket that had joined perfectly.
     *
     * With `.timeout()` the signature becomes `(error, reply)` and `error` is
     * set only on an actual timeout, which is also how call-web does it. The
     * hand-rolled timer is gone with it: Socket.IO owns that now.
     */
    const ack = await new Promise<CallJoinAck>((resolve) => {
      socket
        .timeout(ACK_TIMEOUT_MS)
        .emit(
          CALL_EVENTS.JOIN,
          buildCallJoinPayload(form, undefined, this.options.sessionToken),
          (error: unknown, reply?: CallJoinAck) => {
            resolve(
              error
                ? { ok: false, error: 'The call service did not respond.' }
                : (reply ?? { ok: false, error: 'The call service gave an unexpected reply.' }),
            );
          },
        );
    });

    if (!ack.ok) {
      // Nothing is wired up for a refused join: no mesh, no listeners, and the
      // socket is closed rather than left holding a connection to a call this
      // client is not in.
      socket.disconnect();
      this.socket = null;
      return ack;
    }

    /*
     * THE GATEWAY ASSIGNS THE PARTICIPANT ID, and it arrives here. Using a
     * locally invented one would make every peer negotiate against a name the
     * other side has never heard of.
     */
    this.participantId = ack.participantId;

    const mesh = new CallVideoMesh({
      callId: this.options.callId,
      selfParticipantId: ack.participantId,
      iceServers: ice,
      // THE PLATFORM SEAM. Everything else is shared with the web client.
      createPeerConnection: () =>
        new NativePeerConnection({ iceServers: ice }) as unknown as RTCPeerConnection,
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
     * The SENDER is in the payload, not a separate argument: the gateway relays
     * the object the sender built, and `participantId` on it is whoever sent it.
     * Passing the target by mistake would make every peer negotiate with itself.
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
      const joined = (payload?.participants ?? [])
        // JOINED ONLY, exactly as the web client does. A seat that exists but
        // has not been taken is not somebody to offer to yet.
        .filter(
          (participant) =>
            participant.joined &&
            participant.participantId.length > 0 &&
            participant.participantId !== this.participantId,
        );
      mesh.syncParticipants(joined.map((participant) => participant.participantId));
      this.options.onRoster?.(
        joined.map((participant) => ({
          participantId: participant.participantId,
          displayName: participant.displayName,
        })),
      );
    });

    socket.on(CALL_EVENTS.ERROR, (payload: { message?: string }) =>
      this.options.onError(payload?.message ?? 'The call service refused this call.'),
    );
    socket.on('connect_error', () => this.options.onError('Could not reach the call service.'));

    /*
     * SDP offers are answered through the ACK, exactly like the join --
     * `.timeout()` is what makes the callback two-argument. The lesson was
     * already paid for once tonight.
     */
    const emitSdp = (event: string, sdp: string): Promise<string> =>
      new Promise((resolve, reject) => {
        socket
          .timeout(ACK_TIMEOUT_MS)
          .emit(
            event,
            buildCallSdpPayload(this.options.callId, ack.participantId, sdp),
            (error: unknown, reply?: CallSdpAck) => {
              if (error || !reply?.ok || typeof reply.sdp !== 'string') {
                reject(new Error('Call audio could not be negotiated.'));
                return;
              }
              resolve(reply.sdp);
            },
          );
      });

    const peerFactory = () =>
      new NativePeerConnection({ iceServers: ice }) as unknown as RTCPeerConnection;

    const publish = new CallPeer({
      direction: 'publish',
      stream: local as unknown as MediaStream,
      createPeerConnection: peerFactory,
      sendOffer: (sdp) => emitSdp(CALL_EVENTS.PUBLISH_OFFER, sdp),
      onLocalIceCandidate: (candidate) =>
        socket.emit(
          CALL_EVENTS.PUBLISH_ICE,
          buildCallIcePayload(this.options.callId, ack.participantId, candidate),
        ),
    });
    this.publishPeer = publish;

    const receive = new CallPeer({
      direction: 'receive',
      createPeerConnection: peerFactory,
      remoteSlotCount: CALL_REMOTE_SLOT_COUNT,
      sendOffer: (sdp) => emitSdp(CALL_EVENTS.RECEIVE_OFFER, sdp),
      onLocalIceCandidate: (candidate) =>
        socket.emit(
          CALL_EVENTS.RECEIVE_ICE,
          buildCallIcePayload(this.options.callId, ack.participantId, candidate),
        ),
      /*
       * No sink to build: react-native-webrtc routes remote audio tracks to
       * the device output the moment they arrive. The web needs a WebAudio
       * sink; the phone needs the tracks to exist.
       */
    });
    this.receivePeer = receive;

    // The gateway trickles its candidates back on the SAME event names it
    // receives ours on, scoped to this participant's room.
    socket.on(CALL_EVENTS.PUBLISH_ICE, (payload: { candidate?: RTCIceCandidateInit | null }) => {
      void publish.addRemoteCandidate(payload?.candidate);
    });
    socket.on(CALL_EVENTS.RECEIVE_ICE, (payload: { candidate?: RTCIceCandidateInit | null }) => {
      void receive.addRemoteCandidate(payload?.candidate);
    });

    try {
      await publish.connect();
      await receive.connect();
    } catch (error) {
      // Voice failing must not tear down a call whose video works: say so and
      // leave the person the choice of continuing on camera alone.
      this.options.onError(
        error instanceof Error ? error.message : 'Call audio could not be negotiated.',
      );
    }

    return ack;
  }

  /** Mute is the LOCAL track disabled -- nothing renegotiates, nothing asks. */
  setMicrophoneEnabled(enabled: boolean): void {
    for (const track of this.local?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
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
      if (this.participantId !== null) {
        this.socket?.emit(CALL_EVENTS.LEAVE, {
          callId: this.options.callId,
          participantId: this.participantId,
        });
      }
    } catch {
      // Best effort; the gateway times a participant out regardless.
    }

    this.mesh?.dispose();
    this.mesh = null;
    this.publishPeer?.close();
    this.publishPeer = null;
    this.receivePeer?.close();
    this.receivePeer = null;
    this.participantId = null;
    this.socket?.disconnect();
    this.socket = null;

    for (const track of this.local?.getTracks() ?? []) track.stop();
    this.local = null;
  }
}
