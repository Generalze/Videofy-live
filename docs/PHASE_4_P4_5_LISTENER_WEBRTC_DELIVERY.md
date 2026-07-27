# Phase 4 P4.5 Listener WebRTC Delivery

Date: 2026-07-27

Scope: listener original programme-audio delivery only.

## Architecture

P4.5 keeps the broadcaster-to-backend WebRTC ingest path from P4.3 and the transcription bridge from P4.4. The backend now also creates a listener-facing WebRTC peer when a listener has joined the signalling session and broadcaster audio activity is confirmed.

Topology:

1. Broadcaster browser publishes one audio track to `peer_backend_media`.
2. `services/realtime-gateway` terminates that broadcaster peer with `@roamhq/wrtc`.
3. The backend audio sink continues feeding the P4.4 transcription bridge.
4. The same decoded PCM frames are fanned out to listener delivery peers through `RTCAudioSource`.
5. Listener browsers answer backend SDP offers as receive-only audio peers.
6. Listener media elements receive the programme `MediaStream` and remain the original-audio source for the Phase 3 mixer.

There is one authoritative broadcaster programme source per WebRTC signalling session. Listeners do not publish tracks. Generated translated audio is still delivered by the existing safe HTTP WAV route and the timestamped browser queue.

## Signalling

P4.5 reuses the existing Socket.IO WebRTC signalling contracts, room ownership, peer roles, message IDs, revisions, acknowledgements, stale-message rejection, and teardown events.

The only contract extension is that listener clients now receive backend `sdp-offer` events and can send `sdp-answer` events to `peer_backend_media`. Backend-generated listener offers use the next session revision and are still routed through `WebRtcSessionRegistry`.

ICE candidates remain opaque. The gateway logs safe lifecycle metadata only; it does not log raw SDP, ICE payloads, audio frames, local filesystem paths, or secrets.

## Listener Behavior

The listener transport controller:

- creates one `RTCPeerConnection`;
- adds one `audio` transceiver with `recvonly`;
- creates no microphone, camera, or video publishing track;
- rejects stale offers and duplicate tracks;
- reports negotiation, track receipt, playback-blocked, playing, failed, and closed states;
- closes on listener leave, refresh, peer disconnect, and repeated teardown.

When the remote stream arrives, the app assigns it to the existing listener media element. The Phase 3 mixer continues to use that element as the original programme source.

Interpretation Mode lowers original gain to the configured level. Replacement Mode keeps the WebRTC media timeline alive while setting effective original gain to zero. Mode switching does not renegotiate WebRTC and does not change generated translated-audio queue ordering.

## Recovery And Limits

Handled cases:

- listener joins before broadcaster audio is ready;
- broadcaster starts after listener join;
- broadcaster disconnect/session close;
- listener leave/refresh;
- duplicate listener delivery peer prevention;
- stale answer and ICE rejection;
- duplicate track rejection;
- autoplay blocked by browser policy surfaced separately from track receipt.

Configured limits:

- listener delivery peer registry default active peers: 32;
- listener answer timeout: 8 seconds;
- queued ICE candidates per listener peer: 64;
- browser queued remote candidates: 32.

## Validation

Added automated coverage:

- backend listener peer offer creation, outbound audio track creation, ICE emission, answer handling, ICE deduplication, PCM frame fanout, duplicate peer prevention, stale answer rejection, and cleanup;
- gateway integration proving a joined listener receives a backend programme-audio offer after broadcaster audio activity;
- browser listener transport receive-only answer flow, duplicate track rejection, stale offer handling, playback-blocked state;
- listener signalling panel truthful media-transport status.

P4.5 does not include speaker-level acoustic validation. Browser validation must distinguish WebRTC track receipt from whether the OS speaker produced audible sound.

## Limitations

- Local topology uses backend fanout through `@roamhq/wrtc`; no SFU, MCU, TURN deployment, or managed WebRTC provider is included.
- No listener video is delivered in P4.5.
- WebRTC original audio and generated translated audio are separate browser paths; translated audio is not sent over WebRTC.
- Browser autoplay policies can block playback until a user gesture. The UI reports this separately from track receipt.
- State remains in memory, consistent with prior phases.

## Preservation

P4.5 preserves:

- Phase 1 mock controls outside the replaced media paths;
- P2 upload, microphone ingest, transcription, translation, TTS, monitoring, recovery, and exports;
- P3 generated audio delivery, timestamp queue, Interpretation Mode, and Replacement Mode;
- P4.0-P4.4 signalling, broadcaster capture, backend ingest, and WebRTC transcription bridge.

## Closure

P4.5 validation completed:

- `npm test`: passed 298 tests across 43 files.
- `npm run build`: passed.
- `npm run lint`: passed with zero warnings.
- `npm run typecheck`: passed.
- `npm audit --omit=dev`: passed with zero vulnerabilities.
- Browser harness: `.videofy-dev-logs/p4-5-browser-e2e-result.json`.

Browser evidence:

- Chrome `149.0.7827.55`, headless, fake audio capture.
- Broadcaster peer published one audio track and reached connected ICE state.
- Backend received broadcaster audio and detected audio activity.
- Listener peer created a receive-only audio transceiver, received one live audio track, sent no local media tracks, and attached a live audio stream to the existing listener media element.
- Interpretation/Replacement mode toggles did not create an additional listener peer or renegotiate WebRTC.
- Speaker output was not validated; the evidence is limited to WebRTC track receipt and media-element attachment.

Next milestone: P4.6 reconnect, failure recovery, and observability hardening.
