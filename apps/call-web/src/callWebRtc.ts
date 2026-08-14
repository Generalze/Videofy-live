// Browser WebRTC transport for the two call peers (adapted from
// listener-web's transport patterns):
// - publish peer: sends only the raw getUserMedia microphone track;
// - receive peer: recvonly audio for the remote participant's original voice.
// Generated/translated audio never passes through either peer.

const MAX_QUEUED_REMOTE_CANDIDATES = 32;

export function readIceServers(): RTCIceServer[] {
  const raw = import.meta.env.VITE_WEBRTC_ICE_SERVERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as RTCIceServer[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface StoppableTrack {
  stop(): void;
}

export interface StoppableMediaStream {
  getTracks(): StoppableTrack[];
}

/**
 * Stops every track on a (microphone) stream. Used on leave, teardown and on
 * a failed join ack so the browser's recording indicator never stays lit
 * while the user is back on the pre-join screen.
 */
export function stopMediaStreamTracks(stream: StoppableMediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // The track may already be stopped.
    }
  }
}

export interface CallPeerOptions {
  direction: 'publish' | 'receive';
  /** Microphone stream; required for the publish peer. */
  stream?: MediaStream;
  /** Sends the local SDP offer to the gateway and resolves the answer SDP. */
  sendOffer: (sdp: string) => Promise<string>;
  onLocalIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  createPeerConnection?: () => RTCPeerConnection;
}

export class CallPeer {
  private readonly peer: RTCPeerConnection;
  private readonly pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private readonly seenRemoteCandidates = new Set<string>();
  private remoteDescriptionApplied = false;
  private closed = false;

  constructor(private readonly options: CallPeerOptions) {
    if (!options.createPeerConnection && !globalThis.RTCPeerConnection) {
      throw new Error('This browser does not support live call audio.');
    }
    this.peer =
      options.createPeerConnection?.() ??
      new RTCPeerConnection({ iceServers: readIceServers() });

    this.peer.onicecandidate = (event) => {
      if (this.closed || !event.candidate) return;
      this.options.onLocalIceCandidate(event.candidate.toJSON());
    };
    this.peer.onconnectionstatechange = () => {
      if (this.closed) return;
      this.options.onConnectionStateChange?.(this.peer.connectionState);
    };

    if (options.direction === 'publish') {
      const stream = options.stream;
      if (!stream) {
        throw new Error('A microphone stream is required to publish call audio.');
      }
      for (const track of stream.getAudioTracks()) {
        this.peer.addTrack(track, stream);
      }
    } else {
      this.peer.addTransceiver('audio', { direction: 'recvonly' });
      this.peer.ontrack = (event) => {
        if (this.closed || event.track.kind !== 'audio') return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.options.onRemoteStream?.(stream);
      };
    }
  }

  async connect(): Promise<void> {
    const offer = await this.peer.createOffer();
    if (this.closed) return;
    await this.peer.setLocalDescription(offer);
    const answerSdp = await this.options.sendOffer(
      this.peer.localDescription?.sdp ?? offer.sdp ?? '',
    );
    if (this.closed) return;
    await this.peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    this.remoteDescriptionApplied = true;
    await this.flushRemoteCandidates();
  }

  async addRemoteCandidate(candidate: RTCIceCandidateInit | null | undefined): Promise<void> {
    if (this.closed || !candidate?.candidate) return;
    const key = `${candidate.sdpMid ?? ''}:${candidate.sdpMLineIndex ?? ''}:${candidate.candidate}`;
    if (this.seenRemoteCandidates.has(key)) return;
    this.seenRemoteCandidates.add(key);
    if (!this.remoteDescriptionApplied) {
      if (this.pendingRemoteCandidates.length < MAX_QUEUED_REMOTE_CANDIDATES) {
        this.pendingRemoteCandidates.push(candidate);
      }
      return;
    }
    await this.peer.addIceCandidate(candidate).catch(() => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.peer.onicecandidate = null;
    this.peer.ontrack = null;
    this.peer.onconnectionstatechange = null;
    this.pendingRemoteCandidates.splice(0);
    try {
      this.peer.close();
    } catch {
      // The connection may already be closed.
    }
  }

  private async flushRemoteCandidates(): Promise<void> {
    while (this.pendingRemoteCandidates.length > 0) {
      const candidate = this.pendingRemoteCandidates.shift();
      if (candidate) {
        await this.peer.addIceCandidate(candidate).catch(() => undefined);
      }
    }
  }
}
