/** @author masterzee001 */
/**
 * Translated speech, on a phone: the rules, and the one object that wires them.
 *
 * THE DEFECT THIS CLOSES, measured in production on 19 Sep 2026. A 60-second
 * two-phone call ended with `framesSent:5458 audioSecondsSent:55
 * translatedFramesIn:305 malformed:0 dropped:0`: speech captured, transcribed,
 * translated, spoken, and ~300 frames of translated audio emitted to the
 * recipient's private socket room as `call:translated-audio-frame`. The phone
 * subscribed to thirteen call events and that was not one of them. Both people
 * heard the original voice for the whole call, and every server signal said the
 * translation had been delivered.
 *
 * NOTHING ABOUT ORDERING IS DECIDED HERE. `createCallTranslatedAudioController`
 * in @videofy-live/call-client-core already owns supersession, out-of-order
 * refusal, duplicate refusal, the per-frame staleness guard and bind-once --
 * the same object call-web has wired since the web client learned to do this.
 * What was genuinely missing on this platform is a sink, because React Native
 * has no AudioContext. This file supplies the phone's answers to the questions
 * the controller asks, and nothing else.
 *
 * THE TWO POLICY QUESTIONS BELOW FAIL IN OPPOSITE DIRECTIONS, on purpose. The
 * asymmetry is the same one `callAudioMix` documents: playing a translation
 * nobody wanted is audible and recoverable, while silencing a real voice loses
 * a person, and refusing a translation the server already decided to send is
 * exactly the defect above.
 */
import {
  anyRemoteTranslationExpected,
  createCallTranslatedAudioController,
  resolveCallAudioMix,
  resolveSpeakerAudioMixes,
  type CallAudioMode,
  type CallFrameRefusal,
  type CallMode,
  type CallParticipantSummary,
  type CallStateSnapshot,
  type CallTranslatedAudioFrameEvent,
  type TranslatedAudioSocketLike,
} from '@videofy-live/call-client-core';
import { createNativeTranslatedSink, type NativeTranslatedSink } from './nativeTranslatedSink';
import { ensureBase64Decoder } from './pcmBase64';
import type { TranslatedPcmBackend } from '../native/translatedPcm';

/** Everything either policy question needs, and nothing that changes per frame. */
export interface TranslatedAudioPolicyInput {
  readonly participants: readonly CallParticipantSummary[];
  readonly selfParticipantId: string;
  /** The language THIS phone asked to hear. */
  readonly hearLanguage: string;
  /** The call-global mode as the SERVER states it, or null before it has. */
  readonly callMode: CallMode | null;
}

/** A seat that exists but has not been taken has no voice and speaks nothing. */
function joinedRemotes(
  input: TranslatedAudioPolicyInput,
): readonly CallParticipantSummary[] {
  return input.participants.filter(
    (participant) => participant.joined && participant.participantId !== input.selfParticipantId,
  );
}

/**
 * MAY TRANSLATED SPEECH BE HEARD? Fails OPEN on an unknown mode.
 *
 * Only an explicit `normal` -- the mode that turns the translation engine off
 * for the whole call -- silences this. An unset mode means the phone has not
 * been told yet, and a frame is itself evidence that the server decided this
 * listener should hear one: `translatedAudioRecipients` on the gateway is the
 * single eligibility authority and it had already run. A client guard that
 * refuses on missing state reproduces the 19 Sep defect exactly, with the
 * refusal counted somewhere nobody looks.
 *
 * Mobile has no Audio Mode control, so there is no interpretation mode here and
 * no third verdict to resolve -- a translated call replaces the original voice,
 * which is what `handleOriginalVoice` below acts on.
 */
export function translatedSpeechAudible(input: TranslatedAudioPolicyInput): boolean {
  const audioMode: CallAudioMode = input.callMode === 'normal' ? 'original' : 'translated';
  return resolveCallAudioMix({
    audioMode,
    // No sliders on this platform. Loudness on a phone is a ROUTING question
    // -- earpiece or loudspeaker -- and src/call/audioRoute.ts already owns it
    // on the stated ground that artificial gain is the wrong instrument.
    originalVolume: 1,
    translatedVolume: 1,
    remoteTranslationExpected: anyRemoteTranslationExpected(
      joinedRemotes(input),
      input.selfParticipantId,
      input.hearLanguage,
    ),
  }).playGenerated;
}

/**
 * SHOULD THE ORIGINAL VOICES BE SILENCED? Fails CLOSED on anything unclear.
 *
 * In a translated call the speaker's original must not fight their translation:
 * `resolveSpeakerAudioMix` puts a cross-language original at gain 0 in
 * translated mode, and the web client applies exactly that per speaker through
 * `setModeGain`.
 *
 * THIS IS ALL-OR-NOTHING ON A PHONE, and the reason is honest rather than
 * convenient: the web client can attribute a remote audio track to a speaker
 * because it binds transceiver mids to participants; this app does not bind
 * slots at all, so it knows it is holding somebody's voice without knowing
 * whose. Silencing the wrong person is not recoverable by the listener -- they
 * simply lose them -- so originals are silenced only when EVERY joined remote
 * is one whose original the mode would suppress anyway. A mixed conference
 * therefore keeps every original audible and the translation plays over it,
 * which is untidy and reversible. Mobile conferences do not translate yet
 * (founder ruling, 29 Aug 2026), so in practice this is the two-party direct
 * call it was written for.
 */
export function remoteOriginalsSuppressed(input: TranslatedAudioPolicyInput): boolean {
  if (input.callMode !== 'translated') return false;
  const remotes = joinedRemotes(input);
  if (remotes.length === 0) return false;
  const decisions = resolveSpeakerAudioMixes(
    remotes,
    input.selfParticipantId,
    input.hearLanguage,
    'translated',
  );
  if (decisions.size === 0) return false;
  for (const decision of decisions.values()) {
    if (decision.originalGain !== 0) return false;
  }
  return true;
}

export interface MobileTranslatedAudioDeps {
  readonly socket: TranslatedAudioSocketLike;
  readonly backend: TranslatedPcmBackend;
  readonly callId: () => string | null;
  readonly participantId: () => string | null;
  readonly callState: () => CallStateSnapshot | null;
  /**
   * The call-global mode. Read separately from the snapshot because a DIRECT
   * call carries it on `call:direct:state`, which is a different wire from
   * `call:state` and is the only place a personal call's mode is stated.
   */
  readonly callMode: () => CallMode | null;
  readonly hearLanguage: () => string;
  /** Diagnostics only. Never audio, never text. */
  readonly onRefused?: (reason: CallFrameRefusal, frame: CallTranslatedAudioFrameEvent) => void;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export interface MobileTranslatedAudio {
  attach(): void;
  detach(): void;
  reset(reason: string): void;
  readonly attached: boolean;
  /** The sink, for diagnostics: `playedMs` is what this phone actually emitted. */
  readonly sink: NativeTranslatedSink;
}

export function createMobileTranslatedAudio(
  deps: MobileTranslatedAudioDeps,
): MobileTranslatedAudio {
  // Before the first frame reaches the shared decoder, never after. See
  // pcmBase64.ts: without this a runtime with no `atob` drops every frame as
  // malformed and the failure reads as a synthesis fault.
  const decoder = ensureBase64Decoder();
  if (decoder === 'installed') deps.log?.('translated audio installed a base64 decoder');

  const sink = createNativeTranslatedSink(deps.backend);

  const policy = (): TranslatedAudioPolicyInput => ({
    participants: deps.callState()?.participants ?? [],
    selfParticipantId: deps.participantId() ?? '',
    hearLanguage: deps.hearLanguage(),
    callMode: deps.callMode(),
  });

  const controller = createCallTranslatedAudioController({
    socket: deps.socket,
    createSink: () => sink,
    currentCallId: deps.callId,
    currentParticipantId: deps.participantId,
    callState: deps.callState,
    translatedAudible: () => translatedSpeechAudible(policy()),
    translatedVolume: () => 1,
    /**
     * TRUE, WITHOUT A FLAG, and that is a decision rather than an oversight.
     *
     * `resolveTranslatedAudioAuthority` exists to stop a progressive frame and
     * a finished-file clip speaking the same sentence twice. This app has no
     * clip queue -- there is no `callAudioQueue` anywhere in apps/mobile -- so
     * there is no second path to arbitrate against. A build-time flag here
     * would add exactly one failure mode and no protection: an unset
     * EXPO_PUBLIC_* variable is blank, blank is false, and the whole feature
     * would be off on every build while every other signal read healthy.
     */
    realtimeConfigured: () => true,
    ...(deps.onRefused === undefined ? {} : { onRefused: deps.onRefused }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });

  return {
    attach(): void {
      controller.attach();
    },
    detach(): void {
      controller.detach();
      // The controller releases the SUBSCRIPTION; the AudioTrack is this
      // platform's equivalent of the AudioContext call-web closes with the
      // call, and nothing else would ever close it.
      sink.dispose();
    },
    reset(reason: string): void {
      controller.reset(reason);
    },
    get attached(): boolean {
      return controller.attached;
    },
    get sink(): NativeTranslatedSink {
      return sink;
    },
  };
}
