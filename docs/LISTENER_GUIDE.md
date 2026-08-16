# Viewer Guide

> The audience-facing page is the **Videofy Live Viewer**. "Listener" survives
> as the internal package name (`listener-web`) only; user-facing wording and
> documentation say Viewer. This file keeps its old filename so existing links
> do not break.

## Joining

1. Open the Videofy Live Viewer.
2. Select the intended language, Spanish for the validated partner-preview path.
3. Use the broadcast/session identifier if the operator provides one.
4. Click Join or Start Listening when prompted.

## Programme Media

For live video sources, the Viewer should show:

- Live programme audio.
- Live programme video.
- WebRTC media transport connected.
- Recovery count.

For uploaded audio-only sessions, Viewer WebRTC programme media may be inactive while generated translated audio is still delivered.

## Audio Modes

The Viewer labels these "How I hear this". The internal mixer names are given
here because operator and diagnostic surfaces still use them.

Interpretation ("Translated voice, original speaker softly underneath"):

- Original programme audio remains at reduced volume.
- Translated audio plays at normal volume.

Translated only, internally Replacement ("Original speaker silent"):

- Original audio is muted.
- Video remains visible when a video source is active.
- Translated audio continues through the generated-audio queue.

## Expected Spanish Demo Result

The Viewer should receive a generated Spanish audio segment with:

- Session ID.
- Segment ID.
- Sequence number.
- Target language `es`.
- Voice ID `es_ES-sharvard-medium`.
- Start and end timestamps.
- Duration.
- Provider latency.
- Playable audio URL.

## Recovery

If playback stops:

- Refresh the Viewer tab.
- Rejoin the session.
- Confirm the operator still shows a connected gateway and programme source.
- Use queue reset or replay only for demonstration verification.
