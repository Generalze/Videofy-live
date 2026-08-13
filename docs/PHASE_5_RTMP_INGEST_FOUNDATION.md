# Phase 5 RTMP Ingest Foundation

## Scope

This pass adds a local RTMP bridge for partner demonstrations. Videofy still uses one programme-source session and the existing HLS browser playback path for programme video and listener original audio/video delivery:

OBS or encoder -> MediaMTX RTMP ingest -> MediaMTX HLS output -> Videofy RTMP source -> WebRTC programme video/listener delivery -> transcription -> Spanish translation -> Piper audio -> listeners.

Chrome real-browser validation exposed that hls.js-backed HLS media-element capture can produce a live browser audio track with silent PCM samples even when MediaMTX HLS audio is audible through FFmpeg. For RTMP sessions only, the operator sends the derived local MediaMTX HLS playback URL in the authoritative session config and the realtime gateway starts an FFmpeg PCM16 extraction reader from that URL for transcription chunks. Uploaded video, direct MP4/WebM, direct HLS, camera, screen, OBS camera and listener WebRTC delivery keep their existing paths.

The implementation does not add RTMP playback in the browser, RTMP server code inside Videofy, platform scraping, Zoom/Teams/Meet APIs, public deployment, or a new transcription, translation, TTS or listener pipeline.

## MediaMTX Setup

Use the official MediaMTX release from `https://github.com/bluenviron/mediamtx/releases` or a verified package for the same project. Start it from the repository root with:

```powershell
mediamtx .\infra\mediamtx\mediamtx.yml
```

The checked-in local demo configuration enables:

- RTMP ingest on `rtmp://localhost:1935`
- HLS playback on `http://localhost:8888`
- permissive HLS CORS for local browser testing
- publisher-driven paths only

## OBS Publish Settings

Configure OBS with built-in output only:

- Service: `Custom`
- Server: `rtmp://localhost:1935/live`
- Stream key: `videofy-demo`
- Video encoder: H.264
- Audio encoder: AAC
- Keyframe interval: 2 seconds

When OBS is publishing, MediaMTX exposes:

```text
http://localhost:8888/live/videofy-demo/index.m3u8
```

## Operator Flow

In the operator programme source panel:

1. Enter the RTMP publish URL, stream key, and MediaMTX HLS base URL.
2. Select `Use RTMP`.
3. Wait until the preview reports both audio and video detected.
4. Click `Start Interpretation` once.

The RTMP stream key is validated as a safe path segment and is not treated as a filesystem path. The operator UI derives the HLS playback URL and routes it through the validated HLS playback path used for direct `.m3u8` sources. The gateway accepts the derived HLS URL for RTMP transcription only when it is a local `http://` or `https://` URL ending in `/index.m3u8`.

## States

- `waiting for stream`: MediaMTX HLS output has been configured, but browser metadata is not ready yet.
- `live`: the HLS output exposed browser-playable audio and video.
- `interrupted`: HLS playback failed after selection or during broadcast.
- `recovered`: the same RTMP path was selected successfully after interruption.
- `ended`: the media element ended normally.

Interpretation cannot start while the RTMP source is waiting for stream metadata or missing audio/video tracks.

## Validation Notes

Completed local proof on Windows:

- MediaMTX v1.19.3 Windows amd64 downloaded from the official GitHub release and checksum-verified.
- OBS Studio 32.2.1 published to `rtmp://127.0.0.1:1935/live` with stream key `videofy-demo`.
- MediaMTX exposed `http://127.0.0.1:8888/live/videofy-demo/index.m3u8` with H.264 video and AAC audio.
- A verified English MP4 speech sample played through OBS Desktop Audio. MediaMTX HLS audio measured `mean_volume -22.0 dB`, `max_volume -6.0 dB` before Videofy validation.
- Chrome Headless 149 loaded the RTMP source, started the one-click interpretation workflow, and created one broadcaster peer and one listener peer.
- Listener received one live audio track and one live video track.
- Gateway started RTMP HLS audio extraction for the same session and delivered a non-empty Spanish translation plus Piper audio.
- Generated Spanish WAV evidence: `tts-000000.wav`, 16.52 seconds, 528632 bytes.
- Interruption/recovery proof: stopping OBS made the MediaMTX HLS URL return `404 Not Found`; restarting OBS restored `200 OK` with one established RTMP connection; a post-recovery Chrome run again produced one peer, one generated-audio event and non-empty Spanish output.
- Cleanup evidence showed object URLs revoked and media tracks stopped in the browser harness.

Representative translated listener output:

```text
pasos que recibes reparación estructurada pruebas cuidadosas y informes técnicos profesionales...
```

If MediaMTX or OBS is unavailable on the machine, RTMP browser validation remains blocked until both are installed and OBS is publishing to the local gateway.

## Limitations

- Local demo configuration only.
- No authentication or public RTMP endpoint.
- No production TURN or horizontal scaling changes.
- No YouTube, Zoom, Teams, Meet, or social-platform URL adapters.
- Browser playback depends on MediaMTX HLS output using browser-supported H.264/AAC codecs and CORS-compatible responses.
- RTMP transcription currently depends on local FFmpeg being available to the realtime gateway.
- The browser listener still receives programme original audio/video through WebRTC; the FFmpeg RTMP-HLS audio bridge is used only to prevent silent Chrome HLS capture from blocking transcription.
