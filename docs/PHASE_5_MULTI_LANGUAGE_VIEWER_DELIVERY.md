# Phase 5 Multi-Language Viewer Delivery

## Decision

Uploaded programmes use one source video as the authoritative playback clock. The source MP4 is delivered once, while translated captions and generated WAV segments are delivered as independently selectable language channels.

Videofy does not render one MP4 per language for normal viewing. That approach would duplicate video storage, delay availability, and make language changes expensive. The existing viewer-ready mixed MP4 remains an optional export fallback and is constrained to the session's primary language.

## Audio paths

- Original programme audio remains attached to the source video and is routed through the Web Audio original gain.
- Generated translated speech is routed through a separate translated gain and timestamped queue.
- Interpretation defaults to original audio at 20 percent and translated audio at 100 percent.
- Replacement sets original gain to zero only after generated audio is available for the selected language.
- Caption-only, queued, failed, and unconfigured language channels always retain original programme audio.
- The dynamics compressor remains the shared final limiter.

Keeping the source audio in the original video avoids a second decode and a separate clock while still providing independent gain control.

## Language channels

The operator selects the language channels before creating a processing session. The viewer menu contains only those session languages. Language changes reuse the same programme video and session timeline, reset only the generated-audio queue, and replay retained events for the selected language.

Each channel reports one of:

- unavailable;
- queued;
- translating;
- captions ready;
- generating audio;
- audio and captions ready;
- failed.

The catalogue includes Spanish, French, Portuguese, Yoruba, Simplified Chinese, and Latin. Availability is determined from the configured OPUS-MT models and Piper voices. A catalogue entry is not proof that a model or voice is installed.

The validated local runtime currently provides real English-to-Spanish OPUS-MT translation and a Spanish Piper voice. Other catalogue languages remain disabled unless their approved local models are configured. A translation model without a compatible voice is exposed as captions only.

## Viewer operation

The viewer connects automatically. For uploaded programmes, the native video Play control is the only playback gesture required by browser autoplay policy. It starts the source video, resumes the Web Audio mixer, and starts the translated queue against the video's `currentTime`.

Pause, resume, seek, language selection, and volume changes do not recreate the media element. Partial media-state updates retain the active source URL for the same stream. A failed/cancelled session or a genuine source change invalidates it.

## Safety and cleanup

- Generated-audio URLs include the target language so equal segment IDs cannot resolve to the wrong channel.
- Gateway history is retained separately per session and language.
- Duplicate generated-audio events are rejected per session, segment, sequence, and language.
- On source change or teardown, the queue, object URLs, media element, peers, listeners, and timers follow the existing cleanup path.
- Local filesystem paths are never exposed to viewers.

## Known limitations

- The current local model and voice registry validates real Spanish only.
- Additional languages require separately reviewed OPUS-MT models and, for audio, compatible Piper voices.
- Multi-language processing increases CPU, memory, generation time, and generated-audio storage approximately with each enabled channel.
- Live WebRTC sources continue to use the primary session language; parallel live language workers remain a scale milestone.
- Browser autoplay rules still require one viewer gesture on the programme video before audible output.
