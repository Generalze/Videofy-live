/** @author masterzee001 */
/**
 * A call, on screen.
 *
 * WHAT A PERSON MUST BE ABLE TO TELL AT A GLANCE, and the reason this screen has
 * more state than a video tile: whether the other side is actually there.
 * "Connecting" and "connected with the camera off" look identical if the only
 * signal is a black rectangle, and a caller who cannot distinguish them will sit
 * waiting for somebody who has already hung up. So peer state is shown per tile,
 * in words.
 *
 * THE CAMERA IS RELEASED ON EVERY EXIT PATH. Leaving, unmounting, backgrounding
 * -- all of them stop the tracks. On Android an un-stopped camera keeps the
 * hardware held and the privacy indicator lit, which to the person holding the
 * phone is indistinguishable from an app watching them after the call ended.
 *
 * NORMAL MODE, AND IT SAYS SO. This build carries camera and microphone and no
 * translation, so the screen states that rather than leaving somebody to
 * discover it by speaking a language nobody in the call understands.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AvatarView } from '../media/AvatarView';
import { RTCView } from 'react-native-webrtc';
import { CallConnection, type RemoteStream } from '../call/callConnection';

/** Not a secret; compiled into the bundle like every EXPO_PUBLIC_ value. */
const GATEWAY_URL = process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://staging.consummate7.com';

/**
 * An optional local override, normally empty.
 *
 * ICE servers come from the gateway at `/webrtc/ice`, because TURN credentials
 * expire and cannot be shipped in a bundle. This exists only so a developer can
 * point a build at something else; leaving it unset is the correct state.
 */
function iceOverride(): { urls: string | string[]; username?: string; credential?: string }[] {
  const raw = process.env['EXPO_PUBLIC_ICE_SERVERS'];
  if (raw === undefined || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReturnType<typeof iceOverride>) : [];
  } catch {
    // Malformed configuration is treated as absent, and the banner below still
    // warns -- silently proceeding as if it were valid would be worse.
    return [];
  }
}

const PEER_WORDS: Record<string, string> = {
  new: 'connecting',
  connecting: 'connecting',
  connected: 'connected',
  disconnected: 'reconnecting',
  failed: 'could not connect',
  closed: 'left',
};

export interface CallScreenProps {
  readonly callId: string;
  readonly displayName: string;
  /** The account's default language: the language this call enters with. */
  readonly defaultLanguage?: 'en' | 'es' | 'fr';
  /** Null is valid: it means this client can JOIN but not CREATE a call. */
  readonly sessionToken: string | null;
  /**
   * When set, ring this contact AFTER the join succeeds. Order is the
   * contract: only a verified account may CREATE a call, so the caller joins
   * first (becoming the host) and rings second -- ring-then-join would race
   * the callee into being the creator.
   */
  readonly ringName?: string | undefined;
  readonly onRing?: ((callId: string) => Promise<number | null>) | undefined;
  readonly onLeave: () => void;
}

export function CallScreen({
  callId,
  displayName,
  defaultLanguage,
  sessionToken,
  ringName,
  onRing,
  onLeave,
}: CallScreenProps): JSX.Element {
  const connection = useRef<CallConnection | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<Record<string, { url: string | null; state: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(true);
  const [joining, setJoining] = useState(true);
  /*
   * What the GATEWAY says is in the call, which is not the same as what the
   * mesh has connected. A black screen cannot distinguish "nobody else is
   * here" from "somebody is here and the media has not connected" -- and those
   * have completely different fixes.
   */
  const [roster, setRoster] = useState<
    readonly { participantId: string; displayName: string; accountId?: string }[]
  >([]);
  const others = roster.length;
  const [muted, setMuted] = useState(false);
  /*
   * null until the fetch resolves. The old banner read a build-time env value
   * and so reported "no ICE servers" even when the gateway was serving TURN
   * perfectly well -- it was describing the app's configuration rather than the
   * call's actual capability.
   */
  const [iceCount, setIceCount] = useState<number | null>(null);
  /** null: not ringing anybody. -1: ring failed. >=0: phones reached. */
  const [rang, setRang] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    const call = new CallConnection({
      gatewayUrl: GATEWAY_URL,
      callId,
      displayName,
      ...(defaultLanguage === undefined ? {} : { defaultLanguage }),
      sessionToken,
      // Left unset so the connection fetches from the gateway, which is the
      // only source that can mint TURN credentials that expire.
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
        if (live) setRoster(list);
      },
      onIceServers: (count) => {
        if (live) setIceCount(count);
      },
      onError: (message) => {
        if (live) setError(message);
      },
    });
    connection.current = call;

    void (async () => {
      try {
        const local = await call.openLocalMedia();
        if (!live) return;
        setLocalUrl(local.toURL());

        /*
         * THE ACK IS READ, and this is the whole reason the call screen has a
         * failure state. A refused join used to leave this sitting on "waiting
         * for someone to join" forever, which is indistinguishable from an
         * empty call and sends somebody looking for a person who was never
         * able to be there.
         */
        const ack = await call.join();
        if (!live) return;
        if (ack.ok && onRing !== undefined) {
          const reached = await onRing(callId);
          if (live) setRang(reached ?? -1);
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
              ? 'Camera and microphone access is needed for a call.'
              : 'Could not start the call.',
          );
        }
      } finally {
        if (live) setJoining(false);
      }
    })();

    /*
     * The cleanup is the ONLY guaranteed exit path -- a person can leave by
     * backgrounding, by navigating, or by the process being killed, and only
     * this runs for all of them.
     */
    return () => {
      live = false;
      call.leave();
      connection.current = null;
    };
  }, [callId, displayName, sessionToken]);

  const toggleCamera = useCallback(() => {
    setCameraOn((on) => {
      connection.current?.setCameraEnabled(!on);
      return !on;
    });
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((wasMuted) => {
      connection.current?.setMicrophoneEnabled(wasMuted);
      return !wasMuted;
    });
  }, []);

  const tiles = Object.entries(remotes);
  const noIce = iceCount === 0;

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.tiles}>
        {joining && (
          <View style={styles.centreBlock}>
            <ActivityIndicator color="#3ec9c0" size="large" />
            <Text style={styles.muted}>Joining the call</Text>
          </View>
        )}

        {error !== null && (
          <View style={styles.error}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {noIce && (
          <View style={styles.warn}>
            <Text style={styles.warnText}>
              No ICE servers configured. This call can only connect between devices on the same
              network.
            </Text>
          </View>
        )}

        {ringName !== undefined && rang !== null && tiles.length === 0 && (
          <View style={styles.centreBlock}>
            <Text style={styles.muted}>
              {rang > 0
                ? `Ringing ${ringName}...`
                : rang === 0
                  ? `${ringName} has no registered phone, so nothing will ring. Share the code instead.`
                  : `${ringName} could not be rung. Share the code instead.`}
            </Text>
          </View>
        )}

        {tiles.length === 0 && !joining && (
          <View style={styles.centreBlock}>
            <Text style={styles.muted}>
              {others === 0
                ? 'Waiting for someone else to join'
                : `${others} other${others === 1 ? '' : 's'} in this call - connecting media`}
            </Text>
            <Text style={styles.code}>{callId}</Text>
            {others > 0 && (
              <Text style={styles.hint}>
                They are in the call. If this does not clear, the two devices cannot reach each
                other directly - which is what ICE servers are for.
              </Text>
            )}
          </View>
        )}

        {tiles.map(([id, tile]) => (
          <View key={id} style={styles.tile}>
            {/*
              VIDEO RENDERS THE MOMENT A STREAM EXISTS. It was gated on the
              peer state string reaching 'connected', so a platform whose state
              events lag or differ hid a stream that was already playing --
              which on a real phone read as "video didn't show". The stream is
              the truth; the state word is an overlay for when there is none.
            */}
            {tile.url !== null ? (
              <RTCView streamURL={tile.url} style={styles.video} objectFit="cover" />
            ) : (
              <View style={[styles.video, styles.videoPlaceholder]}>
                <Text style={styles.muted}>{PEER_WORDS[tile.state] ?? tile.state}</Text>
              </View>
            )}
            {(() => {
              /*
               * THE PERSON, PROMINENT. The marketing samples show a face and
               * a name on every tile; an 11px monospace id under the video was
               * a debug label wearing a person's seat.
               */
              const person = roster.find((entry) => entry.participantId === id);
              const label = person?.displayName ?? 'Guest';
              return (
                <View style={styles.tileIdentity}>
                  <AvatarView
                    accountId={person?.accountId ?? id}
                    name={label}
                    size={28}
                  />
                  <Text style={styles.tileName} numberOfLines={1}>
                    {label}
                  </Text>
                </View>
              );
            })()}
          </View>
        ))}
      </ScrollView>

      {localUrl !== null && (
        <View style={styles.selfView}>
          {cameraOn ? (
            <RTCView streamURL={localUrl} style={styles.selfVideo} objectFit="cover" mirror />
          ) : (
            <View style={[styles.selfVideo, styles.videoPlaceholder]}>
              <Text style={styles.selfOff}>camera off</Text>
            </View>
          )}
        </View>
      )}

      <View style={styles.controls}>
        <Text style={styles.mode}>Normal mode - no translation in this build</Text>
        <View style={styles.buttons}>
          <Pressable
            style={({ pressed }) => [
              styles.control,
              muted && styles.controlActive,
              pressed && styles.pressed,
            ]}
            onPress={toggleMute}
            accessibilityRole="button"
          >
            <Text style={styles.controlLabel}>{muted ? 'Unmute' : 'Mute'}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.control, pressed && styles.pressed]}
            onPress={toggleCamera}
            accessibilityRole="button"
          >
            <Text style={styles.controlLabel}>{cameraOn ? 'Camera off' : 'Camera on'}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.control, styles.leave, pressed && styles.pressed]}
            onPress={onLeave}
            accessibilityRole="button"
          >
            <Text style={styles.leaveLabel}>Leave</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b0f14' },
  tiles: { flexGrow: 1, padding: 12, gap: 12, justifyContent: 'center' },
  centreBlock: { alignItems: 'center', gap: 12, paddingVertical: 40 },
  muted: { color: '#8d99a6', fontSize: 14 },
  code: { color: '#3ec9c0', fontSize: 22, fontFamily: 'monospace', letterSpacing: 2 },
  hint: { color: '#5d6874', fontSize: 12, textAlign: 'center', lineHeight: 18, paddingHorizontal: 20 },

  tile: { gap: 6 },
  video: { width: '100%', aspectRatio: 3 / 4, borderRadius: 12, backgroundColor: '#141a21' },
  videoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  tileIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  tileName: { color: '#e4ebf1', fontSize: 15, fontWeight: '600', flexShrink: 1 },

  selfView: {
    position: 'absolute',
    right: 14,
    bottom: 130,
    width: 96,
    height: 128,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#273039',
  },
  selfVideo: { width: '100%', height: '100%', backgroundColor: '#141a21' },
  selfOff: { color: '#5d6874', fontSize: 11 },

  error: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#4a2620',
    backgroundColor: '#1d1210',
    padding: 12,
  },
  errorText: { color: '#e06c5b', fontSize: 13, lineHeight: 19 },
  warn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3a2a12',
    backgroundColor: '#1d1710',
    padding: 12,
  },
  warnText: { color: '#d9a441', fontSize: 12, lineHeight: 18 },

  controls: {
    borderTopWidth: 1,
    borderTopColor: '#273039',
    padding: 16,
    paddingBottom: 28,
    gap: 12,
    backgroundColor: '#0b0f14',
  },
  mode: { color: '#5d6874', fontSize: 12, textAlign: 'center' },
  buttons: { flexDirection: 'row', gap: 10 },
  control: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#141a21',
    borderWidth: 1,
    borderColor: '#273039',
  },
  controlLabel: { color: '#e4ebf1', fontSize: 15, fontWeight: '600' },
  leave: { backgroundColor: '#3a1d18', borderColor: '#4a2620' },
  leaveLabel: { color: '#e06c5b', fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.75 },
  controlActive: { backgroundColor: '#3a2a12', borderColor: '#d9a441' },
});
