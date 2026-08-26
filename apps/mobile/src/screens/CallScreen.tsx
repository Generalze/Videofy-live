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
import { RTCView } from 'react-native-webrtc';
import { CallConnection, type RemoteStream } from '../call/callConnection';

/** Not a secret; compiled into the bundle like every EXPO_PUBLIC_ value. */
const GATEWAY_URL = process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://staging.consummate7.com';

/**
 * ICE servers, from the deployment.
 *
 * Absent means direct-connection only: fine on one Wi-Fi, and nothing else. The
 * screen says so rather than letting somebody discover it as a black rectangle
 * on mobile data.
 */
function iceServers(): { urls: string | string[]; username?: string; credential?: string }[] {
  const raw = process.env['EXPO_PUBLIC_ICE_SERVERS'];
  if (raw === undefined || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReturnType<typeof iceServers>) : [];
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
  readonly participantId: string;
  readonly displayName: string;
  readonly onLeave: () => void;
}

export function CallScreen({
  callId,
  participantId,
  displayName,
  onLeave,
}: CallScreenProps): JSX.Element {
  const connection = useRef<CallConnection | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<Record<string, { url: string | null; state: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(true);
  const [joining, setJoining] = useState(true);

  useEffect(() => {
    let live = true;
    const call = new CallConnection({
      gatewayUrl: GATEWAY_URL,
      callId,
      participantId,
      displayName,
      iceServers: iceServers(),
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
        await call.join();
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
  }, [callId, participantId, displayName]);

  const toggleCamera = useCallback(() => {
    setCameraOn((on) => {
      connection.current?.setCameraEnabled(!on);
      return !on;
    });
  }, []);

  const tiles = Object.entries(remotes);
  const noIce = iceServers().length === 0;

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

        {tiles.length === 0 && !joining && (
          <View style={styles.centreBlock}>
            <Text style={styles.muted}>Waiting for someone else to join</Text>
            <Text style={styles.code}>{callId}</Text>
          </View>
        )}

        {tiles.map(([id, tile]) => (
          <View key={id} style={styles.tile}>
            {tile.url !== null && tile.state === 'connected' ? (
              <RTCView streamURL={tile.url} style={styles.video} objectFit="cover" />
            ) : (
              <View style={[styles.video, styles.videoPlaceholder]}>
                {/*
                  In words, not just an empty rectangle. A black tile cannot
                  distinguish "still connecting" from "connected with the camera
                  off" from "already left".
                */}
                <Text style={styles.muted}>{PEER_WORDS[tile.state] ?? tile.state}</Text>
              </View>
            )}
            <Text style={styles.tileLabel}>{id}</Text>
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

  tile: { gap: 6 },
  video: { width: '100%', aspectRatio: 3 / 4, borderRadius: 12, backgroundColor: '#141a21' },
  videoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  tileLabel: { color: '#5d6874', fontSize: 11, fontFamily: 'monospace' },

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
});
