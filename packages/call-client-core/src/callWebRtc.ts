// Browser WebRTC transport for the two call peers (adapted from
// listener-web's transport patterns):
// - publish peer: sends only the raw getUserMedia microphone track;
// - receive peer: recvonly audio for the remote participant's original voice.
// Generated/translated audio never passes through either peer.

const MAX_QUEUED_REMOTE_CANDIDATES = 32;

/** Public STUN, used when the host has configured nothing. */
export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/**
 * Parses the host's configured ICE server list (call-web passes
 * VITE_WEBRTC_ICE_SERVERS). Never throws — a bad config must not take down
 * joining.
 *
 * ABSENT IS NOT EMPTY. This used to answer "no servers" for unset, malformed
 * and deliberately-empty alike, and a build whose env var was never set
 * shipped with no ICE servers at all. Audio survived it — audio is
 * server-mediated and the server has a public address, so a host candidate
 * reaches it — but call video is a peer-to-peer mesh, and two browsers each
 * behind their own NAT have no way to find one another. The result looked
 * like a video bug: audio fine, camera preview fine, remote video never
 * arriving.
 *
 * So unset or unparseable now means the default STUN list, and only an
 * explicit empty array means the operator genuinely wants none. STUN alone is
 * still not enough for symmetric or carrier-grade NAT — that needs TURN,
 * which is what configuring VITE_WEBRTC_ICE_SERVERS is for.
 */
export function readIceServers(raw?: string): RTCIceServer[] {
  if (raw === undefined || raw.trim().length === 0) return [...DEFAULT_ICE_SERVERS];
  try {
    const parsed = JSON.parse(raw) as RTCIceServer[];
    return Array.isArray(parsed) ? parsed : [...DEFAULT_ICE_SERVERS];
  } catch {
    return [...DEFAULT_ICE_SERVERS];
  }
}

/**
 * Asks the gateway which ICE servers to use, falling back to whatever the
 * build was configured with.
 *
 * ASKED AT CALL TIME, NOT BUILD TIME. A relay credential expires, so it
 * cannot live in a bundle that is compiled once and served for weeks. Fetching
 * also means the relay can be configured, moved or switched off on the server
 * without rebuilding and redeploying the browser app -- and a deployment that
 * forgets the build-time variable no longer silently ships a client with no
 * ICE servers at all.
 *
 * A failure here is not fatal: STUN-only still connects the majority of
 * calls, and losing video is better than failing to join.
 */
export async function fetchIceServers(
  gatewayUrl: string,
  options: { fetchImpl?: typeof fetch; fallbackRaw?: string; timeoutMs?: number } = {},
): Promise<RTCIceServer[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const fallback = readIceServers(options.fallbackRaw);
  if (typeof fetchImpl !== 'function') return fallback;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await fetchImpl(`${gatewayUrl.replace(/\/$/, '')}/webrtc/ice`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) return fallback;
    const payload = (await response.json()) as { iceServers?: unknown };
    // An empty list from the server is not an answer worth taking: it would
    // leave this client unable to connect anything but a local network.
    if (!Array.isArray(payload.iceServers) || payload.iceServers.length === 0) return fallback;
    return payload.iceServers as RTCIceServer[];
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
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
  /**
   * P6.4-W3: one remote track, with the transceiver `mid` that identifies WHICH
   * conference slot it is.
   *
   * `onRemoteStream` collapses every remote into one anonymous stream, which is
   * fine for a two-party call and useless for a conference: the constituent
   * speakers cannot be controlled separately. Both are emitted so the existing
   * two-party path is untouched.
   */
  onRemoteTrack?: (mid: string | null, track: MediaStreamTrack, stream: MediaStream) => void;
  /**
   * How many remote speakers this receive peer must be able to carry.
   *
   * ONE transceiver was offered here until P6.4-W3 human acceptance. The
   * gateway adds a track per conference slot, but SDP can only negotiate as
   * many m-lines as the OFFER contains — so with one, `getTransceivers()`
   * reported mids ["0", null, null] and two of the three slots were never
   * transmitted at all. The audio still worked, through the legacy
   * single-stream path, which is why it looked fine.
   */
  remoteSlotCount?: number;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  /** Used by the default RTCPeerConnection factory; omitted means no ICE servers. */
  iceServers?: RTCIceServer[];
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
      new RTCPeerConnection({ iceServers: options.iceServers ?? [] });

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
      // One per slot: fewer here silently discards the extra speakers.
      const slots = Math.max(1, options.remoteSlotCount ?? 1);
      for (let slot = 0; slot < slots; slot += 1) {
        this.peer.addTransceiver('audio', { direction: 'recvonly' });
      }
      this.peer.ontrack = (event) => {
        if (this.closed || event.track.kind !== 'audio') return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        // mid comes from the transceiver, never from parsing SDP. Null when the
        // browser cannot say, in which case the binder leaves it unresolved
        // rather than guessing whose voice it is.
        this.options.onRemoteTrack?.(event.transceiver?.mid ?? null, event.track, stream);
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
