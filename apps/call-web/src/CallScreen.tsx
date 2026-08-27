import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { CallCaptionEntry } from '@videofy-live/call-client-core';
import { CALL_AUDIO_MODES, CALL_LANGUAGES, languageLabel } from './callFormState';
import { defaultSessionStorage, readAccountSession, readAccountUrl } from './accountSession';
import { downloadTranscript, translationDisclosureFor } from '@videofy-live/call-client-core';
import type {
  CallAudioMode,
  CallLanguage,
  CallMode,
  CallParticipantSummary,
} from '@videofy-live/call-client-core';

export type CallConnectionPhase = 'connecting' | 'connected' | 'reconnecting' | 'restoring';

export interface CallScreenProps {
  /**
   * P6.4-W3.1 product contract: Personal Call and Conference are distinct
   * products sharing a call surface, not one page pretending to be both.
   */
  callType?: 'personal' | 'conference';
  /**
   * W5: the authoritative call-global mode from the snapshot. In `normal` the
   * translation engine is OFF, so every translated-call control (captions,
   * transcript, audio-mode, translated volume) is WITHHELD from the markup,
   * not merely disabled — the W3.1 rule.
   */
  callMode?: CallMode;
  /** W5: whether THIS participant is the call owner (mode authority). */
  isOwner?: boolean;
  callModeBusy?: boolean;
  /** Owner-only; the gateway refuses anyone else. */
  onCallModeChange?: (mode: CallMode) => void;
  /**
   * Owner-switchable, default true. When off, the download affordance is
   * withheld for everyone (the owner keeps the policy toggle itself).
   */
  transcriptDownloadAllowed?: boolean;
  /** Owner-only; the gateway refuses anyone else. */
  onTranscriptPolicyChange?: (allowed: boolean) => void;
  /**
   * V1 video (development-demo P2P mesh). Streams are keyed by participant;
   * a missing entry renders the avatar — an audio-only participant is a
   * first-class state, not a degraded one.
   */
  localVideoStream?: MediaStream | null;
  remoteVideoStreams?: ReadonlyMap<string, MediaStream>;
  cameraOn?: boolean;
  onToggleCamera?: () => void;
  /**
   * W8 output routing. Null means the platform exposes ONLY the system
   * default — the surface then says so honestly instead of faking routes.
   * deviceIds live exclusively inside option values here; they are never
   * logged or emitted anywhere.
   */
  audioOutput?: { devices: readonly { deviceId: string; label: string }[]; selectedId: string | null } | null;
  onAudioOutputChange?: (deviceId: string | null) => void;
  callCode: string;
  selfParticipantId: string;
  participants: readonly CallParticipantSummary[];
  phase: CallConnectionPhase;
  statusNote: string | null;
  /**
   * Autoplay policy refused playback. A tap genuinely fixes this, which is why
   * it is the ONLY state that offers "Enable audio".
   */
  playbackBlocked: boolean;
  /** Transport truth for the two voice legs, so silence can name its link. */
  voiceLegs?: { publish: RTCPeerConnectionState; receive: RTCPeerConnectionState };
  /** The element's own `playing` verdict for any remote original. */
  remoteVoiceHeard?: boolean;
  /**
   * Translated audio could not be fetched or decoded. A tap cannot fix it, so
   * offering one would be a button that does nothing — which is worse than
   * saying plainly that the audio is unavailable. The call continues on the
   * original voice and captions.
   */
  translatedAudioUnavailable: boolean;
  /**
   * P6.4-W3: local playback state for each remote speaker whose track is
   * BOUND. Idle preallocated receive slots are absent by construction, so a
   * nameless empty slot can never appear as a participant.
   */
  remoteSpeakers?: readonly {
    speakerParticipantId: string;
    muted: boolean;
    volume: number;
    /** The mode's gain over this speaker's original, 0..1 (W4). */
    modeGain?: number;
    /** The audio mode silenced this speaker's original; their delivery is TTS. */
    originalSuppressed?: boolean;
  }[];
  /** Local listener preferences only. Never sent to the gateway. */
  onSpeakerMutedChange?: (speakerParticipantId: string, muted: boolean) => void;
  onSpeakerVolumeChange?: (speakerParticipantId: string, volume: number) => void;
  captions: readonly CallCaptionEntry[];
  captionsVisible: boolean;
  audioMode: CallAudioMode;
  originalVolume: number;
  translatedVolume: number;
  micMuted: boolean;
  onToggleMute: () => void;
  onToggleCaptions: () => void;
  onCaptionLanguageChange: (language: CallLanguage) => void;
  captionLanguageBusy: boolean;
  onAudioModeChange: (mode: CallAudioMode) => void;
  onOriginalVolumeChange: (value: number) => void;
  onTranslatedVolumeChange: (value: number) => void;
  onEnableAudio: () => void;
  onLeave: () => void;
  /**
   * Ends the call for everyone. Absent when this participant may not — the
   * button is then not rendered at all rather than rendered disabled.
   */
  onEndCall?: () => void;
}

export function CallScreen(props: CallScreenProps) {
  const captionsBodyRef = useRef<HTMLDivElement | null>(null);
  // Advanced audio mixing is a secondary task (§5.1.3): it expands from a
  // compact control instead of holding permanent space beside the stage.
  const [audioSettingsOpen, setAudioSettingsOpen] = useState(false);
  const audioSettingsId = useId();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  /**
   * V1 spotlight: click a video to bring that person up; click again to go
   * back. Double-click hands the element to the browser's fullscreen, which
   * is where pinch/scroll zoom lives. Cleared automatically if the featured
   * participant leaves.
   */
  const [featuredParticipantId, setFeaturedParticipantId] = useState<string | null>(null);
  const transcriptId = useId();

  useEffect(() => {
    const body = captionsBodyRef.current;
    if (body) {
      body.scrollTop = body.scrollHeight;
    }
  }, [props.captions, props.captionsVisible]);

  const callMode: CallMode = props.callMode ?? 'translated';
  const featuredId =
    featuredParticipantId !== null &&
    props.participants.some((participant) => participant.participantId === featuredParticipantId)
      ? featuredParticipantId
      : null;
  const others = props.participants.filter(
    (participant) => participant.participantId !== props.selfParticipantId,
  );
  const self = props.participants.find(
    (participant) => participant.participantId === props.selfParticipantId,
  );
  const speakingParticipantId = activeSpeakerId(props.captions);

  /**
   * A TRANSLATED call with nothing to translate.
   *
   * When everyone present speaks and reads the same language there is no work
   * for the engine, so people hear each other's real voices -- which is
   * correct, and indistinguishable from the engine being broken. It happened
   * for real: one participant joined in French, rejoined later in English, and
   * their partner spent the call wondering why they were hearing untranslated
   * French. Nothing on screen said the call had stopped translating.
   *
   * Said plainly here, where it can be acted on, instead of leaving somebody
   * to infer it from silence.
   */
  const joinedOthers = others.filter((participant) => participant.joined);
  const nothingToTranslate =
    callMode === 'translated' &&
    joinedOthers.length > 0 &&
    self !== undefined &&
    joinedOthers.every(
      (participant) =>
        participant.speakLanguage === self.hearLanguage &&
        self.speakLanguage === participant.hearLanguage,
    );

  /*
   * Whether at least one person here will be TRANSLATED into this listener's
   * language -- which is exactly when the disclosure must appear.
   *
   * Not the negation of `nothingToTranslate`: that is false before anybody
   * else has joined, and a warning shown to somebody sitting alone in an empty
   * call is a warning they learn to dismiss before it ever matters.
   */
  const translationDisclosed =
    callMode === 'translated' &&
    self !== undefined &&
    joinedOthers.some((participant) => participant.speakLanguage !== self.hearLanguage);
  const disclosure = translationDisclosureFor(self?.hearLanguage ?? 'en');

  return (
    <main className="call-screen">
      <header className="call-header">
        <h1 className="call-title">
          {props.callType === 'conference' ? 'Videofy Conference' : 'Videofy Call'} ·{' '}
          <span>{props.callCode}</span>
        </h1>
        <div className="call-status" role="status">
          <span className={statusDotClass(props.phase)} aria-hidden="true" />
          <span>{statusText(props.phase, props.statusNote)}</span>
          <span className="call-mode-chip">
            {callMode === 'normal' ? 'Normal' : 'Translated'}
          </span>
          {props.playbackBlocked ? (
            <button type="button" className="enable-audio-button" onClick={props.onEnableAudio}>
              Enable audio
            </button>
          ) : null}
          {voiceDiagnostic(props)}
          {!props.playbackBlocked && props.translatedAudioUnavailable ? (
            <span className="translated-audio-unavailable" role="alert">
              Translated audio unavailable
            </span>
          ) : null}
          {nothingToTranslate ? (
            <span className="call-no-translation" role="status">
              Nothing to translate — everyone here is on{' '}
              {languageLabel(self?.hearLanguage ?? 'en')}
            </span>
          ) : null}
        </div>
      </header>

      {/*
        * The anti-deception notice.
        *
        * Deliberately its own bar rather than another chip in the status line:
        * this is the one piece of text on the screen whose entire purpose is to
        * be read by somebody who is being lied to. There is no dismiss control
        * and no preference that turns it off.
        *
        * `lang` is set so a screen reader pronounces French with a French
        * voice; without it the warning is read out as gibberish to precisely
        * the person least able to fall back on the visual.
        */}
      {translationDisclosed ? (
        <p className="call-translation-disclosure" role="note" lang={disclosure.locale}>
          {disclosure.banner}
        </p>
      ) : null}

      <section
        className={[
          'call-stage',
          props.callType === 'personal' ? 'is-personal' : '',
          featuredId !== null ? 'is-spotlight' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label="People on this call"
      >
        {others.map((participant) => {
          const audio = props.remoteSpeakers?.find(
            (speaker) => speaker.speakerParticipantId === participant.participantId,
          );
          return (
            <ParticipantTile
              key={participant.participantId}
              participant={participant}
              speaking={participant.participantId === speakingParticipantId}
              translatedAudioUnavailable={props.translatedAudioUnavailable}
              videoStream={props.remoteVideoStreams?.get(participant.participantId) ?? null}
              featured={participant.participantId === featuredId}
              onToggleFeatured={() =>
                setFeaturedParticipantId((current) =>
                  current === participant.participantId ? null : participant.participantId,
                )
              }
              {...(audio ? { audio } : {})}
              {...(props.onSpeakerMutedChange
                ? { onMutedChange: props.onSpeakerMutedChange }
                : {})}
              {...(props.onSpeakerVolumeChange
                ? { onVolumeChange: props.onSpeakerVolumeChange }
                : {})}
            />
          );
        })}
        {self ? (
          <ParticipantTile
            participant={self}
            isSelf
            speaking={self.participantId === speakingParticipantId}
            videoStream={props.localVideoStream ?? null}
          />
        ) : null}
        {others.length === 0 ? (
          <p className="participant-waiting">
            {/* Capacity-neutral: a conference is not "the other person". */}
            Waiting for someone to join — share the call code {props.callCode}.
          </p>
        ) : null}
      </section>

      <section className="captions" aria-label="Live captions">
        <div className="captions-header">
          <span className="captions-live-dot" aria-hidden="true" />
          Live captions
          {/*
            Reading language belongs beside the captions it governs, not in a
            settings screen: it is what the reader is looking at when they
            realise they want a different one. Only this reader moves.
          */}
          {callMode === 'normal' ? null : (
          <label className="captions-language">
            <span className="sr-only">Read captions in</span>
            <select
              value={self?.hearLanguage ?? 'en'}
              disabled={props.captionLanguageBusy}
              onChange={(event) =>
                props.onCaptionLanguageChange(event.target.value as CallLanguage)
              }
            >
              {CALL_LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </select>
          </label>
          )}
          <button
            type="button"
            className={transcriptOpen ? 'transcript-toggle is-active' : 'transcript-toggle'}
            aria-expanded={transcriptOpen}
            aria-controls={transcriptId}
            onClick={() => setTranscriptOpen((open) => !open)}
          >
            Transcript ({props.captions.length})
          </button>
        </div>
        {props.captionsVisible ? (
          // LIVE strip: only the newest lines. A two-hour meeting must never
          // grow the page until the controls need scrolling to reach — history
          // lives in the transcript drawer, which scrolls inside itself.
          <div className="captions-live">
            {props.captions.length === 0 ? (
              <p className="captions-empty">Captions will appear here as people speak.</p>
            ) : (
              props.captions.slice(-LIVE_CAPTION_COUNT).map((entry) => (
                <CaptionEntryView key={entry.id} entry={entry} />
              ))
            )}
          </div>
        ) : (
          <p className="captions-hidden-note">Captions are off.</p>
        )}
      </section>

      {/*
        Full conversation history in its own scroll container. Kept mounted and
        hidden so opening it never loses scroll position; `hidden` also removes
        it from the accessibility tree while closed.
      */}
      <aside
        className="transcript-drawer"
        id={transcriptId}
        aria-label="Conversation transcript"
        hidden={!transcriptOpen || !props.captionsVisible}
      >
        <header className="transcript-header">
          <h2 className="transcript-title">Transcript</h2>
          <div className="transcript-actions">
            {props.isOwner && props.onTranscriptPolicyChange ? (
              /* Call-global policy, so it is owner-only — like Call Mode, a
                 control the gateway would refuse must not look available. */
              <label className="transcript-policy">
                <input
                  type="checkbox"
                  checked={props.transcriptDownloadAllowed ?? true}
                  onChange={(event) => props.onTranscriptPolicyChange?.(event.target.checked)}
                />
                Downloadable
              </label>
            ) : null}
            {(props.transcriptDownloadAllowed ?? true) && props.captions.length > 0 ? (
              <button
                type="button"
                className="transcript-close transcript-download"
                onClick={() => downloadTranscript(props.callCode, props.captions)}
              >
                Download
              </button>
            ) : null}
            <button
              type="button"
              className="transcript-close"
              onClick={() => setTranscriptOpen(false)}
            >
              Close
            </button>
          </div>
        </header>
        <div className="transcript-scroll" ref={captionsBodyRef}>
          {/* Hiding captions must WITHHOLD the text, not merely style it away:
              `hidden` removes it from view, but the words would still be in the
              markup for anything that reads the page. */}
          {props.captionsVisible
            ? props.captions.map((entry) => <CaptionEntryView key={entry.id} entry={entry} />)
            : null}
          {props.captionsVisible && props.captions.length === 0 ? (
            <p className="transcript-empty">Nothing said yet.</p>
          ) : null}
        </div>
      </aside>

      <footer className="control-bar">
        <div className="control-cluster">
          <button
            type="button"
            className={props.micMuted ? 'control-button is-active' : 'control-button'}
            aria-pressed={props.micMuted}
            onClick={props.onToggleMute}
          >
            {props.micMuted ? 'Unmute' : 'Mute'}
          </button>

          {props.onToggleCamera ? (
            <button
              type="button"
              className={props.cameraOn ? 'control-button is-active' : 'control-button'}
              aria-pressed={props.cameraOn ?? false}
              onClick={props.onToggleCamera}
            >
              Camera
            </button>
          ) : null}

          <button
            type="button"
            className={props.captionsVisible ? 'control-button is-active' : 'control-button'}
            aria-pressed={props.captionsVisible}
            onClick={props.onToggleCaptions}
          >
            Captions
          </button>

          {props.isOwner && props.onCallModeChange ? (
            /*
              Call Mode is CALL-GLOBAL and owner-only — everyone's call flips,
              which is why this is not offered to other participants at all
              rather than shown disabled: a control that would be refused by
              the gateway must not look available.
            */
            <label className="mode-select call-mode-owner">
              Call mode
              <select
                value={callMode}
                disabled={props.callModeBusy ?? false}
                onChange={(event) => props.onCallModeChange?.(event.target.value as CallMode)}
              >
                <option value="normal">Normal</option>
                <option value="translated">Translated</option>
              </select>
            </label>
          ) : null}

          <button
            type="button"
            className={audioSettingsOpen ? 'control-button is-active' : 'control-button'}
            aria-expanded={audioSettingsOpen}
            aria-controls={audioSettingsId}
            onClick={() => setAudioSettingsOpen((open) => !open)}
          >
            Audio
          </button>

          {/*
            Leaving and ending are two different acts, so they are two
            different buttons.

            In a personal call there is only one sensible action: with two
            seats, stepping out ends the conversation either way, so the single
            button says what actually happens.

            In a conference everyone can Leave, and the chairman additionally
            can close the meeting for everyone. The end control is offered ONLY
            to the chairman — the gateway would refuse it from anyone else, and
            a control that would be refused must not look available.
          */}
          {props.callType === 'personal' ? (
            <button
              type="button"
              className="control-button is-danger"
              onClick={props.onEndCall ?? props.onLeave}
            >
              End call
            </button>
          ) : (
            <>
              <button type="button" className="control-button is-danger" onClick={props.onLeave}>
                Leave
              </button>
              {props.isOwner && props.onEndCall ? (
                <button
                  type="button"
                  className="control-button is-danger"
                  onClick={props.onEndCall}
                >
                  End for everyone
                </button>
              ) : null}
            </>
          )}
        </div>

        {/*
          Kept mounted and hidden rather than unmounted: `hidden` removes it from
          both the accessibility tree and the tab order, so a collapsed panel
          cannot trap focus, while the controls keep their identity and state.
        */}
        <div className="audio-drawer" id={audioSettingsId} hidden={!audioSettingsOpen}>
          {callMode === 'normal' ? null : (
          <label className="mode-select">
            How you hear them
            <select
              value={props.audioMode}
              onChange={(event) => props.onAudioModeChange(event.target.value as CallAudioMode)}
            >
              {CALL_AUDIO_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
            <span className="mode-select-hint">
              {CALL_AUDIO_MODES.find((mode) => mode.value === props.audioMode)?.description}
            </span>
          </label>
          )}

          {props.audioOutput ? (
            <label className="mode-select audio-output-select">
              Audio output
              <select
                value={props.audioOutput.selectedId ?? ''}
                onChange={(event) =>
                  props.onAudioOutputChange?.(
                    event.target.value === '' ? null : event.target.value,
                  )
                }
              >
                <option value="">System default</option>
                {props.audioOutput.devices.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Audio output ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="audio-output-static">Playing through the system audio output</span>
          )}

          <div className="slider-group">
            <div className={props.audioMode === 'translated' ? 'slider is-disabled' : 'slider'}>
              <label htmlFor="original-volume">Their voice</label>
              <input
                id="original-volume"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={props.originalVolume}
                disabled={props.audioMode === 'translated'}
                onChange={(event) => props.onOriginalVolumeChange(Number(event.target.value))}
              />
            </div>
            {callMode === 'normal' ? null : (
            <div className={props.audioMode === 'original' ? 'slider is-disabled' : 'slider'}>
              <label htmlFor="translated-volume">Translated voice</label>
              <input
                id="translated-volume"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={props.translatedVolume}
                disabled={props.audioMode === 'original'}
                onChange={(event) => props.onTranslatedVolumeChange(Number(event.target.value))}
              />
            </div>
            )}
          </div>
        </div>
      </footer>
    </main>
  );
}

/** Newest lines shown in the live strip; everything else is transcript history. */
const LIVE_CAPTION_COUNT = 3;

function CaptionEntryView({ entry }: { entry: CallCaptionEntry }) {
  return (
    <article className={entry.isFinal ? 'caption-entry' : 'caption-entry is-partial'}>
      <span className="caption-speaker">{entry.speakerDisplayName}</span>
      <p className="caption-text">
        {entry.primaryText}
        {entry.isFinal ? null : (
          // Provisional wording must be announced, not just dimmed: colour and
          // opacity alone cannot carry state (§5.1.13).
          <span className="sr-only"> (still speaking)</span>
        )}
      </p>
      {entry.originalText ? (
        <details className="caption-original">
          <summary>View original</summary>
          <p>{entry.originalText}</p>
        </details>
      ) : null}
    </article>
  );
}

function ParticipantTile(props: {
  participant: CallParticipantSummary;
  isSelf?: boolean;
  speaking?: boolean;
  /**
   * Present once this participant's audio track is BOUND.
   *
   * Absent means their audio has not resolved yet. The controls are still
   * shown, disabled: making "no controls" the only signal left a real
   * participant looking identical to a participant with nothing wrong, which is
   * exactly how a transport defect went unnoticed through a live 3-party test.
   */
  audio?: {
    speakerParticipantId: string;
    muted: boolean;
    volume: number;
    modeGain?: number;
    originalSuppressed?: boolean;
  };
  /**
   * The deployment has no translation engine, so the tile must not promise a
   * translated voice it will never hear.
   */
  translatedAudioUnavailable?: boolean;
  /** Null/absent = audio-only participant; the avatar is the clean placeholder. */
  videoStream?: MediaStream | null;
  /** Spotlighted by a click; the stage lays this tile out large. */
  featured?: boolean;
  onToggleFeatured?: () => void;
  onMutedChange?: (speakerParticipantId: string, muted: boolean) => void;
  onVolumeChange?: (speakerParticipantId: string, volume: number) => void;
}) {
  const { participant, audio } = props;
  const tileClass = [
    'participant-tile',
    props.speaking ? 'is-speaking' : '',
    props.isSelf ? 'is-self' : '',
    props.videoStream ? 'has-video' : '',
    props.featured ? 'is-featured' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <article className={tileClass}>
      {props.videoStream ? (
        /*
          The video is the control: click brings this person up (spotlight),
          double-click asks the browser for real fullscreen — pinch/scroll
          zoom belongs to the platform, not to a homemade zoom UI.
        */
        <button
          type="button"
          className="participant-video-button"
          aria-label={
            props.featured
              ? `Shrink ${participant.displayName}'s video`
              : `Expand ${participant.displayName}'s video`
          }
          aria-pressed={props.featured ?? false}
          onClick={props.onToggleFeatured}
          onDoubleClick={(event) => {
            const video = event.currentTarget.querySelector('video');
            void video?.requestFullscreen?.().catch(() => {});
          }}
        >
          <video
            className="participant-video"
            autoPlay
            playsInline
            /* The video track carries no audio (voice arrives through the
               per-speaker audio elements); muted also keeps autoplay safe. */
            muted
            ref={(element) => {
              if (element && element.srcObject !== props.videoStream) {
                element.srcObject = props.videoStream ?? null;
              }
            }}
          />
        </button>
      ) : (
        <ParticipantFace participant={participant} />
      )}
      <span className="participant-name">
        <span
          className={participant.joined ? 'status-dot is-connected' : 'status-dot'}
          aria-hidden="true"
        />
        {participant.displayName}
        {props.isSelf ? <span className="participant-you">(you)</span> : null}
      </span>
      {props.videoStream ? null : (
        <span className="participant-languages">
          Speaks {languageLabel(participant.speakLanguage)} · hears{' '}
          {languageLabel(participant.hearLanguage)}
        </span>
      )}
      {props.speaking ? <span className="participant-speaking">Speaking</span> : null}
      {props.isSelf ? null : (
        <div
          className={
            !audio
              ? 'participant-audio-controls is-unavailable'
              : audio.originalSuppressed
                ? 'participant-audio-controls is-suppressed'
                : 'participant-audio-controls'
          }
        >
          <button
            type="button"
            className="participant-mute"
            aria-pressed={audio ? audio.muted : false}
            /*
              Enabled while the original is suppressed, because these controls
              now govern the TRANSLATED voice -- the audio this listener is
              actually hearing from this person. They used to be disabled here,
              which left a translated call with no way to mute or turn down one
              participant: the only live control was a single slider for
              everyone at once.
            */
            disabled={!audio}
            onClick={() =>
              audio && props.onMutedChange?.(audio.speakerParticipantId, !audio.muted)
            }
          >
            {/* Local only: this never mutes them for anybody else on the call. */}
            {audio?.muted ? `Unmute ${participant.displayName}` : `Mute ${participant.displayName}`}
          </button>
          <label className="participant-volume">
            <span className="participant-volume-label">{participant.displayName} volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={audio ? audio.volume : 1}
              disabled={!audio}
              onChange={(event) =>
                audio &&
                props.onVolumeChange?.(audio.speakerParticipantId, Number(event.target.value))
              }
            />
          </label>
          {!audio ? (
            <span className="participant-audio-pending" role="status">
              Audio connecting…
            </span>
          ) : audio.originalSuppressed ? (
            /*
              The state calm-tide-33 lacked: the fr listener's controls governed
              originals the mode had silenced, moved freely, and did nothing.
              Controls that do nothing must say why.

              And it must not claim a translated voice that cannot exist. On a
              deployment with no translation engine this tile said "Hearing
              translated voice" over silence, which sends somebody looking for
              a fault in their own microphone.
            */
            <span className="participant-audio-pending" role="status">
              {props.translatedAudioUnavailable
                ? 'Translated audio unavailable on this server'
                : 'Hearing translated voice'}
            </span>
          ) : interpretationReduced(audio.modeGain) ? (
            /*
              W4 interpretation: the original is intentionally quiet underneath
              the translation. The controls stay LIVE — mute and volume govern
              that audible original — but the reduced level is the mode's
              doing, and the tile must say so or a working slider reads as a
              broken one.
            */
            <span className="participant-audio-pending" role="status">
              Original voice under translation
            </span>
          ) : null}
        </div>
      )}
    </article>
  );
}

/**
 * Who is talking right now, according to the captions themselves.
 *
 * An interim caption (§22.1) exists only while its utterance is still being
 * spoken, so the newest one identifies the live speaker without needing any
 * extra signalling. Once every caption is final nobody is mid-sentence, and the
 * indicator correctly goes quiet.
 */
function activeSpeakerId(captions: readonly CallCaptionEntry[]): string | null {
  for (let index = captions.length - 1; index >= 0; index -= 1) {
    const entry = captions[index];
    if (entry && !entry.isFinal) return entry.speakerParticipantId;
  }
  return null;
}

/** Strictly between silent and full: the interpretation "underneath" level. */
function interpretationReduced(modeGain: number | undefined): boolean {
  return modeGain !== undefined && modeGain > 0 && modeGain < 1;
}

function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

function statusDotClass(phase: CallConnectionPhase): string {
  if (phase === 'connected') return 'status-dot is-connected';
  if (phase === 'reconnecting' || phase === 'restoring') return 'status-dot is-recovering';
  return 'status-dot';
}

function statusText(phase: CallConnectionPhase, note: string | null): string {
  if (note) return note;
  switch (phase) {
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Connection interrupted — reconnecting…';
    case 'restoring':
      return 'Restoring your call…';
    default:
      return 'Connecting…';
  }
}

/**
 * One line that names the broken link when a call is silent.
 *
 * Rendered ONLY when something is actually wrong: a dead voice leg, or a bound
 * remote speaker whose element never reached `playing`. A healthy call shows
 * nothing -- this is a debugging surface, not decoration. The wording names the
 * link, because "no audio" without a link name costs a day of guessing.
 */
function voiceDiagnostic(props: CallScreenProps): JSX.Element | null {
  const legs = props.voiceLegs;
  if (!legs) return null;
  const dead = (state: RTCPeerConnectionState): boolean =>
    state === 'failed' || state === 'disconnected' || state === 'closed';
  const boundSpeakers = props.remoteSpeakers?.length ?? 0;
  const audibleExpected = (props.remoteSpeakers ?? []).some(
    (speaker) => !speaker.muted && !speaker.originalSuppressed && speaker.volume > 0,
  );
  const unheard = audibleExpected && props.remoteVoiceHeard === false && !props.playbackBlocked;
  if (!dead(legs.publish) && !dead(legs.receive) && !unheard) return null;
  const parts: string[] = [];
  if (dead(legs.publish)) parts.push(`your voice link is ${legs.publish}`);
  if (dead(legs.receive)) parts.push(`their voice link is ${legs.receive}`);
  if (unheard) parts.push(`${boundSpeakers} voice${boundSpeakers === 1 ? '' : 's'} connected but not playing`);
  return (
    <span className="voice-diagnostic" role="status">
      {parts.join(' · ')}
    </span>
  );
}

/**
 * The person's face where their video is not: their profile picture when the
 * seat is a signed-in account, their initials when it is not.
 *
 * The avatar route requires a session and an <img src> carries no headers,
 * so the image is fetched with the viewer's own token into an object URL --
 * the same pattern the dashboard uses. A viewer without a session (or a
 * seat without an account) keeps the initials, honestly.
 */
function ParticipantFace({
  participant,
}: {
  readonly participant: { readonly displayName: string; readonly accountId?: string };
}): JSX.Element {
  const [pictureUrl, setPictureUrl] = useState<string | null>(null);
  const accountId = participant.accountId;
  useEffect(() => {
    if (!accountId) return;
    const token = readAccountSession(defaultSessionStorage())?.token;
    if (!token) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void fetch(`${readAccountUrl()}/avatars/${accountId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
      .then(async (response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (blob === null || cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPictureUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [accountId]);
  return (
    <span className="participant-avatar" aria-hidden="true">
      {pictureUrl !== null ? (
        <img className="participant-avatar-image" src={pictureUrl} alt="" />
      ) : (
        initials(participant.displayName)
      )}
    </span>
  );
}
