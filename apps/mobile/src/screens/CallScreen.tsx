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
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { setAudioModeAsync } from 'expo-audio';
import { RTCView } from 'react-native-webrtc';
import type { DirectCallStateSnapshot } from '@videofy-live/call-client-core';
import { AvatarView } from '../media/AvatarView';
import { useBottomInset } from '../ui/insets';
import {
  AvatarHalo,
  C7Mark,
  CALL_COLORS,
  CallBackdrop,
  EndCallButton,
  GlassDock,
  RoundControl,
} from '../ui/callTheme';
import { createAudioRouter, resolveRoute, type AudioRoute } from '../call/audioRoute';
import { elapsedSinceMs, formatElapsed, observeServerClock } from '../call/callTimer';
import { TERMINAL_DIRECT_STATES, directStateWords } from '../call/directCallApi';
import { Icon } from '../ui/icons';
import {
  CallConnection,
  type CallTransportEvent,
  type RemoteStream,
} from '../call/callConnection';

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
    };

export interface CallScreenProps {
  readonly call: ActiveCallDescriptor;
  readonly displayName: string;
  readonly speakLanguage?: 'en' | 'es' | 'fr';
  readonly hearLanguage?: 'en' | 'es' | 'fr';
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

/** The words the telephone shows while two-way audio is not yet proven. */
function stateLine(
  serverState: string | null,
  role: 'caller' | 'callee',
  peerName: string,
): string {
  if (serverState === null) return role === 'caller' ? `Calling ${peerName}…` : 'Connecting…';
  return directStateWords(serverState, peerName);
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
   * THE TELEPHONE. `serverState` is the server's word; `connectedAtMs` is the
   * server-stamped origin of the timer; `clockOffset` is measured once from
   * the first wire so the origin can be ticked on the phone's clock.
   */
  const [serverState, setServerState] = useState<string | null>(null);
  const [mode, setMode] = useState<'normal' | 'translated' | null>(null);
  const [connectedAtMs, setConnectedAtMs] = useState<number | null>(null);
  const clockOffset = useRef<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  /** Frozen at the moment the call ended, so the final duration stays on screen. */
  const [finalElapsedMs, setFinalElapsedMs] = useState<number | null>(null);

  /** Audio routing: an explicit choice, or null for the camera-driven default. */
  const [chosenRoute, setChosenRoute] = useState<AudioRoute | null>(null);
  const router = useRef(createAudioRouter((audioMode) => setAudioModeAsync(audioMode)));

  const acceptDirectState = useCallback((wire: DirectCallStateSnapshot) => {
    clockOffset.current = observeServerClock(clockOffset.current, wire.updatedAtMs, Date.now());
    setServerState(wire.state);
    setMode(wire.mode);
    if (wire.connectedAtMs !== null) setConnectedAtMs(wire.connectedAtMs);
  }, []);

  useEffect(() => {
    let live = true;
    const link = new CallConnection({
      gatewayUrl: GATEWAY_URL,
      callId,
      displayName,
      ...(call.kind === 'direct' ? { directPeerAccountId: call.peer.accountId } : {}),
      ...(speakLanguage === undefined ? {} : { speakLanguage }),
      ...(hearLanguage === undefined ? {} : { hearLanguage }),
      sessionToken,
      ...(iceOverride().length > 0 ? { iceServers: iceOverride() } : {}),
      onRemoteStream: (id, stream: RemoteStream) =>
        setRemotes((current) => ({
          ...current,
          [id]: { url: stream === null ? null : stream.toURL(), state: current[id]?.state ?? 'new' },
        })),
      onPeerState: (id, state) =>
        setRemotes((current) => ({
          ...current,
          [id]: { url: current[id]?.url ?? null, state },
        })),
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
        if (live) acceptDirectState(wire);
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
      onError: (message) => {
        if (live) setError(message);
      },
    });
    connection.current = link;

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

    return () => {
      live = false;
      link.leave();
      connection.current = null;
      void router.current.release();
    };
    // The connection is built once per call; the callbacks read state through setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, displayName, sessionToken]);

  // The timer ticks while there is an origin and the call has not ended.
  const terminal = serverState !== null && TERMINAL_DIRECT_STATES.has(serverState);
  useEffect(() => {
    if (connectedAtMs === null || terminal) return undefined;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connectedAtMs, terminal]);

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

  // Audio route follows the camera unless the person chose.
  useEffect(() => {
    void router.current.apply(resolveRoute(cameraOn, chosenRoute));
  }, [cameraOn, chosenRoute]);

  const toggleCamera = useCallback(() => {
    const next = !cameraOn;
    if (next) setCameraStarting(true);
    void connection.current?.setCameraEnabled(next).then((stream) => {
      setCameraStarting(false);
      if (next && stream === null) {
        setError('Camera access is needed to turn the camera on. The call continues on audio.');
        return;
      }
      setLocalUrl(stream === null ? null : stream.toURL());
      setCameraOn(next);
    });
  }, [cameraOn]);

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
    const link = connection.current;
    setServerState('ended');
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

  return (
    <View style={styles.screen}>
      <CallBackdrop />

      <View style={styles.top}>
        <C7Mark caption={call.kind === 'direct' ? 'Direct call' : 'Conference'} />
      </View>

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
              <AvatarHalo
                accountId={call.peer.accountId}
                name={call.peer.name}
                size={124}
                pulsing={!terminal && elapsedMs === null}
              />
              <Text style={styles.peerName}>{call.peer.name}</Text>
              <View style={styles.modePill}>
                <Text style={styles.modePillLabel}>{modeLabel}</Text>
              </View>
              {elapsedMs !== null && !terminal ? (
                <>
                  <Text style={styles.timer}>{formatElapsed(elapsedMs)}</Text>
                  <View style={styles.stateRow}>
                    <View style={[styles.stateDot, serverState === 'reconnecting' && styles.stateDotWarn]} />
                    <Text style={[styles.stateLine, styles.stateConnected, serverState === 'reconnecting' && styles.stateWarn]}>
                      {serverState === 'reconnecting' ? 'Reconnecting…' : 'Connected'}
                    </Text>
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.stateLine}>{stateLine(serverState, role, call.peer.name)}</Text>
                  {terminal && elapsedMs !== null && (
                    <Text style={styles.timerSmall}>{formatElapsed(elapsedMs)}</Text>
                  )}
                </>
              )}
              {(serverState === 'unavailable' ||
                serverState === 'no_answer' ||
                serverState === 'busy' ||
                serverState === 'declined') && (
                <Text style={styles.hint}>You can message them instead, or call again later.</Text>
              )}
              {cameraStarting && <Text style={styles.hint}>Starting camera…</Text>}
              {!cameraOn && !terminal && (
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
            <EndCallButton
              label={call.kind === 'direct' ? 'End call' : 'Leave'}
              onPress={hangUp}
              icon={<Icon name="hangup" size={30} color="#ffffff" />}
            />
          </View>
        </GlassDock>
      </View>
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
});
