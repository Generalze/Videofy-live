// P6.4-V1 — peer-to-peer camera video between call participants.
//
// P6.4 video mesh is a development-demo topology, NOT the long-term Videofy
// conference video architecture; long-term is SFU, explicitly out of scope.
// A full mesh carries one encode per pair, which is affordable at the demo
// cap of three remotes and unacceptable beyond it — that is the SFU's job.
//
// Signalling is relay-only: call:video:offer/answer/ice travel through the
// gateway, which validates the sender's binding and forwards each payload to
// the target's private room. Media never touches the server. The default
// peer factory reads VITE_WEBRTC_ICE_SERVERS through the same mechanism
// callWebRtc uses; reliable internet traversal requires deployed ICE/TURN
// configuration even though LAN development works without it.
//
// Glare: perfect negotiation per pair. The POLITE peer is the one with the
// lexicographically SMALLER participantId; it rolls its own pending offer
// back (implicitly, inside setRemoteDescription) and answers the remote
// offer. The impolite peer ignores the colliding offer — its own offer
// stands and the polite side answers it.
//
// Camera OFF is `enabled = false` on the LOCAL track: the remote side sees
// the track mute and drives its placeholder from that. No server state and
// no renegotiation for a simple toggle.
//
// Strictly separate from translated-audio semantics: video never touches
// STT/media-ingest, and nothing here imports the generated-audio queue or
// the W4 mix policy.

import type { CallVideoIcePayload, CallVideoSdpPayload } from './callTypes';

/** Conference seat cap (4) minus yourself. Extras are ignored and counted. */
export const CALL_VIDEO_MESH_MAX_REMOTES = 3;

const MAX_QUEUED_REMOTE_CANDIDATES = 32;

export interface CallVideoMeshOptions {
  callId: string;
  selfParticipantId: string;
  /** Fire-and-forget sends, mirroring the gateway's fire-and-forget relay. */
  sendOffer: (payload: CallVideoSdpPayload) => void;
  sendAnswer: (payload: CallVideoSdpPayload) => void;
  sendIce: (payload: CallVideoIcePayload) => void;
  /** Null when the peer departs: clear the tile. */
  onRemoteStream: (participantId: string, stream: MediaStream | null) => void;
  onPeerState: (participantId: string, state: RTCPeerConnectionState) => void;
  /** Used by the default RTCPeerConnection factory; omitted means no ICE servers. */
  iceServers?: RTCIceServer[];
  /** Injectable for tests; defaults to RTCPeerConnection with `iceServers`. */
  createPeerConnection?: (remoteParticipantId: string) => RTCPeerConnection;
  /**
   * THE SECOND PLATFORM SEAM. A video track negotiated EMPTY (camera off at
   * setup, `replaceTrack` later) arrives at the far side with no stream
   * attached -- the offer carried no msid -- so a stream must be built
   * around the bare track. Browsers have a global `MediaStream`; Hermes
   * does not, and react-native-webrtc exports its own class. Without this
   * the phone received every remote video track and rendered none of them.
   */
  createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}

/** What happened when the local video track was handed to one peer. */
export interface CallVideoAttachResult {
  participantId: string;
  outcome: 'replaced' | 'added' | 'cleared' | 'failed';
  error?: string;
}

/** Per-peer video RTP counters, from getStats. Zero outbound after a camera on is the fault. */
export interface CallVideoPeerStats {
  participantId: string;
  connectionState: string;
  outboundFrames: number;
  outboundBytes: number;
  inboundFrames: number;
  inboundBytes: number;
}

export interface CallVideoMeshDiagnostics {
  peerCount: number;
  /** Signalling from anyone we do not currently share the call with: dropped, fail closed. */
  unknownSenderDropCount: number;
  /** Remotes beyond the mesh cap in a membership sync: ignored, never silently truncated. */
  ignoredExtraRemoteCount: number;
  signallingFaultCount: number;
}

interface MeshPeer {
  readonly participantId: string;
  /** This side is polite when OUR participantId is the lexicographically smaller one. */
  readonly polite: boolean;
  readonly pc: RTCPeerConnection;
  /** Captured at creation; a disposed mesh fails the generation check forever. */
  readonly generation: number;
  sender: RTCRtpSender | null;
  /**
   * True while `sender` is the one created empty by the instant-camera
   * transceiver, before any real track has been negotiated onto it.
   */
  senderNegotiatedEmpty: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
  remoteDescriptionApplied: boolean;
  readonly pendingRemoteCandidates: RTCIceCandidateInit[];
  readonly seenRemoteCandidates: Set<string>;
  closed: boolean;
}

export class CallVideoMesh {
  private readonly peers = new Map<string, MeshPeer>();
  private localStream: MediaStream | null = null;
  private localTrack: MediaStreamTrack | null = null;
  /** Survives detach/re-attach so a camera-off choice outlives a stream rebuild. */
  private cameraEnabled = true;
  private generation = 0;
  private disposed = false;
  private unknownSenderDropCount = 0;
  private ignoredExtraRemoteCount = 0;
  private signallingFaultCount = 0;

  constructor(private readonly options: CallVideoMeshOptions) {
    if (!options.createPeerConnection && !globalThis.RTCPeerConnection) {
      throw new Error('This browser does not support live call video.');
    }
  }

  /**
   * Attach (or detach, with null) the local camera. The first attach per peer
   * negotiates; afterwards `replaceTrack` swaps the payload with no
   * renegotiation. A simple on/off toggle is `setCameraEnabled`, not this.
   */
  /**
   * Hand the camera to every peer and SAY WHAT HAPPENED. `replaceTrack` used
   * to be fire-and-forget with its rejection swallowed, so a phone could
   * open the camera, show "Camera on", and transmit nothing with no error
   * anywhere (founder review, 29 Aug). Each peer's outcome is returned; the
   * caller watches the outbound counters and rebuilds a silent peer.
   */
  async setLocalStream(stream: MediaStream | null): Promise<CallVideoAttachResult[]> {
    if (this.disposed) return [];
    this.localStream = stream;
    const track = stream?.getVideoTracks()[0] ?? null;
    if (track) {
      track.enabled = this.cameraEnabled;
    }
    this.localTrack = track;
    return Promise.all([...this.peers.values()].map((entry) => this.attachLocalTrack(entry)));
  }

  /**
   * Video RTP counters per peer, so "camera on" can be PROVEN rather than
   * assumed: frames/bytes sent on this side, received on the other.
   */
  async videoStats(): Promise<CallVideoPeerStats[]> {
    const out: CallVideoPeerStats[] = [];
    for (const entry of this.peers.values()) {
      if (entry.closed) continue;
      const row: CallVideoPeerStats = {
        participantId: entry.participantId,
        connectionState: String(entry.pc.connectionState ?? 'unknown'),
        outboundFrames: 0,
        outboundBytes: 0,
        inboundFrames: 0,
        inboundBytes: 0,
      };
      try {
        const report = await entry.pc.getStats();
        report.forEach((stat: { type?: string; kind?: string; mediaType?: string; framesSent?: number; framesEncoded?: number; bytesSent?: number; framesReceived?: number; framesDecoded?: number; bytesReceived?: number }) => {
          const kind = stat.kind ?? stat.mediaType;
          if (kind !== 'video') return;
          if (stat.type === 'outbound-rtp') {
            row.outboundFrames += stat.framesSent ?? stat.framesEncoded ?? 0;
            row.outboundBytes += stat.bytesSent ?? 0;
          } else if (stat.type === 'inbound-rtp') {
            row.inboundFrames += stat.framesReceived ?? stat.framesDecoded ?? 0;
            row.inboundBytes += stat.bytesReceived ?? 0;
          }
        });
      } catch {
        // A peer that cannot report stats is reported with zeros; the caller decides.
      }
      out.push(row);
    }
    return out;
  }

  /**
   * Tear down ONE peer and build it again with the real camera track attached
   * at creation (the addTrack path, which negotiates). Audio is untouched --
   * it rides the gateway legs -- so only this peer's video renegotiates.
   */
  rebuildPeer(participantId: string): boolean {
    if (this.disposed) return false;
    const entry = this.peers.get(participantId);
    if (!entry) return false;
    this.closePeer(entry, { notify: true });
    this.createPeer(participantId);
    return true;
  }

  /**
   * Camera OFF = `enabled = false` on the LOCAL track. Remote placeholders are
   * driven by the remote track's mute events; there is no server state and no
   * renegotiation for a toggle.
   */
  setCameraEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.cameraEnabled = enabled;
    if (this.localTrack) {
      this.localTrack.enabled = enabled;
    }
  }

  /**
   * Reconcile the mesh against current call membership: one peer per remote,
   * departed peers closed (their tile cleared via onRemoteStream(null)),
   * remotes beyond the cap ignored and counted.
   */
  syncParticipants(remoteParticipantIds: readonly string[]): void {
    if (this.disposed) return;
    const accepted = new Set<string>();
    for (const id of remoteParticipantIds) {
      if (id === this.options.selfParticipantId || accepted.has(id)) continue;
      if (accepted.size >= CALL_VIDEO_MESH_MAX_REMOTES) {
        this.ignoredExtraRemoteCount += 1;
        continue;
      }
      accepted.add(id);
    }
    for (const entry of [...this.peers.values()]) {
      if (!accepted.has(entry.participantId)) {
        this.closePeer(entry, { notify: true });
      }
    }
    for (const id of accepted) {
      if (!this.peers.has(id)) {
        this.createPeer(id);
      }
    }
  }

  async handleOffer(fromParticipantId: string, payload: CallVideoSdpPayload): Promise<void> {
    const entry = this.knownSender(fromParticipantId);
    if (!entry) return;
    const readyForOffer =
      !entry.makingOffer &&
      (entry.pc.signalingState === 'stable' || entry.settingRemoteAnswer);
    entry.ignoreOffer = !entry.polite && !readyForOffer;
    if (entry.ignoreOffer) {
      // Impolite side of glare: our own offer stands; the polite peer will
      // roll back and answer it.
      return;
    }
    try {
      // Polite side of glare: setRemoteDescription rolls our pending offer
      // back implicitly (the standard perfect-negotiation pattern).
      await entry.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      if (!this.live(entry)) return;
      entry.remoteDescriptionApplied = true;
      await entry.pc.setLocalDescription();
      if (!this.live(entry)) return;
      const sdp = entry.pc.localDescription?.sdp;
      if (sdp) {
        this.options.sendAnswer({
          callId: this.options.callId,
          participantId: this.options.selfParticipantId,
          targetParticipantId: entry.participantId,
          sdp,
        });
      }
      await this.flushRemoteCandidates(entry);
    } catch {
      this.signallingFaultCount += 1;
    }
  }

  async handleAnswer(fromParticipantId: string, payload: CallVideoSdpPayload): Promise<void> {
    const entry = this.knownSender(fromParticipantId);
    if (!entry) return;
    entry.settingRemoteAnswer = true;
    try {
      await entry.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      if (!this.live(entry)) return;
      entry.remoteDescriptionApplied = true;
      await this.flushRemoteCandidates(entry);
    } catch {
      // A stale or duplicate answer (e.g. one for a rolled-back offer).
      this.signallingFaultCount += 1;
    } finally {
      entry.settingRemoteAnswer = false;
    }
  }

  async handleIce(fromParticipantId: string, payload: CallVideoIcePayload): Promise<void> {
    const entry = this.knownSender(fromParticipantId);
    if (!entry) return;
    const candidate = payload.candidate;
    // End-of-candidates needs no action on the receiving side.
    if (!candidate?.candidate) return;
    const key = `${candidate.sdpMid ?? ''}:${candidate.sdpMLineIndex ?? ''}:${candidate.candidate}`;
    if (entry.seenRemoteCandidates.has(key)) return;
    entry.seenRemoteCandidates.add(key);
    if (!entry.remoteDescriptionApplied) {
      if (entry.pendingRemoteCandidates.length < MAX_QUEUED_REMOTE_CANDIDATES) {
        entry.pendingRemoteCandidates.push(candidate);
      }
      return;
    }
    // Candidates that belong to an offer we ignored are expected to fail.
    await entry.pc.addIceCandidate(candidate).catch(() => undefined);
  }

  /**
   * Close everything. A rebuilt mesh is a NEW instance; this one's callbacks
   * are dead from here on, including any still in flight (generation guard).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const entry of [...this.peers.values()]) {
      this.closePeer(entry, { notify: false });
    }
    this.peers.clear();
    this.localStream = null;
    this.localTrack = null;
  }

  diagnostics(): CallVideoMeshDiagnostics {
    return {
      peerCount: this.peers.size,
      unknownSenderDropCount: this.unknownSenderDropCount,
      ignoredExtraRemoteCount: this.ignoredExtraRemoteCount,
      signallingFaultCount: this.signallingFaultCount,
    };
  }

  private createPeer(participantId: string): void {
    const pc = this.options.createPeerConnection
      ? this.options.createPeerConnection(participantId)
      : new RTCPeerConnection({ iceServers: this.options.iceServers ?? [] });
    const entry: MeshPeer = {
      participantId,
      polite: this.options.selfParticipantId < participantId,
      pc,
      generation: this.generation,
      sender: null,
      senderNegotiatedEmpty: false,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      remoteDescriptionApplied: false,
      pendingRemoteCandidates: [],
      seenRemoteCandidates: new Set<string>(),
      closed: false,
    };
    /*
     * INSTANT CAMERA (founder ruling 2026-08-28). Every call starts camera
     * OFF, so there is no local track to add here -- but a video m-line is
     * negotiated NOW, empty, so that "Camera on" later is a replaceTrack on
     * an existing sender: the far side sees video within a frame instead of
     * waiting through a renegotiation. Guarded for platforms and test doubles
     * that cannot addTransceiver; those fall back to first-attach negotiation.
     */
    if (!this.localTrack && typeof pc.addTransceiver === 'function') {
      try {
        /*
         * WITH A STREAM, EVEN THOUGH THERE IS NO TRACK. The stream ids on the
         * sender put an msid on the m-line, so the far side's ontrack carries
         * a real, platform-native stream (`event.streams[0]`) -- the same
         * object shape it received when cameras were on at setup, which is
         * the path proven to render on the phone. Without it the far side
         * had to build a stream around a bare track, and on the phone that
         * rendered nothing. `createMediaStream` is the platform seam.
         */
        const placeholder = this.options.createMediaStream ? this.options.createMediaStream([]) : null;
        entry.sender = pc.addTransceiver('video', {
          direction: 'sendrecv',
          ...(placeholder ? { streams: [placeholder] } : {}),
        }).sender;
        entry.senderNegotiatedEmpty = true;
      } catch {
        entry.sender = null;
      }
    }
    this.peers.set(participantId, entry);
    // A rebuilt peer, or one created while the camera is already on, takes
    // the real track now -- the negotiated-from-the-start path.
    if (this.localTrack && this.localStream) {
      void this.attachLocalTrack(entry);
    }

    pc.onicecandidate = (event) => {
      if (!this.live(entry)) return;
      this.options.sendIce({
        callId: this.options.callId,
        participantId: this.options.selfParticipantId,
        targetParticipantId: participantId,
        candidate: event.candidate ? event.candidate.toJSON() : null,
      });
    };
    pc.onconnectionstatechange = () => {
      if (!this.live(entry)) return;
      this.options.onPeerState(participantId, pc.connectionState);
    };
    pc.ontrack = (event) => {
      // Mesh peers carry video only; call audio stays on its own transports.
      if (!this.live(entry) || event.track.kind !== 'video') return;
      const track = event.track;
      // No stream on the event means the track was negotiated empty; wrap it
      // with the platform's own MediaStream (injected), or the global one.
      const stream =
        event.streams[0] ??
        (this.options.createMediaStream
          ? this.options.createMediaStream([track])
          : typeof MediaStream === 'undefined'
            ? null
            : new MediaStream([track]));

      /**
       * CAMERA OFF MUST CLEAR THE TILE.
       *
       * Turning a camera off stops frames; it does not remove the track. A
       * <video> element holds the LAST frame it was given, so the other side
       * went on showing a frozen still of somebody who believed they had gone
       * dark. That is not just wrong, it is the wrong way round: the person
       * looks present when they have chosen not to be.
       *
       * The mute event is the signal for it, and it was documented here as
       * driving the placeholder while nothing actually listened for it. Now it
       * does: muted publishes null and the tile falls back to the avatar,
       * unmute publishes the stream again. No server state, no renegotiation --
       * the browser already knows.
       */
      const publish = (): void => {
        if (!this.live(entry)) return;
        this.options.onRemoteStream(participantId, track.muted ? null : stream);
      };
      // Guarded: a track without addEventListener still delivers video, and
      // taking the whole mesh down over a missing placeholder would trade a
      // frozen tile for no call at all.
      if (typeof track.addEventListener === 'function') {
        track.addEventListener('mute', publish);
        track.addEventListener('unmute', publish);
        track.addEventListener('ended', () => {
          if (this.live(entry)) this.options.onRemoteStream(participantId, null);
        });
      }
      publish();
    };
    pc.onnegotiationneeded = () => {
      void this.negotiate(entry);
    };

    this.attachLocalTrack(entry);
  }

  private async attachLocalTrack(entry: MeshPeer): Promise<CallVideoAttachResult> {
    const participantId = entry.participantId;
    if (entry.closed) return { participantId, outcome: 'failed', error: 'peer closed' };
    if (entry.sender) {
      // replaceTrack never renegotiates: the m-line stays, only the payload
      // changes (or stops, when the track is null). AWAITED: a rejection here
      // is the difference between video and a camera indicator lying.
      try {
        await entry.sender.replaceTrack(this.localTrack);
        /*
         * THE M-LINE WAS NEGOTIATED EMPTY, SO THE FIRST REAL TRACK RENEGOTIATES.
         *
         * Instant camera negotiates a sendrecv video m-line before there is
         * anything to send, so that "Camera on" is a replaceTrack rather than
         * a round trip. On the phone that transceiver never produced an
         * encoder: replaceTrack resolved, the sender held the camera track,
         * the attach reported success and outbound stayed at zero frames --
         * on both handsets at once, which is why neither side ever saw video
         * (founder review, 2 Sep). One renegotiation, only on the first real
         * track and only for a sender that began empty, gives the encoder an
         * m-line that was described with a track on it. Later toggles are
         * still a bare replaceTrack.
         */
        if (this.localTrack && entry.senderNegotiatedEmpty) {
          entry.senderNegotiatedEmpty = false;
          void this.negotiate(entry);
        }
        return { participantId, outcome: this.localTrack ? 'replaced' : 'cleared' };
      } catch (error) {
        return { participantId, outcome: 'failed', error: error instanceof Error ? error.message : 'replaceTrack rejected' };
      }
    }
    if (this.localTrack && this.localStream) {
      // First attach negotiates: addTrack fires negotiationneeded.
      try {
        entry.sender = entry.pc.addTrack(this.localTrack, this.localStream);
        return { participantId, outcome: 'added' };
      } catch (error) {
        return { participantId, outcome: 'failed', error: error instanceof Error ? error.message : 'addTrack rejected' };
      }
    }
    return { participantId, outcome: 'cleared' };
  }

  private async negotiate(entry: MeshPeer): Promise<void> {
    if (!this.live(entry)) return;
    entry.makingOffer = true;
    try {
      await entry.pc.setLocalDescription();
      if (!this.live(entry)) return;
      const sdp = entry.pc.localDescription?.sdp;
      if (!sdp) return;
      this.options.sendOffer({
        callId: this.options.callId,
        participantId: this.options.selfParticipantId,
        targetParticipantId: entry.participantId,
        sdp,
      });
    } catch {
      this.signallingFaultCount += 1;
    } finally {
      entry.makingOffer = false;
    }
  }

  private async flushRemoteCandidates(entry: MeshPeer): Promise<void> {
    while (entry.pendingRemoteCandidates.length > 0) {
      const candidate = entry.pendingRemoteCandidates.shift();
      if (candidate && this.live(entry)) {
        await entry.pc.addIceCandidate(candidate).catch(() => undefined);
      }
    }
  }

  /** Fail closed: only a CURRENT remote of this mesh may signal to it. */
  private knownSender(fromParticipantId: string): MeshPeer | null {
    if (this.disposed) return null;
    const entry = this.peers.get(fromParticipantId);
    if (!entry || entry.closed) {
      this.unknownSenderDropCount += 1;
      return null;
    }
    return entry;
  }

  /**
   * True while this entry is the mesh's live peer for its participant. Guards
   * every callback and every post-await continuation: a departed peer or a
   * disposed mesh must never fire stale callbacks.
   */
  private live(entry: MeshPeer): boolean {
    return (
      !this.disposed &&
      !entry.closed &&
      entry.generation === this.generation &&
      this.peers.get(entry.participantId) === entry
    );
  }

  private closePeer(entry: MeshPeer, opts: { notify: boolean }): void {
    if (entry.closed) return;
    entry.closed = true;
    this.peers.delete(entry.participantId);
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onnegotiationneeded = null;
    entry.pc.onconnectionstatechange = null;
    entry.pendingRemoteCandidates.splice(0);
    try {
      entry.pc.close();
    } catch {
      // The connection may already be closed.
    }
    if (opts.notify && !this.disposed) {
      this.options.onRemoteStream(entry.participantId, null);
      this.options.onPeerState(entry.participantId, 'closed');
    }
  }
}
