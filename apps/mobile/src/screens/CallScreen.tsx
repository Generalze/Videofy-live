/** @author masterzee001 */
/**
 * A call, on screen.
 *
 * A DIRECT CALL IS A TELEPHONE SCREEN. From the tap it says "Calling…" --
 * never "Joining": joining is how the app reaches the gateway, not what the
 * person is doing. Every word after that comes from the server-owned
 * telephone state (call:direct:state, and the join ack that carries it), and
 * once two-way audio is proven the words give way to a TIMER whose origin is
 * the server's `connectedAtMs` -- it keeps counting through a reconnect and
 * both phones agree on it.
 *
 * THE RED BUTTON ENDS THE CALL FOR BOTH. `call:end`, acknowledged, and the
 * other phone reads "Call ended" at once. It never reads "guest left": a
 * direct call has no guests.
 *
 * NO ARTIFICIAL GAIN. Loudness is a routing choice: earpiece by default for an
 * audio-only call, loudspeaker when the camera comes on, and a Speaker
 * control for the person to decide.
 *
 * DIAGNOSTICS ARE A DEVELOPER SWITCH. The voice-leg line, ICE warnings and
 * peer-state words were useful while the audio path was being proven and
 * are noise on a product screen. `EXPO_PUBLIC_CALL_DIAGNOSTICS=1` brings
 * them back; nothing else does.
 *
 * THE CAMERA IS RELEASED ON EVERY EXIT PATH. Leaving, unmounting,
 * backgrounding -- all of them stop the tracks. An un-stopped camera keeps
 * the privacy indicator lit after the call, which to the person holding the
 * phone is an app watching them.
 *
 * THREE TREATMENTS OF ONE DIRECT CALL (founder's board, 20 Sep 2026), and the
 * phase that picks between them comes from `directCallPhase` -- the SAME
 * condition the timer row already used, not a second opinion about whether a
 * call is up.
 *
 *   PLACING  the ring, and an arc that is a measurement: the share of the
 *            server's own ring window (`expiresAtMs`) that has gone. One red
 *            Cancel. The translation line under it is drawn from
 *            `translationReadiness`, never from a timer.
 *   LIVE     the speech indicator, the timer, the language pair, and the dual
 *            caption card. Each of those four is a projection of something the
 *            server said; none of them animates on its own.
 *   ENDED    the dimmed person, the duration in words, and a summary card.
 *
 * EVERY ONE OF THEM CAN BE ABSENT, and that is the design rather than a gap.
 * No language pair until `call:state` carries both halves; no caption card
 * until a caption arrives; no nested translation until that caption actually
 * has one; no arc without a deadline to measure against. This app spent a
 * night telling people "Hearing translated voice" while producing silence, and
 * the rule that came out of it is the one every absence above obeys: never
 * show a state you have not measured.
 */
import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { setAudioModeAsync } from 'expo-audio';
import { RTCView } from 'react-native-webrtc';
import type { CallCaptionEvent, DirectCallStateSnapshot } from '@videofy-live/call-client-core';
import { AvatarView } from '../media/AvatarView';
import { useBottomInset } from '../ui/insets';
import {
  AvatarHalo,
  C7Mark,
  CALL_COLORS,
  CallBackdrop,
  CallStatePill,
  CaptionCard,
  EndCallButton,
  Eyebrow,
  GlassDock,
  RoundControl,
  SpeechIndicator,
  SummaryCard,
} from '../ui/callTheme';
import { createAudioRouter, resolveRoute, type AudioRoute } from '../call/audioRoute';
import {
  callTickIntervalMs,
  callTickWanted,
  elapsedSinceMs,
  formatElapsed,
  monotonicRingProgress,
  observeRingWindow,
  observeServerClock,
  ringProgress,
  startCallTick,
} from '../call/callTimer';
import { TERMINAL_DIRECT_STATES } from '../call/directCallApi';
import {
  connectedRow,
  directCallPhase,
  stateLine,
  translatedAudioUnavailableLine,
} from '../call/callDisplay';
import { captionCard, captionSpeaking, nextCaption } from '../call/callCaption';
import { callScreenView, type DockControl } from '../call/callScreenModel';
import { type CallLanguagePair } from '../call/callLanguages';
import {
  applyCaptionEvidence,
  applyTranslatedAudioDiagnostic,
  NO_TRANSLATION_SIGNALS,
} from '../call/translationReadiness';
import { Icon } from '../ui/icons';
import { videofyCall } from '../native/videofyCall';
import { reportRingTimeline } from '../call/ringTimeline';
import {
  CallConnection,
  type CallTranslatedAudioDiagnostic,
  type CallTransportEvent,
  type RemoteStream,
} from '../call/callConnection';
import {
  admissionWords,
  knockWords,
  type AdmissionStatus,
  type ConferenceInfo,
  type KnockingSeat,
} from '../conference/admission';
import type { ConferenceSetup } from '../conference/conferenceSetup';

/** Not a secret; compiled into the bundle like every EXPO_PUBLIC_ value. */
const GATEWAY_URL = process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://staging.consummate7.com';

/** The developer switch. Off in every build a person installs. */
const DIAGNOSTICS = process.env['EXPO_PUBLIC_CALL_DIAGNOSTICS'] === '1';

/**
 * An optional local override, normally empty. ICE servers come from the
 * gateway at `/webrtc/ice`, because TURN credentials expire and cannot be
 * shipped in a bundle.
 */
function iceOverride(): { urls: string | string[]; username?: string; credential?: string }[] {
  const raw = process.env['EXPO_PUBLIC_ICE_SERVERS'];
  if (raw === undefined || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReturnType<typeof iceOverride>) : [];
  } catch {
    return [];
  }
}

/**
 * A DIRECT call is person-to-person: it carries the peer, its session id is
 * internal implementation data, and no code is ever shown. A CONFERENCE is
 * the only kind with a human-readable, shareable code. (Founder ruling
 * 2026-08-28.)
 */
export type ActiveCallDescriptor =
  | {
      readonly kind: 'direct';
      /** Internal session id. Never rendered. */
      readonly callId: string;
      readonly peer: { readonly accountId: string; readonly name: string };
    }
  | {
      readonly kind: 'conference';
      /** The shareable conference code. */
      readonly callId: string;
      /**
       * CONFERENCE SETUP (29 Aug): what the host chose on the Start card.
       * Present only when this phone is STARTING the conference; absent when
       * joining by code, where the conference itself is authoritative and
       * the gateway ignores it anyway. Also the title shown until the
       * gateway's call:state states it. Its targetLanguages is always []
       * from the handset (founder ruling 29 Aug 2026: "Translation is not
       * active on mobile conferences yet") and is never rendered here.
       */
      readonly setup?: ConferenceSetup | undefined;
    };

export interface CallScreenProps {
  readonly call: ActiveCallDescriptor;
  readonly displayName: string;
  readonly speakLanguage?: string;
  readonly hearLanguage?: string;
  /** Null is valid: it means this client can JOIN but not CREATE a call. */
  readonly sessionToken: string | null;
  /**
   * Direct calls only: ring the peer AFTER the join succeeds (the caller
   * joins first, becoming the host, and rings second). Absent when answering
   * and for conferences -- which is also how the screen knows its role.
   */
  readonly onRing?: ((callId: string) => Promise<number | null>) | undefined;
  readonly onLeave: () => void;
  /*
   * THE BOARD'S TWO BUTTONS ON THE ENDED SCREEN, and they are optional because
   * absent is a real answer: a screen given no way to place a call falls back
   * to the sentence that used to stand in for both of them. They are wired in
   * App.tsx to the same two entry points the contact list and the profile use
   * -- `callContact` and the chat -- rather than to anything invented here.
   */
  readonly onCallBack?: (() => void) | undefined;
  readonly onMessagePeer?: (() => void) | undefined;
}

export function CallScreen({
  call,
  displayName,
  speakLanguage,
  hearLanguage,
  sessionToken,
  onRing,
  onLeave,
  onCallBack,
  onMessagePeer,
}: CallScreenProps): JSX.Element {
  const callId = call.callId;
  const role: 'caller' | 'callee' = onRing === undefined ? 'callee' : 'caller';
  const connection = useRef<CallConnection | null>(null);
  const bottomInset = useBottomInset();

  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<Record<string, { url: string | null; state: string }>>({});
  const [error, setError] = useState<string | null>(null);
  /** OFF at every call start (founder ruling): the camera is not acquired. */
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [joining, setJoining] = useState(true);
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(false);
  const [legs, setLegs] = useState<{ publish: string; receive: string }>({
    publish: 'new',
    receive: 'new',
  });
  const [voice, setVoice] = useState<{ inboundPackets: number; iceState: string } | null>(null);
  const [iceCount, setIceCount] = useState<number | null>(null);
  const [transportLog, setTransportLog] = useState<readonly string[]>([]);
  const [roster, setRoster] = useState<
    readonly { participantId: string; displayName: string; accountId?: string }[]
  >([]);

  /*
   * RESTRICTED ADMISSION (29 Aug). Host side: who is waiting at the door,
   * answered one at a time. Joiner side: null until the join ack says
   * 'pending', then the gateway's answer. `info` is the conference as the
   * gateway states it -- the host's own setup only until then.
   */
  const [knocking, setKnocking] = useState<readonly KnockingSeat[]>([]);
  const [admission, setAdmission] = useState<AdmissionStatus | null>(null);
  const [answering, setAnswering] = useState(false);
  const [info, setInfo] = useState<ConferenceInfo>(() => ({
    title: call.kind === 'conference' ? (call.setup?.title ?? null) : null,
    privacy: call.kind === 'conference' ? (call.setup?.privacy ?? null) : null,
    targetLanguages: call.kind === 'conference' ? (call.setup?.targetLanguages ?? []) : [],
  }));

  /*
   * THE TELEPHONE. `serverState` is the server's word; `connectedAtMs` is the
   * server-stamped origin of the timer; `clockOffset` is measured once from
   * the first wire so the origin can be ticked on the phone's clock.
   */
  const [serverState, setServerState] = useState<string | null>(null);
  /*
   * The End button has been pressed and the request is in flight.
   *
   * Deliberately NOT a call state: the call is over when the server says so.
   * This only keeps the control responsive and un-pressable twice.
   */
  const [ending, setEnding] = useState(false);
  const [mode, setMode] = useState<'normal' | 'translated' | null>(null);
  const [connectedAtMs, setConnectedAtMs] = useState<number | null>(null);
  const clockOffset = useRef<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  /** Frozen at the moment the call ended, so the final duration stays on screen. */
  const [finalElapsedMs, setFinalElapsedMs] = useState<number | null>(null);

  /*
   * THE RING WINDOW. The server stamps a deadline on every `call:direct:state`
   * and ends the call itself when it passes, so the outgoing arc has something
   * real to be a share of. The denominator is the FIRST remaining figure this
   * screen saw -- see callTimer's `observeRingWindow` for why it is captured
   * once and not recomputed.
   */
  const [ringExpiresAtMs, setRingExpiresAtMs] = useState<number | null>(null);
  const ringWindowMs = useRef<number | null>(null);
  /** The furthest through the window the arc has been. It never goes back. */
  const ringSeen = useRef<number | null>(null);

  /*
   * THE UTTERANCE ON SCREEN, and when it last changed on THIS phone's clock.
   *
   * One state, not two: the change stamp is what the speech indicator measures
   * age against, and a stamp kept in a ref beside a piece of state is a stamp
   * that can be updated for a caption the merge refused.
   */
  const [caption, setCaption] = useState<{
    readonly event: CallCaptionEvent;
    readonly changedAtMs: number;
    /** THIS phone's own words, echoed back by the gateway. */
    readonly self: boolean;
  } | null>(null);
  /** The person's own choice to hide the caption card. Never hides a fault. */
  const [captionsShown, setCaptionsShown] = useState(true);
  /** The pair `call:state` records, or null while it cannot be measured. */
  const [languages, setLanguages] = useState<CallLanguagePair | null>(null);
  /** False once the GATEWAY said this deployment has no translation engine. */
  const [engineReal, setEngineReal] = useState<boolean | null>(null);
  /**
   * EVERYTHING THIS PHONE HAS MEASURED ABOUT TRANSLATED SPEECH: the playback
   * path, whether anything was actually played or captioned, and whether frames
   * arrived and were refused. Folded by `applyTranslatedAudioDiagnostic`, which
   * is where the rules about what outranks what can be read and tested -- the
   * screen used to keep one field here and silently drop `refused` and the
   * proofs on the floor.
   */
  const [signals, setSignals] = useState(NO_TRANSLATION_SIGNALS);

  /*
   * THE VIDEO PATH, STAMPED. "Video did not work" on a phone has four
   * different causes with four different fixes (no track event, a track
   * with no stream, a muted track that never unmutes, a peer that never
   * connects); the screen cannot show which and must not. So the moments
   * are stamped -- first remote stream, first null, peer states, camera
   * on -- and reported with the ring timeline. Times and counts only.
   */
  /*
   * The rebuilt peer's connection state, as a number.
   *
   * The timeline drops anything that is not a number before it is sent, so a
   * state posted as a string would vanish on the way to the server and the
   * verdict would arrive without the one field that explains it.
   */
  const PEER_STATE_CODE: Record<string, number> = {
    unknown: 0,
    new: 1,
    connecting: 2,
    connected: 3,
    disconnected: 4,
    failed: 5,
    closed: 6,
  };
  const videoStamps = useRef<Record<string, number>>({});
  const stamp = useCallback((point: string) => {
    if (videoStamps.current[point] === undefined) videoStamps.current[point] = Date.now();
    videoStamps.current[`${point}_n`] = (videoStamps.current[`${point}_n`] ?? 0) + 1;
  }, []);

  /** Audio routing: an explicit choice, or null for the camera-driven default. */
  const [chosenRoute, setChosenRoute] = useState<AudioRoute | null>(null);
  const router = useRef(
    createAudioRouter(
      (audioMode) => setAudioModeAsync(audioMode),
      (speaker) => videofyCall.setAudioRoute(callId, speaker),
    ),
  );

  const acceptDirectState = useCallback((wire: DirectCallStateSnapshot) => {
    clockOffset.current = observeServerClock(clockOffset.current, wire.updatedAtMs, Date.now());
    // T11: two-way audio proven by the server -- stamped on the device timeline.
    if (wire.state === 'connected') videofyCall.reportMediaConnected(wire.callId);
    setServerState(wire.state);
    setMode(wire.mode);
    if (wire.connectedAtMs !== null) setConnectedAtMs(wire.connectedAtMs);
    /*
     * The ring deadline, and the window it is measured against. `expiresAtMs`
     * of 0 is the normaliser's "the wire carried none" -- it becomes null here
     * rather than a deadline in 1970, which would draw a full arc on a call
     * that has only just started.
     */
    const expires = wire.expiresAtMs > 0 ? wire.expiresAtMs : null;
    ringWindowMs.current = observeRingWindow(
      ringWindowMs.current,
      expires,
      clockOffset.current,
      Date.now(),
    );
    setRingExpiresAtMs(expires);
  }, []);

  useEffect(() => {
    let live = true;
    const link = new CallConnection({
      gatewayUrl: GATEWAY_URL,
      callId,
      displayName,
      ...(call.kind === 'direct' ? { directPeerAccountId: call.peer.accountId } : {}),
      ...(call.kind === 'conference' && call.setup !== undefined ? { setup: call.setup } : {}),
      onKnocking: (seats) => {
        if (live) setKnocking(seats);
      },
      onAdmission: (status) => {
        if (live) setAdmission(status);
      },
      onConferenceInfo: (next) => {
        if (live) setInfo(next);
      },
      ...(speakLanguage === undefined ? {} : { speakLanguage }),
      ...(hearLanguage === undefined ? {} : { hearLanguage }),
      sessionToken,
      ...(iceOverride().length > 0 ? { iceServers: iceOverride() } : {}),
      onRemoteStream: (id, stream: RemoteStream) => {
        stamp(stream === null ? 'video_remote_null' : 'video_remote_stream');
        setRemotes((current) => ({
          ...current,
          [id]: { url: stream === null ? null : stream.toURL(), state: current[id]?.state ?? 'new' },
        }));
      },
      onPeerState: (id, state) => {
        stamp(`video_peer_${String(state).replace(/[^a-z]/g, '')}`);
        setRemotes((current) => ({
          ...current,
          [id]: { url: current[id]?.url ?? null, state },
        }));
      },
      onRoster: (list) => {
        if (!live) return;
        setRoster(list);
        // A tile belongs to a seat. When the seat is gone the tile goes with
        // it -- the old screen kept it and labelled it "left".
        const present = new Set(list.map((entry) => entry.participantId));
        setRemotes((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => present.has(id))),
        );
      },
      onLegState: (leg, state) => {
        if (live) setLegs((current) => ({ ...current, [leg]: state }));
      },
      onVoiceStats: (stats) => {
        if (live) setVoice(stats);
      },
      onDirectState: (wire) => {
        if (!live) return;
        /*
         * TWO STAMPS, ONE QUESTION.
         *
         * A phone that sat on Connected for a call that had ended could have
         * failed in either of two completely different places: the state
         * never arrived, or it arrived and the screen never repainted. The
         * gateway cannot tell them apart -- it emitted to the room either way
         * -- and on the handset that froze the socket had usually not even
         * dropped (founder review, 2 Sep). `received` is stamped here, on
         * arrival; `applied` is stamped from an effect, which only runs after
         * a render. A timeline with the first and not the second says the
         * news reached the phone and the picture did not follow.
         */
        if (TERMINAL_DIRECT_STATES.has(String((wire as { state?: unknown }).state ?? ''))) {
          stamp('terminal_received');
        }
        acceptDirectState(wire);
      },
      onEnded: () => {
        // ENDED reaches conferences too; for a direct call the telephone's
        // own 'ended' usually arrives first and this is a no-op.
        if (live) setServerState((current) => (current !== null && TERMINAL_DIRECT_STATES.has(current) ? current : 'ended'));
      },
      onTransport: (event: CallTransportEvent) => {
        if (!live) return;
        const line =
          event.kind === 'socket-lost'
            ? `socket lost (${event.reason})`
            : event.kind === 'resuming'
              ? `resuming seat (attempt ${event.attempt})`
              : event.kind === 'resumed'
                ? 'seat resumed, voice renegotiated'
                : `resume failed: ${event.error}`;
        setTransportLog((current) => [...current.slice(-4), `${new Date().toLocaleTimeString()} ${line}`]);
      },
      onIceServers: (count) => {
        if (live) setIceCount(count);
      },
      /*
       * TRANSLATED SPEECH, STAMPED. On 19 Sep 2026 a translated call was
       * indistinguishable, from this phone, from a call that was never
       * translated: the server said 305 frames delivered and the handset had
       * no signal of any kind. These stamps travel with the ring timeline, so
       * "the translation never arrived", "it arrived and was refused" and
       * "this build cannot play it" are three different answers instead of
       * one silence. Counts and stamps only; never audio, never text.
       */
      /*
       * ONE UTTERANCE, AS IT WAS SAID AND AS IT WAS TRANSLATED.
       *
       * The merge decides; this only records WHEN it accepted something, which
       * is what the speech indicator measures age against. A refused caption --
       * a straggler from a superseded media revision, a partial after its own
       * final -- leaves the state object identical, so a stuck stream cannot
       * keep the indicator alive by re-sending.
       */
      onCaption: (event: CallCaptionEvent, origin) => {
        if (!live) return;
        stamp('caption_received');
        /*
         * A CAPTION CARRYING A TRANSLATION IS PROOF. The engine ran, its output
         * was addressed to this seat, and it arrived -- which is more than
         * "Listening for translated speech" ever meant. Counted whether or not
         * the merge puts this particular revision on screen.
         */
        setSignals((current) => applyCaptionEvidence(current, event, Date.now()));
        setCaption((current) => {
          const accepted = nextCaption(current?.event ?? null, event);
          if (accepted === null) return current;
          if (current !== null && accepted === current.event) return current;
          return { event: accepted, changedAtMs: Date.now(), self: origin.self };
        });
      },
      onLanguages: (pair) => {
        if (live) setLanguages(pair);
      },
      /*
       * THE SERVER SAYING IT CANNOT TRANSLATE. Kept apart from the handset's
       * own translated-audio diagnostic: "this build has no native track" and
       * "this deployment has no engine" look identical on screen and send an
       * investigation to two different places.
       */
      onTranslationEngine: () => {
        if (!live) return;
        stamp('xlate_engine_unavailable');
        setEngineReal(false);
      },
      onTranslatedAudio: (event: CallTranslatedAudioDiagnostic) => {
        if (!live) return;
        stamp(`xlate_${event.kind}`);
        /*
         * EVERY KIND REACHES THE DECISION, and for one commit only two did.
         * `listening` means a socket handler is bound and was showing
         * "Listening for translated speech" for whole calls in which nothing
         * arrived, while `refused` -- frames arriving and being turned away,
         * the 19 Sep post-mortem's worst state -- and `played`, the only
         * audible proof there is, were dropped here.
         */
        /*
         * STAMPED, NOT LATCHED. "Playing translated speech" is present tense
         * and the stamp is what keeps it honest: one frame at second three
         * used to hold that sentence -- and the ended screen's "· translated"
         * -- for the rest of a call in which every later frame was refused.
         */
        setSignals((current) => applyTranslatedAudioDiagnostic(current, event, Date.now()));
        if (event.kind === 'originals') {
          videoStamps.current['xlate_originals_suppressed'] = event.suppressed ? 1 : 0;
        }
        if (event.kind === 'unavailable') {
          // The reason, not just the fact. A build that cannot play translated
          // audio and a native track that threw read identically otherwise,
          // and only one of them is fixed by building again.
          videoStamps.current['xlate_unavailable_threw'] = event.error === undefined ? 0 : 1;
          setTransportLog((current) => [
            ...current.slice(-4),
            `${new Date().toLocaleTimeString()} ${translatedAudioUnavailableLine(event.error)}`,
          ]);
        }
      },
      onVideoDiagnostic: (event) => {
        if (!live) return;
        stamp(`video_${event.kind.replace(/-/g, '_')}`);
        if (event.kind === 'outbound' || event.kind === 'inbound') {
          videoStamps.current[`video_${event.kind}_frames`] = event.frames;
          videoStamps.current[`video_${event.kind}_bytes`] = event.bytes;
        }
        /*
         * THE HOLD, AS A NUMBER. `stamp` records a first-seen time and an
         * `_n` count per point and drops everything else, so the stated
         * device proof -- `video_remote_idle (heldMs 2000)` -- named a figure
         * the timeline did not carry, and a human checking a handset would
         * have been looking for something that could not appear. It appears
         * now, under its own key, the way the rebuild verdict's numbers do.
         */
        if (event.kind === 'remote-idle') {
          videoStamps.current['video_remote_held_ms'] = event.heldMs;
        }
        /*
         * The verdict is the whole point of the rebuild watch, so it travels
         * with its numbers. A bare timestamp would say the rebuild finished
         * and still not say whether video ever moved.
         */
        if (event.kind === 'rebuild-verdict') {
          videoStamps.current['video_rebuild_recovered'] = event.recovered ? 1 : 0;
          videoStamps.current['video_rebuild_frames'] = event.frames;
          videoStamps.current['video_rebuild_state'] = PEER_STATE_CODE[event.connectionState] ?? 0;
        }
        if (event.kind === 'outbound-silent' || event.kind === 'attach-failed' || event.kind === 'acquisition-failed') {
          setTransportLog((current) => [...current.slice(-4), `${new Date().toLocaleTimeString()} video ${event.kind}`]);
        }
        /*
         * The negotiation stages, on screen. Offer-sent is the one that
         * matters: with it, a silent camera is a media fault; without it,
         * nothing was ever asked of the far side and the gateway's own drop
         * counter will read zero for the honest reason that it was handed
         * nothing to drop.
         */
        if (event.kind === 'signalling') {
          setTransportLog((current) => [...current.slice(-4), `${new Date().toLocaleTimeString()} sig ${event.stage}`]);
        }
      },
      onError: (message) => {
        if (live) setError(message);
      },
    });
    connection.current = link;

    // The caller's call is Telecom's too (phase 2): audio focus and routing owned by the OS.
    if (call.kind === 'direct' && onRing !== undefined) videofyCall.reportOutgoingCall(callId, call.peer.name);

    void (async () => {
      try {
        await link.openLocalMedia();
        if (!live) return;
        const ack = await link.join();
        if (!live) return;
        if (ack.ok) setJoined(true);
        if (ack.ok && onRing !== undefined) {
          const reached = await onRing(callId);
          // Zero devices is UNAVAILABLE now, not after thirty seconds of "Calling…".
          link.reportRingResult(reached ?? -1);
        }
        if (!ack.ok) {
          setError(
            ack.code === 'host-not-authorized'
              ? 'Verify your email before starting a call. You can still join a call somebody invites you to.'
              : (ack.error ?? 'The call service refused this call.'),
          );
        }
      } catch (thrown) {
        if (live) {
          setError(
            thrown instanceof Error && /permission|denied/iu.test(thrown.message)
              ? 'Microphone access is needed for a call.'
              : 'Could not start the call.',
          );
        }
      } finally {
        if (live) setJoining(false);
      }
    })();

    /*
     * REFS COPIED FOR THE CLEANUP.
     *
     * A ref read inside a cleanup function is read at TEARDOWN, not at the
     * time the effect ran, so it may point at something belonging to a call
     * this cleanup is not for. Captured here, they belong to this call.
     */
    const routerAtStart = router.current;
    const stampsAtStart = videoStamps;
    return () => {
      live = false;
      link.leave();
      connection.current = null;
      void routerAtStart.release();
      // The device's T4..T11 stamps go to the gateway once, metadata only,
      // so the ring's seconds can be attributed (founder targets: <3 s ring,
      // <2 s answer-to-audio).
      if (call.kind === 'direct') {
        void reportRingTimeline(
          GATEWAY_URL,
          sessionToken,
          callId,
          { ...videofyCall.timeline(callId), ...stampsAtStart.current },
          role,
        );
      }
    };
    // The connection is built once per call; the callbacks read state through setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, displayName, sessionToken]);

  // The timer ticks while there is an origin and the call has not ended.
  const terminal = serverState !== null && TERMINAL_DIRECT_STATES.has(serverState);
  /*
   * The state the SERVER says the call is in right now, or null before the
   * first wire arrives. Every sentence on this screen comes from here; nothing
   * derives a status from the timer, the roster, the socket or the tiles.
   */
  // The peer's name only exists on a direct call; a conference has a roster.
  const peerName = call.kind === 'direct' ? call.peer.name : '';
  const connectedRowState = connectedRow(serverState, connectedAtMs, peerName);
  /*
   * The other half of the pair stamped on arrival. An effect runs only after
   * React has rendered, so reaching here is evidence the screen actually
   * repainted on the terminal state rather than merely being told about it.
   */
  useEffect(() => {
    if (serverState !== null && TERMINAL_DIRECT_STATES.has(serverState)) stamp('terminal_applied');
  }, [serverState, stamp]);
  /*
   * ONE TICK, TWO THINGS TO ADVANCE. It used to run only once there was an
   * origin to count from, which is right for the timer and leaves the outgoing
   * ring arc frozen for the whole of the ring -- the phase it exists for. It
   * now also runs while there is a deadline, and faster then: a second-by-second
   * arc steps, and a stepping arc reads as a rendering fault rather than a
   * measurement.
   */
  const tickIntervalMs = callTickIntervalMs(connectedAtMs);
  const ticking = callTickWanted({ terminal, connectedAtMs, ringExpiresAtMs });
  useEffect(
    () => startCallTick({ ticking, intervalMs: tickIntervalMs, onTick: setNowMs }),
    [ticking, tickIntervalMs],
  );

  // Freeze the duration at the moment the call ends.
  useEffect(() => {
    if (terminal && connectedAtMs !== null && finalElapsedMs === null) {
      setFinalElapsedMs(elapsedSinceMs(connectedAtMs, clockOffset.current, Date.now()));
    }
  }, [terminal, connectedAtMs, finalElapsedMs]);

  /*
   * A SCREEN WITH BUTTONS DOES NOT DELETE ITSELF, and `terminalNow` is how the
   * End press below finds out whether the telephone answered it. The terminal
   * auto-leave that used to live here is now the model's `autoDismissMs`, read
   * where the view is built.
   */
  const terminalNow = useRef(terminal);
  useEffect(() => {
    terminalNow.current = terminal;
  }, [terminal]);

  // A refused knock ends the screen the same way: the words, then out.
  const refused = admission !== null && admission !== 'pending' && admission !== 'admitted';
  useEffect(() => {
    if (!refused) return undefined;
    const timer = setTimeout(() => onLeave(), 2500);
    return () => clearTimeout(timer);
  }, [refused, onLeave]);

  /** The host's answer to the first knock; the list moves on when the gateway agrees. */
  const answerKnock = useCallback((participantId: string, admit: boolean) => {
    setAnswering(true);
    const link = connection.current;
    void (link?.admit(participantId, admit) ?? Promise.resolve({ ok: false as const, error: 'not-in-call' })).then(
      (result) => {
        setAnswering(false);
        if (!result.ok) setError(admit ? 'Could not let them in. Try again.' : 'Could not answer. Try again.');
      },
    );
  }, []);

  // Audio route follows the camera unless the person chose.
  useEffect(() => {
    void router.current.apply(resolveRoute(cameraOn, chosenRoute));
  }, [cameraOn, chosenRoute]);

  const toggleCamera = useCallback(() => {
    const next = !cameraOn;
    stamp(next ? 'video_camera_on' : 'video_camera_off');
    if (next) setCameraStarting(true);
    void connection.current?.setCameraEnabled(next).then((stream) => {
      setCameraStarting(false);
      if (next && stream === null) {
        setError('Camera access is needed to turn the camera on. The call continues on audio.');
        return;
      }
      if (next && stream !== null) stamp('video_local_stream');
      setLocalUrl(stream === null ? null : stream.toURL());
      setCameraOn(next);
    });
  }, [cameraOn, stamp]);

  const toggleMute = useCallback(() => {
    setMuted((wasMuted) => {
      connection.current?.setMicrophoneEnabled(wasMuted);
      return !wasMuted;
    });
  }, []);

  const speakerOn = resolveRoute(cameraOn, chosenRoute) === 'speaker';
  const toggleSpeaker = useCallback(() => {
    setChosenRoute(speakerOn ? 'earpiece' : 'speaker');
  }, [speakerOn]);

  /** Direct: end for both, acknowledged. Conference: leave my seat. */
  const hangUp = useCallback(() => {
    if (call.kind !== 'direct') {
      onLeave();
      return;
    }
    if (terminal) {
      onLeave();
      return;
    }
    /*
     * THE SERVER ENDS THE CALL; THIS ONLY ASKS.
     *
     * This used to set 'ended' locally before `end()` resolved, so the screen
     * could claim a call was over while the server still had it open -- the
     * caller's own device disagreeing with the callee's. `ending` keeps the
     * button responsive and disabled without asserting anything untrue.
     *
     * THE SCREEN LEAVES ONLY IF THE TELEPHONE NEVER ANSWERED. A person who
     * pressed End must not be held on a call screen because an acknowledgement
     * was lost -- so the timer stays -- but when the server's own terminal
     * state HAS arrived the ended screen is a real screen with real buttons on
     * it, and it used to be destroyed 600 ms after the press, taking Call back,
     * Message and the summary with it.
     */
    const link = connection.current;
    setEnding(true);
    void (link?.end() ?? Promise.resolve(false)).finally(() => {
      setTimeout(() => {
        if (!terminalNow.current) onLeave();
      }, 600);
    });
  }, [call.kind, onLeave, terminal]);

  const tiles = Object.entries(remotes);
  const peerVideo = tiles.find(([, tile]) => tile.url !== null)?.[1].url ?? null;
  const elapsedMs =
    finalElapsedMs ??
    (connectedAtMs === null ? null : elapsedSinceMs(connectedAtMs, clockOffset.current, nowMs));
  const knock = knockWords(knocking);
  const firstKnock = knocking[0];

  /*
   * THE BOARD'S THREE TREATMENTS, and everything each of them may draw.
   *
   * Each value below is null whenever the thing it describes has not been
   * measured, and every use of it is guarded. That is what keeps this screen
   * from doing again what it did in September: saying a state out loud that
   * nothing had established.
   */
  const phase = directCallPhase({
    serverState,
    elapsedMs,
    connectedRowShown: connectedRowState.show,
  });
  /*
   * THE ARC NEVER GROWS. The denominator is frozen at the first window seen, so
   * the Answer grace period -- which pushes `expiresAtMs` forward mid-ring --
   * computed a smaller elapsed share and snapped the arc from a fifth back to
   * full in one frame, where it then sat motionless for six seconds. That reads
   * as a ring that restarted. The high-water mark is kept here, beside the
   * other two figures captured once per call, and the rule itself is
   * `monotonicRingProgress` where it can be tested.
   */
  const arc = monotonicRingProgress(
    ringSeen.current,
    ringProgress({
      expiresAtMs: ringExpiresAtMs,
      windowMs: ringWindowMs.current,
      offsetMs: clockOffset.current,
      localNowMs: nowMs,
    }),
  );
  if (arc !== null) ringSeen.current = arc;
  /*
   * EVERY DECISION THIS SCREEN MAKES, MADE SOMEWHERE IT CAN BE PROVEN.
   *
   * Ten mutants applied to the wiring below -- the nested translation card fed
   * the original sentence, the translation line un-gated onto every call,
   * the caption seam cut at this end -- survived a green 440-test suite,
   * because nothing in the repository could see a prop. `callScreenView` is
   * ordinary TypeScript and the JSX beneath is a render of what it returns.
   */
  const view = callScreenView({
    kind: call.kind,
    phase,
    serverState,
    role,
    peerName,
    translation: { mode, engine: engineReal, ...signals },
    languages,
    connectedRow: connectedRowState,
    caption: captionCard(caption?.event ?? null),
    captionIsSelf: caption?.self ?? false,
    speaking: captionSpeaking({
      caption: caption?.event ?? null,
      changedAtMs: caption?.changedAtMs ?? null,
      nowMs,
    }),
    captionsShown,
    elapsedMs,
    ringElapsed: arc,
    nowMs,
    muted,
    speakerOn,
    cameraOn,
    cameraStarting,
    canCallBack: onCallBack !== undefined,
    canMessage: onMessagePeer !== undefined,
  });

  /*
   * THE ONLY AUTOMATIC EXIT LEFT, and the model decides whether there is one.
   * A terminal state used to unmount this screen 2500 ms later whatever was on
   * it, which was harmless when the only control was Close: the board's Call
   * back and Message buttons then appeared and vanished before a hand could
   * reach them, and the summary card could not be read. Where there is
   * something to press or read, the person dismisses the screen.
   */
  const autoDismissMs = view.autoDismissMs;
  useEffect(() => {
    if (autoDismissMs === null) return undefined;
    const timer = setTimeout(() => onLeave(), autoDismissMs);
    return () => clearTimeout(timer);
  }, [autoDismissMs, onLeave]);

  /** The dock's glyph and its action, by the id the model named. */
  const dockIcon = (control: DockControl): ReactNode => {
    const tint = control.active ? CALL_COLORS.ground : CALL_COLORS.text;
    if (control.id === 'mute') return <Icon name={muted ? 'mic-off' : 'mic'} size={26} color={tint} />;
    if (control.id === 'speaker') return <Icon name="speaker" size={26} color={tint} />;
    if (control.id === 'camera') {
      return <Icon name={cameraOn ? 'camera' : 'camera-off'} size={26} color={tint} />;
    }
    /*
     * A CAPTIONS GLYPH, NOT THE TRANSLATE ONE. This control hides and shows the
     * caption card; it cannot turn translation off -- that is `call:mode:set`,
     * which the gateway grants to the call owner alone and this client has
     * never sent. A teal translate glyph that went dark when pressed told
     * people they had stopped the translation, on a product whose named defect
     * class is claiming a translation state nothing measured.
     */
    return <Icon name="captions" size={24} color={tint} />;
  };
  /** The readiness sentence, but only when it is a FAULT. Both stages draw it. */
  const warnLine =
    view.readinessLine !== null && view.readinessLine.warn ? view.readinessLine.words : null;
  const dockPress = (control: DockControl): void => {
    if (control.id === 'mute') toggleMute();
    else if (control.id === 'speaker') toggleSpeaker();
    else if (control.id === 'camera') toggleCamera();
    else setCaptionsShown((shown) => !shown);
  };

  return (
    <View style={styles.screen}>
      <CallBackdrop />

      <View style={styles.top}>
        <C7Mark caption={call.kind === 'direct' ? 'Direct call' : 'Conference'} />
        {call.kind === 'conference' && info.title !== null && (
          <Text style={styles.confTitle} numberOfLines={1}>
            {info.title}
          </Text>
        )}
      </View>

      {/* ===== HOST: somebody is at the door of a restricted conference. ===== */}
      {call.kind === 'conference' && knock !== null && firstKnock !== undefined && (
        <View style={styles.knockBanner}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.knockHeadline} numberOfLines={1}>
              {knock.headline}
            </Text>
            {knock.others !== null && <Text style={styles.knockOthers}>{knock.others}</Text>}
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={answering}
            onPress={() => answerKnock(firstKnock.participantId, false)}
            style={({ pressed }) => [styles.knockRefuse, (pressed || answering) && styles.knockPressed]}
          >
            <Text style={styles.knockRefuseLabel}>Refuse</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={answering}
            onPress={() => answerKnock(firstKnock.participantId, true)}
            style={({ pressed }) => [styles.knockAdmit, (pressed || answering) && styles.knockPressed]}
          >
            <Text style={styles.knockAdmitLabel}>Admit</Text>
          </Pressable>
        </View>
      )}

      {/* ===== DIRECT CALL: the person, the state, the timer. ===== */}
      {call.kind === 'direct' && (
        <View style={styles.stage}>
          {peerVideo !== null ? (
            <View style={styles.peerVideoWrap}>
              <RTCView streamURL={peerVideo} style={styles.peerVideo} objectFit="cover" />
              <View style={styles.peerVideoBanner}>
                <AvatarView accountId={call.peer.accountId} name={call.peer.name} size={28} />
                <Text style={styles.peerVideoName} numberOfLines={1}>
                  {call.peer.name}
                </Text>
                <Text style={styles.peerVideoTimer}>
                  {elapsedMs !== null ? formatElapsed(elapsedMs) : stateLine(serverState, role, call.peer.name)}
                </Text>
              </View>
              {/*
                * THE HONEST-STATE SURFACE DOES NOT VANISH WHEN A CAMERA COMES
                * ON. This branch rendered nothing from the view model at all,
                * so every measured-state fix in three rounds was silently
                * bounded to audio-only calls -- on a product whose pitch is
                * translated VIDEO calling. A translation FAULT and the ended
                * verdict are the two that cannot wait for the full-screen
                * video wave: one is the September defect's only dissenting
                * voice, the other is the call's verdict on itself. The caption
                * card and the summary belong with that wave and are not drawn
                * here rather than being half-drawn here.
                */}
              {(warnLine !== null || view.endedLine !== null) && (
                <View style={styles.peerVideoState}>
                  {view.endedLine !== null && (
                    <Text style={styles.peerVideoEnded}>{view.endedLine}</Text>
                  )}
                  {warnLine !== null && (
                    <Text style={styles.peerVideoWarn}>{warnLine}</Text>
                  )}
                </View>
              )}
            </View>
          ) : (
            /*
             * THE CAPTION CARD HAS ITS OWN SPACE, DIRECTLY ABOVE THE DOCK.
             *
             * It used to sit at the bottom of one long scrolling column, and a
             * reviewer computed the consequence from the styles as written: on a
             * 360x800 phone the stage is 462dp and the column above the card is
             * 479dp, so at rest not one pixel of the card was on screen. The
             * ScrollView had turned "clipped" into "invisible unless you scroll
             * a live call by hand" -- for the one element that shows this
             * product's billable unit working.
             *
             * So the column SCROLLS and the card DOES NOT: the identity block
             * takes what is left (and compresses -- see `compactIdentity`),
             * while the card keeps a bounded slot of its own with its own
             * internal scroll for a long utterance. The dock did not grow to
             * pay for this; it shrank to one row, which is where the space
             * came from.
             */
            <>
            <ScrollView
              style={styles.stageScroll}
              contentContainerStyle={styles.stageScrollContent}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.identity}>
                {view.eyebrow !== null && <Eyebrow>{view.eyebrow}</Eyebrow>}
                {/*
                  * THE SPEECH INDICATOR, above the name, on a live call only.
                  * It is a measurement of the caption stream -- see
                  * callCaption's `captionSpeaking` -- and it moves only for the
                  * OTHER person: the gateway delivers a speaker their own words
                  * too, and these bars sit above the peer's face.
                  */}
                {view.speech !== null && (
                  <SpeechIndicator
                    active={view.speech.active}
                    accessibilityLabel={view.speech.accessibilityLabel}
                  />
                )}
                <AvatarHalo
                  accountId={call.peer.accountId}
                  name={call.peer.name}
                  // The avatar is the first thing to yield to the caption card.
                  size={view.compactIdentity ? 92 : 124}
                  pulsing={view.halo.pulsing}
                  ring={view.halo.ring}
                  remaining={view.halo.remaining}
                  remainingLabel={view.halo.remainingLabel}
                  dim={view.halo.dim}
                />
                {/* One line. A long name at 34pt wrapped to three and pushed the
                    caption card off the bottom of a column already over budget. */}
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                  style={[
                    styles.peerName,
                    view.compactIdentity && styles.peerNameCompact,
                    view.halo.dim && styles.peerNameEnded,
                  ]}
                >
                  {call.peer.name}
                </Text>
                {/* ONE pill (the board), and the model decides which. */}
                {view.pill !== null && (
                  <View style={styles.pillRow}>
                    <CallStatePill
                      kind={view.pill.kind}
                      label={view.pill.label}
                      accessibilityLabel={view.pill.accessibilityLabel}
                    />
                  </View>
                )}

                {/*
                  * THE TIMER SHOWS WHEN; THE WORDS SHOW WHAT.
                  *
                  * `connectedAtMs` says when two-way audio was FIRST proven and
                  * never moves again -- exactly right for a duration and exactly
                  * wrong for a status. This row used to read "Connected"
                  * whenever that value existed, so a server that had gone back
                  * to `connecting` after a renegotiation still showed Connected.
                  */}
                {view.timer !== null && (
                  <Text style={[styles.timer, view.compactIdentity && styles.timerCompact]}>
                    {view.timer}
                  </Text>
                )}
                {view.connected !== null && (
                  <View style={styles.stateRow}>
                    <View style={[styles.stateDot, view.connected.warn && styles.stateDotWarn]} />
                    <Text
                      style={[
                        styles.stateLine,
                        styles.stateConnected,
                        view.connected.warn && styles.stateWarn,
                      ]}
                    >
                      {view.connected.words}
                    </Text>
                  </View>
                )}

                {view.stateLine !== null && <Text style={styles.stateLine}>{view.stateLine}</Text>}

                {/* `4 min 51 s · translated`, or nothing: a call that never
                    connected has no duration to state, and a call whose
                    translation was never measured claims nothing about it. */}
                {view.endedLine !== null && <Text style={styles.endedLine}>{view.endedLine}</Text>}

                {/*
                  * THE TRANSLATION LINE. Drawn only for a call the server has
                  * called translated, and worded from what was actually measured
                  * -- the gateway's engine verdict, this phone's playback path,
                  * refusals, and the proofs. It survives onto the ended screen
                  * when it is a FAULT, because a fault is a verdict about the
                  * whole call and the line beneath it must not be the last word.
                  */}
                {view.readinessLine !== null && (
                  <Text
                    style={[styles.readiness, view.readinessLine.warn && styles.readinessWarn]}
                  >
                    {view.readinessLine.words}
                  </Text>
                )}

                {/* ===== THE CALL SUMMARY, on the ended screen. ===== */}
                {view.summary !== null && (
                  <SummaryCard title={view.summary.title} rows={view.summary.rows} />
                )}

                {view.hint !== null && <Text style={styles.hint}>{view.hint}</Text>}
                {cameraStarting && <Text style={styles.hint}>Starting camera…</Text>}
                {view.cameraNotice && (
                  <View style={styles.cameraNotice}>
                    <Icon name="camera-off" size={26} color={CALL_COLORS.muted} />
                    <View style={{ gap: 2, flexShrink: 1 }}>
                      <Text style={styles.cameraNoticeTitle}>Your camera is off</Text>
                      <Text style={styles.cameraNoticeBody}>This is an audio-only call</Text>
                    </View>
                  </View>
                )}
              </View>
            </ScrollView>
            {/* ===== THE DUAL CAPTION, in the space that is kept for it. ===== */}
            {view.caption !== null && (
              <View style={styles.captionSlot}>
                <ScrollView
                  style={styles.captionScroll}
                  contentContainerStyle={styles.captionScrollContent}
                  showsVerticalScrollIndicator
                >
                  <CaptionCard
                    speaker={view.caption.speaker}
                    sourceLabel={view.caption.sourceLabel}
                    original={view.caption.original}
                    interim={view.caption.interim}
                    translation={view.caption.translation}
                  />
                </ScrollView>
              </View>
            )}
            </>
          )}
        </View>
      )}

      {/* ===== CONFERENCE: the code is the whole point -- it is what gets shared. ===== */}
      {call.kind === 'conference' && (
        <View style={styles.stage}>
          {joining && (
            <View style={styles.identity}>
              <ActivityIndicator color={CALL_COLORS.teal} size="large" />
              <Text style={styles.stateLine}>Joining the conference</Text>
            </View>
          )}
          {!joining && tiles.length === 0 && (
            <View style={styles.identity}>
              <Text style={styles.stateLine}>
                {serverState === 'ended'
                  ? 'Call ended'
                  : roster.length === 0
                    ? 'Waiting for others to join. Share the conference code:'
                    : `${roster.length} other${roster.length === 1 ? '' : 's'} here — connecting media`}
              </Text>
              {serverState !== 'ended' && <Text style={styles.code}>{callId}</Text>}
            </View>
          )}
          {tiles.length > 0 && (
            <View style={styles.tiles}>
              {tiles.map(([id, tile]) => {
                const person = roster.find((entry) => entry.participantId === id);
                const label = person?.displayName ?? 'Guest';
                return (
                  <View key={id} style={styles.tile}>
                    {tile.url !== null ? (
                      <RTCView streamURL={tile.url} style={styles.video} objectFit="cover" />
                    ) : (
                      <View style={[styles.video, styles.videoPlaceholder]}>
                        <AvatarView accountId={person?.accountId ?? id} name={label} size={64} />
                      </View>
                    )}
                    <View style={styles.tileIdentity}>
                      <Text style={styles.tileName} numberOfLines={1}>
                        {label}
                      </Text>
                      {DIAGNOSTICS && <Text style={styles.diag}>{tile.state}</Text>}
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}

      {error !== null && (
        <View style={styles.error}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {DIAGNOSTICS && (
        <View style={styles.diagBox}>
          <Text style={styles.diag}>
            {`joined ${joined} · you ${legs.publish} · them ${legs.receive}${
              voice === null ? '' : ` · ${voice.inboundPackets} pkts · ice ${voice.iceState}`
            } · ice servers ${iceCount ?? '?'} · state ${serverState ?? '-'}`}
          </Text>
          {transportLog.map((line) => (
            <Text key={line} style={styles.diag}>
              {line}
            </Text>
          ))}
        </View>
      )}

      {cameraOn && localUrl !== null && (
        <View style={styles.selfView}>
          <RTCView streamURL={localUrl} style={styles.selfVideo} objectFit="cover" mirror />
        </View>
      )}

      <View style={[styles.dockWrap, { paddingBottom: bottomInset + 12 }]}>
        <GlassDock>
          <View style={styles.controlsRow}>
            {/*
              * THE DOCK IS A FIXED SET FOR THE WHOLE OF A PHASE, and which set
              * belongs to which phase is `callScreenView`'s answer. One red
              * button while a call is being placed; the same four for the whole
              * of a live call, so nothing arrives mid-call and shifts the hand
              * reaching for End sideways; and on the ended screen the board's
              * two round buttons instead of live controls acting on a dead call.
              *
              * ONE ROW, WHICH IS WHERE THE CAPTION CARD'S SPACE CAME FROM. Five
              * LABELLED controls need 458dp and no portrait phone has it, so
              * the row wrapped and the dock took a third of the screen. Five
              * icon-only controls fit 360dp; `dockLabels` is the model's answer
              * to whether the words fit, and the words are the accessibility
              * names whether they are drawn or not. `flexWrap` stays as the
              * last resort for a very large system font.
              */}
            {view.dock.map((control) => (
              <RoundControl
                key={control.id}
                icon={dockIcon(control)}
                label={control.label}
                active={control.active}
                disabled={control.disabled}
                showLabel={view.dockLabels}
                onPress={() => dockPress(control)}
              />
            ))}
            {view.endedActions.includes('call-back') && (
              <RoundControl
                icon={<Icon name="phone" size={26} color={CALL_COLORS.text} />}
                label="Call back"
                showLabel={view.dockLabels}
                onPress={() => onCallBack?.()}
              />
            )}
            {view.endedActions.includes('message') && (
              <RoundControl
                icon={<Icon name="message" size={26} color={CALL_COLORS.text} />}
                label="Message"
                showLabel={view.dockLabels}
                onPress={() => onMessagePeer?.()}
              />
            )}
            <EndCallButton
              label={view.endLabel}
              onPress={hangUp}
              // Pressed once means once. The screen leaves when the request
              // settles; it does not claim the call ended before the server says.
              disabled={ending}
              showLabel={view.dockLabels}
              icon={<Icon name="hangup" size={28} color="#ffffff" />}
            />
          </View>
        </GlassDock>
      </View>

      {/* ===== JOINER: knocked on a restricted conference; no media until the host says so. ===== */}
      {call.kind === 'conference' && admission !== null && admission !== 'admitted' && (
        <View style={styles.admissionOverlay}>
          {info.title !== null && (
            <Text style={styles.admissionTitle} numberOfLines={2}>
              {info.title}
            </Text>
          )}
          {admission === 'pending' && <ActivityIndicator color={CALL_COLORS.teal} size="large" />}
          <Text style={styles.admissionLine}>{admissionWords(admission)}</Text>
          {admission === 'pending' && (
            <>
              <Text style={styles.hint}>The host sees your name and decides.</Text>
              <Pressable accessibilityRole="button" onPress={onLeave} style={({ pressed }) => [styles.admissionCancel, pressed && styles.knockPressed]}>
                <Text style={styles.admissionCancelLabel}>Cancel</Text>
              </Pressable>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: CALL_COLORS.ground },
  top: { paddingTop: 52, paddingHorizontal: 22 },
  stage: { flex: 1, justifyContent: 'center' },
  stageScroll: { flex: 1 },
  // `flexGrow` keeps the column centred while it fits and lets it scroll once
  // it does not, which is the whole point: nothing is clipped by the dock.
  stageScrollContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: 12 },
  /*
   * THE CARD'S OWN SPACE. Bounded, so it can never take the screen, and
   * `flexShrink: 0` so the column above it is what yields when the two compete
   * -- which is the whole ruling: the avatar, the clock and the name give way,
   * the card does not. A long utterance scrolls INSIDE it rather than pushing
   * anything off the bottom of the phone.
   */
  captionSlot: { flexShrink: 0, maxHeight: 216, paddingHorizontal: 16, paddingTop: 6 },
  captionScroll: { flexGrow: 0 },
  captionScrollContent: { paddingBottom: 2 },
  identity: { alignItems: 'center', gap: 10, paddingHorizontal: 28 },
  peerName: { color: CALL_COLORS.text, fontSize: 34, fontWeight: '600', fontFamily: 'serif', marginTop: 6, textAlign: 'center', letterSpacing: -0.3 },
  // With a caption card on screen the name is a label, not the headline.
  peerNameCompact: { fontSize: 24, marginTop: 2 },
  stateLine: { color: CALL_COLORS.muted, fontSize: 16, textAlign: 'center' },
  stateConnected: { color: CALL_COLORS.teal },
  stateWarn: { color: '#d9a441' },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stateDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: CALL_COLORS.teal },
  stateDotWarn: { backgroundColor: '#d9a441' },
  pillRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 },
  peerNameEnded: { color: CALL_COLORS.muted },
  endedLine: { color: CALL_COLORS.text, fontSize: 16, fontVariant: ['tabular-nums'], textAlign: 'center' },
  readiness: { color: CALL_COLORS.muted, fontSize: 14, textAlign: 'center', lineHeight: 20, marginTop: 2 },
  readinessWarn: { color: '#d9a441' },
  cameraNotice: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    alignSelf: 'stretch',
    marginHorizontal: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(62,201,192,0.22)',
    backgroundColor: 'rgba(12,28,36,0.6)',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  cameraNoticeTitle: { color: CALL_COLORS.text, fontSize: 16, fontWeight: '600' },
  cameraNoticeBody: { color: CALL_COLORS.muted, fontSize: 13 },
  timer: {
    color: CALL_COLORS.text,
    fontSize: 56,
    fontFamily: 'serif',
    fontWeight: '400',
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
    marginTop: 4,
  },
  // 56pt of clock is the ended screen's and the plain live call's; with a
  // caption card to fit, the clock is the second thing to yield after the face.
  timerCompact: { fontSize: 36, marginTop: 0 },
  timerSmall: { color: CALL_COLORS.muted, fontSize: 18, fontVariant: ['tabular-nums'] },
  hint: { color: CALL_COLORS.faint, fontSize: 13, textAlign: 'center', lineHeight: 19, marginTop: 8 },
  code: { color: CALL_COLORS.teal, fontSize: 24, fontFamily: 'monospace', letterSpacing: 2, marginTop: 6 },

  peerVideoWrap: { flex: 1, marginHorizontal: 12, borderRadius: 24, overflow: 'hidden' },
  peerVideo: { flex: 1, backgroundColor: CALL_COLORS.navy },
  peerVideoBanner: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(7,12,20,0.55)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  peerVideoName: { color: CALL_COLORS.text, fontSize: 14, fontWeight: '600', flex: 1 },
  peerVideoTimer: { color: CALL_COLORS.text, fontSize: 14, fontVariant: ['tabular-nums'] },
  /* The two sentences that must survive a camera coming on. */
  peerVideoState: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    gap: 4,
    borderRadius: 16,
    backgroundColor: 'rgba(7,12,20,0.72)',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  peerVideoEnded: { color: CALL_COLORS.text, fontSize: 15, fontVariant: ['tabular-nums'] },
  peerVideoWarn: { color: '#d9a441', fontSize: 14, lineHeight: 20 },

  tiles: { paddingHorizontal: 12, gap: 12 },
  tile: { gap: 6 },
  video: { width: '100%', aspectRatio: 3 / 4, borderRadius: 18, backgroundColor: CALL_COLORS.navy },
  videoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  tileIdentity: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 },
  tileName: { color: CALL_COLORS.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },

  selfView: {
    position: 'absolute',
    right: 16,
    top: 96,
    width: 96,
    height: 128,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: CALL_COLORS.glassEdge,
  },
  selfVideo: { width: '100%', height: '100%', backgroundColor: CALL_COLORS.navy },

  error: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#4a2620',
    backgroundColor: 'rgba(29,18,16,0.9)',
    padding: 12,
  },
  errorText: { color: '#e06c5b', fontSize: 13, lineHeight: 19 },
  diagBox: { marginHorizontal: 16, marginBottom: 8, gap: 2 },
  diag: { color: CALL_COLORS.faint, fontSize: 11, fontFamily: 'monospace' },

  dockWrap: { paddingHorizontal: 14 },
  controlsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'flex-start',
    columnGap: 8,
    rowGap: 14,
  },

  confTitle: { color: CALL_COLORS.text, fontSize: 20, fontWeight: '600', fontFamily: 'serif', marginTop: 10, letterSpacing: -0.2 },

  knockBanner: {
    marginTop: 12,
    marginHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(62,201,192,0.4)',
    backgroundColor: 'rgba(12,28,36,0.92)',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  knockHeadline: { color: CALL_COLORS.text, fontSize: 15, fontWeight: '600' },
  knockOthers: { color: CALL_COLORS.muted, fontSize: 12 },
  knockRefuse: { borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', paddingHorizontal: 14, paddingVertical: 8 },
  knockRefuseLabel: { color: CALL_COLORS.text, fontSize: 14, fontWeight: '600' },
  knockAdmit: { borderRadius: 999, backgroundColor: '#128a84', borderWidth: 1, borderColor: 'rgba(62,201,192,0.7)', paddingHorizontal: 16, paddingVertical: 8 },
  knockAdmitLabel: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
  knockPressed: { opacity: 0.6 },

  admissionOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: CALL_COLORS.ground,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 32,
  },
  admissionTitle: { color: CALL_COLORS.text, fontSize: 26, fontWeight: '600', fontFamily: 'serif', textAlign: 'center', letterSpacing: -0.3 },
  admissionLine: { color: CALL_COLORS.text, fontSize: 18, textAlign: 'center' },
  admissionCancel: { marginTop: 12, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', paddingHorizontal: 28, paddingVertical: 12 },
  admissionCancelLabel: { color: CALL_COLORS.text, fontSize: 16, fontWeight: '600' },
});
