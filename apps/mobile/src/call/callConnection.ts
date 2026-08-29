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
import {
  MediaStream as NativeMediaStream,
  RTCPeerConnection as NativePeerConnection,
  mediaDevices,
} from 'react-native-webrtc';
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
  type CallJoinFormState,
  type CallResumeCredentials,
  type CallSdpAck,
  type CallStateSnapshot,
  type CallVideoIcePayload,
  type CallVideoSdpPayload,
  type DirectCallStateSnapshot,
} from '@videofy-live/call-client-core';

/** Long enough for a cold gateway, short enough that nobody stares at a spinner. */
const ACK_TIMEOUT_MS = 15_000;

/** What the mesh hands back for a tile. Kept loose: RN streams are not DOM ones. */
export type RemoteStream = { toURL(): string } | null;

/** The subset of react-native-webrtc's MediaStream the connection touches. */
export interface LocalStream {
  toURL(): string;
  getTracks(): { stop(): void }[];
  getAudioTracks(): { enabled: boolean }[];
}

export interface CallConnectionOptions {
  readonly gatewayUrl: string;
  readonly callId: string;
  readonly displayName: string;
  /**
   * DIRECT CALL: the C7 account this call is placed to. Makes the gateway
   * create a PERSONAL call whose mode is the account pair's conversation
   * mode (server-resolved, locked). Absent for conferences.
   */
  readonly directPeerAccountId?: string;
  /** The language this account SPEAKS; preloads the join form. */
  readonly speakLanguage?: 'en' | 'es' | 'fr';
  /** The language this account PREFERS TO HEAR; preloads the join form. */
  readonly hearLanguage?: 'en' | 'es' | 'fr';
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
  /**
   * Transport truth for the two VOICE legs, so silence can name its link:
   * 'publish' is my microphone to the gateway, 'receive' is everybody
   * else's voice to me.
   */
  readonly onLegState?: (leg: 'publish' | 'receive', state: string) => void;
  /**
   * The server-owned direct-call state (call:direct:state). Every word on the
   * call screen for a direct call comes from here once it arrives.
   */
  readonly onDirectState?: (wire: DirectCallStateSnapshot) => void;
  /**
   * The call was ENDED for everybody (call:ended) -- by the other party, or
   * by this one. Distinct from a participant leaving.
   */
  readonly onEnded?: (info: { endedByMe: boolean }) => void;
  /**
   * Transport events, metadata only: the socket was lost, a resume of the
   * SAME seat is being attempted, it succeeded, it failed. This is the
   * instrumentation that tells "the call died at two minutes" apart from
   * "the socket dropped at zero and the seat was reaped at 120".
   */
  readonly onTransport?: (event: CallTransportEvent) => void;
  /** The camera path, stage by stage; metadata only. */
  readonly onVideoDiagnostic?: (event: CallVideoDiagnostic) => void;
  /**
   * Metadata-only receive diagnostics, sampled every two seconds: how many
   * audio packets have arrived on the receive leg and the ICE state. Never
   * audio. A caller who "hears nothing" with packets rising has a playback
   * fault; with zero packets, a transport or routing fault.
   */
  readonly onVoiceStats?: (stats: { inboundPackets: number; iceState: string }) => void;
  readonly onRoster?: (
    roster: readonly {
      participantId: string;
      displayName: string;
      /** Verified account, when that seat joined signed in. For avatars. */
      accountId?: string;
    }[],
  ) => void;
  /** How many ICE servers were actually obtained. Zero is worth showing. */
  readonly onIceServers?: (count: number) => void;
}

/**
 * Where the camera path stands, in words the timeline can carry. Each stage
 * has a different fix: acquisition (permission / hardware), attach
 * (replaceTrack rejected), outbound (no RTP leaving this phone), remote
 * (nothing arriving from the other side), render (a stream without a picture).
 */
export type CallVideoDiagnostic =
  | { readonly kind: 'acquired' }
  | { readonly kind: 'acquisition-failed'; readonly error: string }
  | { readonly kind: 'attached'; readonly participantId: string; readonly outcome: string }
  | { readonly kind: 'attach-failed'; readonly participantId: string; readonly error: string }
  | { readonly kind: 'outbound'; readonly participantId: string; readonly frames: number; readonly bytes: number }
  | { readonly kind: 'outbound-silent'; readonly participantId: string; readonly rebuilt: boolean }
  | { readonly kind: 'inbound'; readonly participantId: string; readonly frames: number; readonly bytes: number };

export type CallTransportEvent =
  | { readonly kind: 'socket-lost'; readonly reason: string }
  | { readonly kind: 'resuming'; readonly attempt: number }
  | { readonly kind: 'resumed' }
  | { readonly kind: 'resume-failed'; readonly error: string };

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
  /**
   * THE SEAT'S CREDENTIAL. A Socket.IO reconnect gives the gateway a new
   * socket with no binding; without re-joining WITH these, the seat sits
   * disconnected until the 120-second reaper ends the call. So every
   * reconnect re-joins as the same participant, and the resume token is
   * refreshed from each ack.
   */
  private resumeCredentials: CallResumeCredentials | null = null;
  private joinForm: CallJoinFormState | null = null;

  constructor(options: CallConnectionOptions) {
    this.options = options;
  }

  /**
   * The MICROPHONE, opened once. Never the camera: every call starts camera
   * OFF (founder ruling 2026-08-28), and "off" means the hardware is not
   * acquired -- not a black rectangle over a running sensor. The camera is
   * a separate stream, opened only by `setCameraEnabled(true)`.
   *
   * react-native-webrtc's `mediaDevices`, not the browser's. The constraint
   * shape is identical -- which is what makes the surrounding code portable --
   * but the implementation is native and the permission prompt is Android's.
   */
  async openLocalMedia(): Promise<LocalStream> {
    if (this.local !== null) return this.local;
    const stream = (await mediaDevices.getUserMedia({
      audio: true,
      video: false,
    })) as unknown as LocalStream;
    this.local = stream;
    return stream;
  }

  /** The camera stream while the camera is on; null is genuinely off. */
  private camera: LocalStream | null = null;

  /**
   * Camera on: acquire the front camera and hand its track to the mesh (the
   * first attach negotiates; later ones replace the payload). Camera off:
   * STOP the capture so the hardware and the privacy indicator release, and
   * tell the mesh, so the far side's tile falls back to the avatar. A denied
   * camera permission returns null and the audio call continues untouched.
   */
  async setCameraEnabled(enabled: boolean): Promise<LocalStream | null> {
    if (!enabled) {
      for (const track of this.camera?.getTracks() ?? []) track.stop();
      this.camera = null;
      await this.mesh?.setLocalStream(null);
      return null;
    }
    if (this.camera !== null) return this.camera;
    let stream: LocalStream;
    try {
      stream = (await mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user' },
      })) as unknown as LocalStream;
    } catch (error) {
      this.options.onVideoDiagnostic?.({ kind: 'acquisition-failed', error: error instanceof Error ? error.message : 'getUserMedia failed' });
      return null;
    }
    this.camera = stream;
    this.options.onVideoDiagnostic?.({ kind: 'acquired' });
    /*
     * CAMERA ON IS PROVEN, NOT ASSUMED. getUserMedia succeeding is where the
     * old code stopped looking; a phone could open its camera, say "Camera
     * on", and send nothing. Now: the attach is awaited per peer, then the
     * outbound video counters are watched for two seconds; a peer whose
     * attach succeeded but whose outbound stays at zero is rebuilt -- that
     * one video peer only, with the real track attached at creation. Audio
     * rides the gateway legs and is never touched.
     */
    const mesh = this.mesh;
    if (mesh !== null) {
      const results = await mesh.setLocalStream(stream as unknown as MediaStream);
      for (const result of results) {
        if (result.outcome === 'failed') {
          this.options.onVideoDiagnostic?.({ kind: 'attach-failed', participantId: result.participantId, error: result.error ?? 'unknown' });
          mesh.rebuildPeer(result.participantId);
        } else {
          this.options.onVideoDiagnostic?.({ kind: 'attached', participantId: result.participantId, outcome: result.outcome });
        }
      }
      void this.watchOutboundVideo(mesh);
    }
    return stream;
  }

  /** Two seconds, four samples: outbound video must move, or the peer is rebuilt once. */
  private async watchOutboundVideo(mesh: CallVideoMesh): Promise<void> {
    const rebuilt = new Set<string>();
    for (let sample = 0; sample < 4; sample += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.mesh !== mesh || this.camera === null) return;
      const stats = await mesh.videoStats();
      let allMoving = stats.length > 0;
      for (const row of stats) {
        this.options.onVideoDiagnostic?.({ kind: 'outbound', participantId: row.participantId, frames: row.outboundFrames, bytes: row.outboundBytes });
        this.options.onVideoDiagnostic?.({ kind: 'inbound', participantId: row.participantId, frames: row.inboundFrames, bytes: row.inboundBytes });
        if (row.outboundFrames === 0 && row.outboundBytes === 0) allMoving = false;
      }
      if (allMoving) return;
      if (sample === 3) {
        for (const row of stats) {
          if (row.outboundFrames === 0 && row.outboundBytes === 0 && !rebuilt.has(row.participantId)) {
            rebuilt.add(row.participantId);
            const done = mesh.rebuildPeer(row.participantId);
            this.options.onVideoDiagnostic?.({ kind: 'outbound-silent', participantId: row.participantId, rebuilt: done });
          }
        }
      }
    }
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
    // Fetched WHILE the socket connects, not before: on a real phone each of
    // these is a TLS round trip, and the answer-to-audio budget is two seconds.
    const icePromise = this.resolveIceServers();

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
    const ice = await icePromise;
    this.options.onIceServers?.(ice.length);

    const form = {
      ...createInitialCallJoinForm(),
      ...(this.options.speakLanguage === undefined
        ? {}
        : { speakLanguage: this.options.speakLanguage }),
      ...(this.options.hearLanguage === undefined
        ? {}
        : { hearLanguage: this.options.hearLanguage }),
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
          {
            ...buildCallJoinPayload(form, undefined, this.options.sessionToken),
            ...(this.options.directPeerAccountId === undefined
              ? {}
              : { directPeerAccountId: this.options.directPeerAccountId }),
          },
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
    this.resumeCredentials = { participantId: ack.participantId, resumeToken: ack.resumeToken };
    this.joinForm = form;
    // The telephone's state at the moment of joining, so the screen never
    // waits for the NEXT transition to learn the current one.
    if (ack.directState !== undefined) this.deliverDirectState(ack.directState);

    const mesh = new CallVideoMesh({
      callId: this.options.callId,
      selfParticipantId: ack.participantId,
      iceServers: ice,
      // THE PLATFORM SEAM. Everything else is shared with the web client.
      createPeerConnection: () =>
        new NativePeerConnection({ iceServers: ice }) as unknown as RTCPeerConnection,
      /*
       * A remote camera negotiated EMPTY (every call starts camera off)
       * arrives as a bare track with no stream. Hermes has no global
       * MediaStream to wrap it in, so the mesh fell silent and the phone
       * showed no video after the other side turned their camera on. The
       * platform's own class is the wrapper.
       */
      createMediaStream: (tracks) =>
        new NativeMediaStream(tracks as never) as unknown as MediaStream,
      sendOffer: (payload: CallVideoSdpPayload) => socket.emit(CALL_EVENTS.VIDEO_OFFER, payload),
      sendAnswer: (payload: CallVideoSdpPayload) => socket.emit(CALL_EVENTS.VIDEO_ANSWER, payload),
      sendIce: (payload: CallVideoIcePayload) => socket.emit(CALL_EVENTS.VIDEO_ICE, payload),
      onRemoteStream: (participantId: string, stream: MediaStream | null) =>
        this.options.onRemoteStream(participantId, stream as unknown as RemoteStream),
      onPeerState: (participantId: string, state: RTCPeerConnectionState) =>
        this.options.onPeerState(participantId, String(state)),
    });
    this.mesh = mesh;
    // Camera is OFF at start: the mesh has no local video until the person
    // turns it on. `local` is the microphone only, and voice rides the
    // gateway legs below, not the mesh.
    void local;

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
      /*
       * REBUILD THE RECEIVE LEG WHEN SOMEBODY NEW JOINS.
       *
       * The field evidence (28 Aug): the gateway received and routed the
       * callee's voice, yet the CALLER -- always the first joiner -- heard
       * nothing, while the callee, whose receive peer was negotiated after
       * the caller already existed, heard everything. The one difference is
       * a slot bound AFTER negotiation: on this platform a remote audio
       * track that carried no RTP at negotiation time does not start
       * playing when RTP begins later. Renegotiating the receive peer once
       * the newcomer is present makes every slot look exactly like the
       * working case. The web client binds slots dynamically and needs
       * nothing; this is the phone's honest equivalent.
       */
      const joinedIds = new Set(joined.map((participant) => participant.participantId));
      const newcomer = [...joinedIds].some((id) => !this.knownParticipants.has(id));
      this.knownParticipants = joinedIds;
      if (newcomer && this.receiveReady) void this.rebuildReceiveLeg();
      this.options.onRoster?.(
        joined.map((participant) => ({
          participantId: participant.participantId,
          displayName: participant.displayName,
          ...((participant as { accountId?: string }).accountId
            ? { accountId: (participant as { accountId?: string }).accountId }
            : {}),
        })),
      );
    });

    socket.on(CALL_EVENTS.DIRECT_STATE, (wire: unknown) => this.deliverDirectState(wire));

    // ENDED is for everybody at once; LEAVE is one seat. A direct call only
    // ever ends -- the other phone reads "Call ended", never "guest left".
    socket.on(CALL_EVENTS.ENDED, (payload: { endedByParticipantId?: unknown }) => {
      this.options.onEnded?.({
        endedByMe:
          this.participantId !== null && payload?.endedByParticipantId === this.participantId,
      });
    });

    /*
     * RESUME THE SAME SEAT ON RECONNECT. Socket.IO reconnects the transport
     * by itself; it does not re-join the call. Before this, a phone whose
     * socket blipped kept a live-looking screen while the gateway had
     * detached its voice legs and armed the 120-second reaper.
     */
    socket.on('disconnect', (reason: string) => {
      if (reason === 'io client disconnect') return;
      this.options.onTransport?.({ kind: 'socket-lost', reason });
    });
    socket.io.on('reconnect', (attempt: number) => {
      void this.resumeSeat(attempt);
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

    const buildPublish = (): CallPeer =>
      new CallPeer({
        direction: 'publish',
        stream: local as unknown as MediaStream,
        createPeerConnection: peerFactory,
        onConnectionStateChange: (state) => this.options.onLegState?.('publish', String(state)),
        sendOffer: (sdp) => emitSdp(CALL_EVENTS.PUBLISH_OFFER, sdp),
        onLocalIceCandidate: (candidate) =>
          socket.emit(
            CALL_EVENTS.PUBLISH_ICE,
            buildCallIcePayload(this.options.callId, ack.participantId, candidate),
          ),
      });
    this.buildPublish = buildPublish;
    const publish = buildPublish();
    this.publishPeer = publish;

    const buildReceive = (): CallPeer =>
      new CallPeer({
        direction: 'receive',
        createPeerConnection: peerFactory,
        remoteSlotCount: CALL_REMOTE_SLOT_COUNT,
        sendOffer: (sdp) => emitSdp(CALL_EVENTS.RECEIVE_OFFER, sdp),
        onConnectionStateChange: (state) => this.options.onLegState?.('receive', String(state)),
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
    this.buildReceive = buildReceive;
    const receive = buildReceive();
    this.receivePeer = receive;

    // The gateway trickles its candidates back on the SAME event names it
    // receives ours on, scoped to this participant's room. Receive candidates
    // go to WHICHEVER receive peer is current, because it can be rebuilt.
    socket.on(CALL_EVENTS.PUBLISH_ICE, (payload: { candidate?: RTCIceCandidateInit | null }) => {
      void this.publishPeer?.addRemoteCandidate(payload?.candidate);
    });
    socket.on(CALL_EVENTS.RECEIVE_ICE, (payload: { candidate?: RTCIceCandidateInit | null }) => {
      void this.receivePeer?.addRemoteCandidate(payload?.candidate);
    });

    try {
      await publish.connect();
      await receive.connect();
      this.receiveReady = true;
      this.startVoiceStats();
    } catch (error) {
      // Voice failing must not tear down a call whose video works: say so and
      // leave the person the choice of continuing on camera alone.
      this.options.onError(
        error instanceof Error ? error.message : 'Call audio could not be negotiated.',
      );
    }

    return ack;
  }

  private buildReceive: (() => CallPeer) | null = null;
  private buildPublish: (() => CallPeer) | null = null;
  private receiveReady = false;

  /** Normalise whatever the wire carried into the telephone state the screen reads. */
  private deliverDirectState(wire: unknown): void {
    const raw = wire as Partial<DirectCallStateSnapshot> | null;
    if (raw === null || typeof raw !== 'object' || typeof raw.state !== 'string') return;
    const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
    this.options.onDirectState?.({
      callId: typeof raw.callId === 'string' ? raw.callId : this.options.callId,
      state: raw.state,
      mode: raw.mode === 'translated' ? 'translated' : 'normal',
      callerAccountId: typeof raw.callerAccountId === 'string' ? raw.callerAccountId : '',
      peerAccountId: typeof raw.peerAccountId === 'string' ? raw.peerAccountId : '',
      callerName: typeof raw.callerName === 'string' ? raw.callerName : '',
      updatedAtMs: num(raw.updatedAtMs) ?? Date.now(),
      expiresAtMs: num(raw.expiresAtMs) ?? 0,
      answeredAtMs: num(raw.answeredAtMs),
      connectedAtMs: num(raw.connectedAtMs),
      endedByAccountId: typeof raw.endedByAccountId === 'string' ? raw.endedByAccountId : null,
    });
  }

  /**
   * Re-join as the SAME participant after a transport reconnect, then
   * negotiate both voice legs afresh -- the gateway closed its ends of them
   * when the socket dropped. The video mesh is peer-to-peer and survives a
   * signalling blip on its own.
   */
  private async resumeSeat(attempt: number): Promise<void> {
    const socket = this.socket;
    const credentials = this.resumeCredentials;
    const form = this.joinForm;
    if (socket === null || credentials === null || form === null) return;
    this.options.onTransport?.({ kind: 'resuming', attempt });
    const ack = await new Promise<CallJoinAck>((resolve) => {
      socket.timeout(ACK_TIMEOUT_MS).emit(
        CALL_EVENTS.JOIN,
        {
          ...buildCallJoinPayload(form, credentials, this.options.sessionToken),
          ...(this.options.directPeerAccountId === undefined
            ? {}
            : { directPeerAccountId: this.options.directPeerAccountId }),
        },
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
      this.options.onTransport?.({ kind: 'resume-failed', error: ack.error ?? 'refused' });
      return;
    }
    if (ack.participantId !== credentials.participantId) {
      // A different seat is a different call as far as the telephone is
      // concerned; the gateway will treat the old one as abandoned.
      this.options.onTransport?.({ kind: 'resume-failed', error: 'seat changed' });
      return;
    }
    this.resumeCredentials = { participantId: ack.participantId, resumeToken: ack.resumeToken };
    if (ack.directState !== undefined) this.deliverDirectState(ack.directState);
    try {
      this.publishPeer?.close();
      const publish = this.buildPublish?.() ?? null;
      if (publish !== null) {
        this.publishPeer = publish;
        await publish.connect();
      }
      await this.rebuildReceiveLeg();
      this.options.onTransport?.({ kind: 'resumed' });
    } catch (error) {
      this.options.onTransport?.({
        kind: 'resume-failed',
        error: error instanceof Error ? error.message : 'voice could not be renegotiated',
      });
    }
  }

  /**
   * END THE CALL FOR EVERYBODY. A direct call's red button means "hang up",
   * not "leave my seat": the gateway ends the session and both phones read
   * "Call ended" at once. Resolves true when the gateway acknowledged.
   */
  async end(): Promise<boolean> {
    const socket = this.socket;
    const participantId = this.participantId;
    if (socket === null || participantId === null) return false;
    return new Promise((resolve) => {
      socket.timeout(5_000).emit(
        CALL_EVENTS.END,
        { callId: this.options.callId, participantId },
        (error: unknown, reply?: { ok?: boolean }) => resolve(!error && reply?.ok === true),
      );
    });
  }
  private knownParticipants = new Set<string>();
  private rebuilding = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  /** Close the current receive peer and negotiate a fresh one. See the STATE handler. */
  private async rebuildReceiveLeg(): Promise<void> {
    if (this.rebuilding || this.buildReceive === null) return;
    this.rebuilding = true;
    try {
      this.receivePeer?.close();
      const next = this.buildReceive();
      this.receivePeer = next;
      await next.connect();
    } catch (error) {
      this.options.onError(
        error instanceof Error ? error.message : 'Call audio could not be renegotiated.',
      );
    } finally {
      this.rebuilding = false;
    }
  }

  /** Every two seconds: inbound audio packets and ICE state. Metadata only. */
  private startVoiceStats(): void {
    if (this.statsTimer !== null || this.options.onVoiceStats === undefined) return;
    this.statsTimer = setInterval(() => {
      void (async () => {
        const report = await this.receivePeer?.stats();
        if (!report) return;
        let inboundPackets = 0;
        let iceState = 'unknown';
        report.forEach((entry: { type?: string; kind?: string; packetsReceived?: number; state?: string }) => {
          if (entry.type === 'inbound-rtp' && entry.kind === 'audio') {
            inboundPackets += entry.packetsReceived ?? 0;
          }
          if (entry.type === 'transport' && typeof entry.state === 'string') iceState = entry.state;
        });
        this.options.onVoiceStats?.({ inboundPackets, iceState });
      })();
    }, 2000);
  }

  /**
   * Tell the telephone how many devices the ring reached. Zero becomes
   * UNAVAILABLE at once instead of thirty seconds of "Calling…".
   */
  reportRingResult(reachedDevices: number): void {
    this.socket?.emit(CALL_EVENTS.DIRECT_RING_RESULT, {
      callId: this.options.callId,
      reachedDevices,
    });
  }

  /** Mute is the LOCAL track disabled -- nothing renegotiates, nothing asks. */
  setMicrophoneEnabled(enabled: boolean): void {
    for (const track of this.local?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
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
    this.resumeCredentials = null;
    this.socket?.disconnect();
    this.socket = null;

    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    for (const track of this.camera?.getTracks() ?? []) track.stop();
    this.camera = null;
    for (const track of this.local?.getTracks() ?? []) track.stop();
    this.local = null;
  }
}
