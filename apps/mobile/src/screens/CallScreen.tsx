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
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
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
  CaptionCard,
  EndCallButton,
  Eyebrow,
  GlassDock,
  LanguagePill,
  RoundControl,
  SpeechIndicator,
  SummaryCard,
} from '../ui/callTheme';
import { createAudioRouter, resolveRoute, type AudioRoute } from '../call/audioRoute';
import {
  elapsedSinceMs,
  formatElapsed,
  formatSpokenElapsed,
  observeRingWindow,
  observeServerClock,
  ringProgress,
} from '../call/callTimer';
import { TERMINAL_DIRECT_STATES } from '../call/directCallApi';
import {
  callEyebrow,
  connectedRow,
  directCallPhase,
  endedSummaryLine,
  stateLine,
  translatedAudioUnavailableLine,
} from '../call/callDisplay';
import { captionCard, captionSpeaking, nextCaption } from '../call/callCaption';
import {
  languagePairNames,
  languageShortCode,
  type CallLanguagePair,
} from '../call/callLanguages';
import { translationReadiness } from '../call/translationReadiness';
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
}

export function CallScreen({
  call,
  displayName,
  speakLanguage,
  hearLanguage,
  sessionToken,
  onRing,
  onLeave,
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
  } | null>(null);
  /** The person's own choice to hide the caption card. Never hides a fault. */
  const [captionsShown, setCaptionsShown] = useState(true);
  /** The pair `call:state` records, or null while it cannot be measured. */
  const [languages, setLanguages] = useState<CallLanguagePair | null>(null);
  /** False once the GATEWAY said this deployment has no translation engine. */
  const [engineReal, setEngineReal] = useState<boolean | null>(null);
  /** This phone's own translated-speech path, as its diagnostic last reported. */
  const [playback, setPlayback] = useState<'listening' | 'unavailable' | null>(null);

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
      onCaption: (event: CallCaptionEvent) => {
        if (!live) return;
        stamp('caption_received');
        setCaption((current) => {
          const accepted = nextCaption(current?.event ?? null, event);
          if (accepted === null) return current;
          if (current !== null && accepted === current.event) return current;
          return { event: accepted, changedAtMs: Date.now() };
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
         * The two DECISIVE kinds reach the screen; `refused` and `originals`
         * are per-frame and per-policy and do not describe whether this phone
         * can play translated speech at all.
         */
        if (event.kind === 'listening') setPlayback('listening');
        if (event.kind === 'unavailable') setPlayback('unavailable');
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
  const tickIntervalMs = connectedAtMs === null ? 250 : 1000;
  const ticking = !terminal && (connectedAtMs !== null || ringExpiresAtMs !== null);
  useEffect(() => {
    if (!ticking) return undefined;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), tickIntervalMs);
    return () => clearInterval(timer);
  }, [ticking, tickIntervalMs]);

  // Freeze the duration at the moment the call ends.
  useEffect(() => {
    if (terminal && connectedAtMs !== null && finalElapsedMs === null) {
      setFinalElapsedMs(elapsedSinceMs(connectedAtMs, clockOffset.current, Date.now()));
    }
  }, [terminal, connectedAtMs, finalElapsedMs]);

  // A terminal telephone state ends the screen after the words are read.
  useEffect(() => {
    if (!terminal) return undefined;
    const timer = setTimeout(() => onLeave(), 2500);
    return () => clearTimeout(timer);
  }, [terminal, onLeave]);

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
     * The screen still leaves on its own after the request settles: a person
     * who pressed End must never be held on a call screen because an
     * acknowledgement was lost.
     */
    const link = connection.current;
    setEnding(true);
    void (link?.end() ?? Promise.resolve(false)).finally(() => {
      setTimeout(() => onLeave(), 600);
    });
  }, [call.kind, onLeave, terminal]);

  const tiles = Object.entries(remotes);
  const peerVideo = tiles.find(([, tile]) => tile.url !== null)?.[1].url ?? null;
  const elapsedMs =
    finalElapsedMs ??
    (connectedAtMs === null ? null : elapsedSinceMs(connectedAtMs, clockOffset.current, nowMs));
  const modeLabel =
    call.kind === 'direct'
      ? mode === 'translated'
        ? 'Translated call'
        : mode === 'normal'
          ? 'Normal call'
          : 'Direct call'
      : 'Conference';
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
  const eyebrow = callEyebrow(serverState, role, phase);
  const readiness = translationReadiness({ mode, engine: engineReal, playback });
  const arc = ringProgress({
    expiresAtMs: ringExpiresAtMs,
    windowMs: ringWindowMs.current,
    offsetMs: clockOffset.current,
    localNowMs: nowMs,
  });
  const card = captionCard(caption?.event ?? null);
  const speaking = captionSpeaking({
    caption: caption?.event ?? null,
    changedAtMs: caption?.changedAtMs ?? null,
    nowMs,
  });
  const endedLine = endedSummaryLine(elapsedMs, mode);

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
            </View>
          ) : (
            <View style={styles.identity}>
              {eyebrow !== null && <Eyebrow>{eyebrow}</Eyebrow>}
              {/*
                * THE SPEECH INDICATOR, above the name, on a live call only.
                * `speaking` is a measurement of the caption stream -- see
                * callCaption's `captionSpeaking` -- and the component cannot
                * animate without it. It is drawn only once a caption has
                * actually arrived: five grey bars on a call that has no caption
                * stream at all would be an indicator for a signal that does not
                * exist here.
                */}
              {phase === 'live' && caption !== null && <SpeechIndicator active={speaking} />}
              <AvatarHalo
                accountId={call.peer.accountId}
                name={call.peer.name}
                size={124}
                // The breathing halo and the measured arc are two answers to
                // "is anything happening"; the arc is the better one, so the
                // pulse stands down wherever there is a window to draw.
                pulsing={phase === 'placing' && arc === null}
                ring={phase !== 'live'}
                progress={phase === 'placing' ? arc : null}
                dim={phase === 'ended'}
              />
              <Text style={[styles.peerName, phase === 'ended' && styles.peerNameEnded]}>
                {call.peer.name}
              </Text>
              <View style={styles.pillRow}>
                <View style={styles.modePill}>
                  <Text style={styles.modePillLabel}>{modeLabel}</Text>
                </View>
                {/* The pair, from `call:state`, or no pill at all. */}
                {languages !== null && <LanguagePill pair={languages} />}
              </View>

              {phase === 'live' && (
                <>
                  {/*
                    * THE TIMER SHOWS WHEN; THE WORDS SHOW WHAT.
                    *
                    * `connectedAtMs` says when two-way audio was FIRST proven
                    * and never moves again -- which is exactly right for a
                    * duration and exactly wrong for a status. This row used to
                    * read "Connected" whenever that value existed, so a server
                    * that had gone back to `connecting` after a renegotiation
                    * still showed Connected, and the screen quietly disagreed
                    * with the call.
                    *
                    * The elapsed time keeps running across a reconnect, because
                    * the call did not restart; the sentence beneath it is
                    * whatever the server currently says.
                    */}
                  <Text style={styles.timer}>{elapsedMs === null ? '' : formatElapsed(elapsedMs)}</Text>
                  <View style={styles.stateRow}>
                    <View style={[styles.stateDot, connectedRowState.warn && styles.stateDotWarn]} />
                    <Text style={[styles.stateLine, styles.stateConnected, connectedRowState.warn && styles.stateWarn]}>
                      {connectedRowState.words}
                    </Text>
                  </View>
                </>
              )}

              {phase === 'placing' && (
                <Text style={styles.stateLine}>{stateLine(serverState, role, call.peer.name)}</Text>
              )}

              {phase === 'ended' && (
                <>
                  <Text style={styles.stateLine}>{stateLine(serverState, role, call.peer.name)}</Text>
                  {/* `4 min 51 s · translated`, or nothing: a call that never
                      connected has no duration to state. */}
                  {endedLine !== null && <Text style={styles.endedLine}>{endedLine}</Text>}
                </>
              )}

              {/*
                * THE TRANSLATION LINE. Drawn only for a call the server has
                * called translated, and worded from what was actually
                * measured -- the gateway's engine verdict and this phone's own
                * playback path. `translationReadiness` answers null words for
                * everything else, and nothing is rendered.
                */}
              {readiness.words !== null && phase !== 'ended' && (
                <Text style={[styles.readiness, readiness.warn && styles.readinessWarn]}>
                  {readiness.words}
                </Text>
              )}

              {/* ===== THE DUAL CAPTION. ===== */}
              {phase === 'live' && card !== null && captionsShown && (
                <CaptionCard
                  speaker={card.speaker}
                  sourceLabel={languageShortCode(card.sourceLanguage)}
                  original={card.original}
                  interim={!card.isFinal}
                  translation={
                    card.translation === null
                      ? null
                      : {
                          label: languageShortCode(card.translation.language),
                          text: card.translation.text,
                        }
                  }
                />
              )}

              {/* ===== THE CALL SUMMARY, on the ended screen. ===== */}
              {phase === 'ended' && (elapsedMs !== null || languages !== null) && (
                <SummaryCard
                  title="Call summary"
                  rows={[
                    ...(elapsedMs === null
                      ? []
                      : [{ label: 'Duration', value: formatSpokenElapsed(elapsedMs) }]),
                    ...(languages === null
                      ? []
                      : [{ label: 'Languages', value: languagePairNames(languages) }]),
                  ]}
                />
              )}

              {(serverState === 'unavailable' ||
                serverState === 'no_answer' ||
                serverState === 'busy' ||
                serverState === 'declined') && (
                <Text style={styles.hint}>You can message them instead, or call again later.</Text>
              )}
              {cameraStarting && <Text style={styles.hint}>Starting camera…</Text>}
              {!cameraOn && phase === 'live' && card === null && (
                <View style={styles.cameraNotice}>
                  <Icon name="camera-off" size={26} color={CALL_COLORS.muted} />
                  <View style={{ gap: 2, flexShrink: 1 }}>
                    <Text style={styles.cameraNoticeTitle}>Your camera is off</Text>
                    <Text style={styles.cameraNoticeBody}>This is an audio-only call</Text>
                  </View>
                </View>
              )}
            </View>
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
              * ONE RED BUTTON WHILE THE CALL IS BEING PLACED (founder's board).
              * Mute, Speaker and Camera all act on media that does not exist
              * yet on a call nobody has answered; the only thing there is to do
              * is stop. The conference path keeps the full dock, because a
              * conference is joined rather than placed.
              */}
            {!(call.kind === 'direct' && phase === 'placing') && (
              <>
                <RoundControl
                  icon={<Icon name={muted ? 'mic-off' : 'mic'} size={26} color={muted ? CALL_COLORS.ground : CALL_COLORS.text} />}
                  label={muted ? 'Unmute' : 'Mute'}
                  active={muted}
                  onPress={toggleMute}
                />
                <RoundControl
                  icon={<Icon name="speaker" size={26} color={speakerOn ? CALL_COLORS.ground : CALL_COLORS.text} />}
                  label="Speaker"
                  active={speakerOn}
                  onPress={toggleSpeaker}
                />
                <RoundControl
                  icon={<Icon name={cameraOn ? 'camera' : 'camera-off'} size={26} color={cameraOn ? CALL_COLORS.ground : CALL_COLORS.text} />}
                  label={cameraOn ? 'Camera on' : 'Camera off'}
                  active={cameraOn}
                  disabled={cameraStarting}
                  onPress={toggleCamera}
                />
              </>
            )}
            {/*
              * THE CAPTION CONTROL EXISTS ONLY ONCE CAPTIONS DO.
              *
              * The board draws a third round control here, teal and active,
              * labelled Translate. It is NOT wired as one: turning translation
              * on or off mid-call is `call:mode:set`, which the gateway grants
              * to the call owner alone and which this client has never sent, so
              * a Translate button on this phone would be a switch attached to
              * nothing. What the phone genuinely owns is whether the caption
              * card is on screen, and the control says so in its own name.
              */}
            {call.kind === 'direct' && caption !== null && phase === 'live' && (
              <RoundControl
                mark="CC"
                label={captionsShown ? 'Captions' : 'Show captions'}
                active={captionsShown}
                onPress={() => setCaptionsShown((shown) => !shown)}
              />
            )}
            <EndCallButton
              label={
                call.kind !== 'direct'
                  ? 'Leave'
                  : phase === 'ended'
                    ? 'Close'
                    : phase === 'placing'
                      ? 'Cancel'
                      : 'End call'
              }
              onPress={hangUp}
              // Pressed once means once. The screen leaves when the request
              // settles; it does not claim the call ended before the server says.
              disabled={ending}
              icon={<Icon name="hangup" size={30} color="#ffffff" />}
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
  identity: { alignItems: 'center', gap: 10, paddingHorizontal: 28 },
  peerName: { color: CALL_COLORS.text, fontSize: 34, fontWeight: '600', fontFamily: 'serif', marginTop: 6, textAlign: 'center', letterSpacing: -0.3 },
  stateLine: { color: CALL_COLORS.muted, fontSize: 16, textAlign: 'center' },
  stateConnected: { color: CALL_COLORS.teal },
  stateWarn: { color: '#d9a441' },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stateDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: CALL_COLORS.teal },
  stateDotWarn: { backgroundColor: '#d9a441' },
  modePill: { borderRadius: 999, borderWidth: 1, borderColor: 'rgba(62,201,192,0.5)', paddingHorizontal: 14, paddingVertical: 5, backgroundColor: 'rgba(62,201,192,0.08)' },
  modePillLabel: { color: CALL_COLORS.teal, fontSize: 13, fontWeight: '600' },
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
  controlsRow: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-start' },

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
