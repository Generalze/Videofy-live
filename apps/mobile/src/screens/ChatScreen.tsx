/** @author masterzee001 */
/**
 * One conversation, to canon: the person in the header (picture, name,
 * handle), the Translate pill and a round Call control; the messages as
 * bubbles on the C7 ground with day chips and call rows between them; a
 * composer with a hold-to-record mic, a rounded field and a round send.
 *
 * THE LIST IS INVERTED. Chat reads bottom-up: the newest message sits at the
 * keyboard edge, history loads upward. FlatList's `inverted` gives that for
 * free, at the price of the data array being newest-first -- which is exactly
 * the order the server already returns, so nothing is re-sorted anywhere.
 *
 * VOICE NOTES HOLD THE RECORDER, NOT THE TRANSCRIPT. Recording uses
 * expo-audio's hook; the file is read back as base64 and posted through the
 * same JSON path as everything else. Playback fetches through authorizedFetch
 * into a data URI, so the credential never leaves the session layer.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AvatarView } from '../media/AvatarView';
import { useBottomInset } from '../ui/insets';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
} from 'expo-audio';
import { File } from 'expo-file-system';
import type { Api, ContactPerson, TimelineItem, WireMessage } from '../api/client';
import { callHistoryWords } from '../call/callHistoryWords';
import type { AuthorizedFetch } from '../push/deviceRegistrationService';
import { fetchVoiceNoteAsDataUri, formatDuration } from '../media/voiceNotes';
import { C7, C7Ground, Chip } from '../ui/c7';
import { Icon } from '../ui/icons';

const POLL_MS = 3000;

export interface ChatScreenProps {
  readonly api: Api;
  readonly authorizedFetch: AuthorizedFetch;
  readonly selfId: string;
  readonly partner: ContactPerson;
  readonly onBack: () => void;
  /** Start a call and ring this contact. The call screen owns the rest. */
  readonly onCall: (partner: ContactPerson) => void;
  /** Their picture or name opens their profile. */
  readonly onOpenPerson: (partner: ContactPerson) => void;
}

export function ChatScreen({
  api,
  authorizedFetch,
  selfId,
  partner,
  onBack,
  onCall,
  onOpenPerson,
}: ChatScreenProps): JSX.Element {
  const [messages, setMessages] = useState<readonly TimelineItem[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * VOICE NOTES HAVE THREE STATES, NOT ONE. Hold-to-send meant a slip of the
   * thumb was a message, and there was no way to listen before sending
   * (founder review, 29 Aug). Now: RECORDING (Cancel / Stop) -> PREVIEW
   * (Delete / play, seek, duration / Send) -> sent. Sent notes and the
   * preview share one player, and the bubble follows the player's REAL
   * status -- playing, position, duration -- instead of a flag that reset
   * itself the moment playback began.
   */
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [preview, setPreview] = useState<{ uri: string; durationMs: number } | null>(null);
  /** Which note the shared player currently holds: a message id, or 'preview'. */
  const [loadedNote, setLoadedNote] = useState<string | null>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const player = useAudioPlayer();
  const playback = useAudioPlayerStatus(player);
  const recordStartedAt = useRef<number>(0);

  const load = useCallback(async () => {
    const result = await api.messagesWith(partner.accountId);
    if (result.ok) {
      setMessages(result.value);
      // Read what is on screen. Fire and forget; a failed mark-read self-heals
      // on the next poll.
      void api.markRead(partner.accountId);
    } else if (result.status !== 'network') {
      setError(result.error);
    }
  }, [api, partner.accountId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const sendText = useCallback(async () => {
    const body = draft.trim();
    if (body.length === 0 || sending) return;
    setSending(true);
    setError(null);
    // Cleared BEFORE the request resolves so a slow network cannot eat a
    // second tap into a duplicate; restored on failure so nothing is lost.
    setDraft('');
    const result = await api.sendText(partner.accountId, body);
    if (!result.ok) {
      setDraft(body);
      setError(result.error);
    } else {
      await load();
    }
    setSending(false);
  }, [api, draft, load, partner.accountId, sending]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError('Microphone access is needed for voice notes.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordStartedAt.current = Date.now();
      setRecordSeconds(0);
      setRecording(true);
    } catch {
      setError('Recording is unavailable. If this app was installed a while ago, install the newest build.');
    }
  }, [recorder]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(
      () => setRecordSeconds(Math.round((Date.now() - recordStartedAt.current) / 1000)),
      500,
    );
    return () => clearInterval(timer);
  }, [recording]);

  /** Stop: the note goes to PREVIEW, never straight out. */
  const stopRecording = useCallback(async () => {
    setRecording(false);
    const durationMs = Date.now() - recordStartedAt.current;
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (uri === null || durationMs < 500) {
        setError(durationMs < 500 ? 'That was too short to keep.' : 'Nothing was recorded.');
        return;
      }
      if (durationMs > 120_000) {
        setError('Voice notes can be up to two minutes.');
        return;
      }
      setPreview({ uri, durationMs });
    } catch {
      setError('That recording could not be kept.');
    }
  }, [recorder]);

  /** Cancel while recording: nothing is kept, nothing is sent. */
  const cancelRecording = useCallback(async () => {
    setRecording(false);
    try {
      await recorder.stop();
    } catch {
      // Nothing to keep either way.
    }
  }, [recorder]);

  const discardPreview = useCallback(() => {
    if (loadedNote === 'preview') {
      try {
        player.pause();
      } catch {
        // Already stopped.
      }
      setLoadedNote(null);
    }
    setPreview(null);
  }, [loadedNote, player]);

  const sendPreview = useCallback(async () => {
    if (preview === null || sending) return;
    setSending(true);
    setError(null);
    try {
      const audioBase64 = await new File(preview.uri).base64();
      const result = await api.sendVoice(partner.accountId, audioBase64, preview.durationMs);
      if (!result.ok) setError(result.error);
      else {
        discardPreview();
        await load();
      }
    } catch {
      setError('That voice note could not be sent.');
    } finally {
      setSending(false);
    }
  }, [api, discardPreview, load, partner.accountId, preview, sending]);

  /** Load a source into the shared player and play; a second tap pauses/resumes. */
  const togglePlayback = useCallback(
    async (noteId: string, source: () => Promise<string | null>) => {
      try {
        if (loadedNote === noteId) {
          if (playback.playing) player.pause();
          else player.play();
          return;
        }
        const uri = await source();
        if (uri === null) {
          setError('That voice note could not be fetched.');
          return;
        }
        player.replace({ uri });
        setLoadedNote(noteId);
        player.play();
      } catch {
        setError('Playback failed on this device.');
      }
    },
    [loadedNote, playback.playing, player],
  );

  const seekLoaded = useCallback(
    (fraction: number) => {
      if (!playback.isLoaded || playback.duration <= 0) return;
      void player.seekTo(Math.max(0, Math.min(playback.duration, fraction * playback.duration)));
    },
    [playback.duration, playback.isLoaded, player],
  );

  const clock = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  const name = partner.displayName ?? partner.username ?? partner.accountId;
  const bottomInset = useBottomInset();
  /** Per-conversation translation mode; normal is the free default. */
  const [mode, setMode] = useState<'normal' | 'translated'>('normal');
  /** Message ids whose ORIGINAL the reader asked to see. */
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void api.conversationMode(partner.accountId).then((result) => {
      if (!cancelled && result.ok) setMode(result.value.mode);
    });
    return () => {
      cancelled = true;
    };
  }, [api, partner.accountId]);

  const toggleMode = useCallback(async () => {
    const next = mode === 'translated' ? 'normal' : 'translated';
    setMode(next);
    const result = await api.setConversationMode(partner.accountId, next);
    if (!result.ok) {
      setMode(mode);
      setError('The mode could not be changed. Try again.');
    }
  }, [api, mode, partner.accountId]);

  const timeOf = (atMs: number): string =>
    new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayOf = (atMs: number): string => {
    const day = new Date(atMs);
    const now = new Date();
    const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOf(now) - startOf(day)) / 86_400_000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return day.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const canSend = draft.trim().length > 0 && !sending;

  return (
    <View style={styles.fill}>
      <C7Ground />
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} style={styles.back}>
            <Icon name="chevron" size={22} color={C7.text} />
          </Pressable>
          <Pressable onPress={() => onOpenPerson(partner)} accessibilityRole="button" accessibilityLabel={`Open ${name}'s profile`} style={styles.headerPerson}>
            <AvatarView accountId={partner.accountId} name={name} size={40} />
            <View style={styles.headerIdentity}>
              <Text style={styles.headerName} numberOfLines={1}>
                {name}
              </Text>
              {partner.username !== null && (
                <Text style={styles.headerHandle} numberOfLines={1}>
                  @{partner.username}
                </Text>
              )}
            </View>
          </Pressable>
          <Chip label={mode === 'translated' ? 'Translating' : 'Translate'} active={mode === 'translated'} onPress={() => void toggleMode()} />
          <Pressable onPress={() => onCall(partner)} accessibilityRole="button" accessibilityLabel="Call" style={({ pressed }) => [styles.headerCall, pressed && styles.pressed]}>
            <Icon name="phone" size={20} color={C7.teal} />
          </Pressable>
        </View>

        <FlatList
          style={styles.fill}
          inverted
          data={messages}
          keyExtractor={(item) => (item.kind === 'call' ? `call:${item.callId}` : item.messageId)}
          contentContainerStyle={styles.messages}
          renderItem={({ item, index }) => {
            /*
             * The list is inverted (newest first), so the OLDER neighbour is at
             * index + 1. A day chip belongs above the first message of each day.
             */
            const older = messages[index + 1];
            const firstOfDay =
              older === undefined ||
              new Date(older.createdAtMs).toDateString() !== new Date(item.createdAtMs).toDateString();
            const dayChip = firstOfDay ? (
              <View style={styles.dayChip}>
                <Text style={styles.dayChipText}>{dayOf(item.createdAtMs)}</Text>
              </View>
            ) : null;
            if (item.kind === 'call') {
              const words = callHistoryWords(item);
              return (
                <View>
                  {dayChip}
                  <View style={styles.callRow}>
                    <View style={[styles.callIcon, words.missed && styles.callIconMissed]}>
                      <Icon name={words.missed ? 'phone-missed' : item.direction === 'outgoing' ? 'phone-out' : 'phone-in'} size={18} color={words.missed ? C7.red : C7.teal} />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={[styles.callTitle, words.missed && styles.callMissed]}>{words.title}</Text>
                      <Text style={styles.callDetail}>
                        {words.detail === null ? timeOf(item.createdAtMs) : `${words.detail} · ${timeOf(item.createdAtMs)}`}
                      </Text>
                    </View>
                    <Pressable onPress={() => onCall(partner)} accessibilityRole="button" style={({ pressed }) => [styles.callBack, pressed && styles.pressed]}>
                      <Text style={styles.callBackLabel}>Call back</Text>
                    </Pressable>
                  </View>
                </View>
              );
            }
            const mine = item.senderId === selfId;
            const showTranslation = item.translatedBody != null && !revealed.has(item.messageId);
            return (
              <View>
                {dayChip}
                <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
                  <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                    {item.kind === 'voice' ? (
                      <VoiceNoteBubble
                        mine={mine}
                        loaded={loadedNote === item.messageId}
                        playing={loadedNote === item.messageId && playback.playing}
                        positionSeconds={loadedNote === item.messageId ? playback.currentTime : 0}
                        durationSeconds={
                          loadedNote === item.messageId && playback.duration > 0
                            ? playback.duration
                            : (item.mediaDurationMs ?? 0) / 1000
                        }
                        onToggle={() => void togglePlayback(item.messageId, () => fetchVoiceNoteAsDataUri(authorizedFetch, item.messageId))}
                        onSeek={seekLoaded}
                        clock={clock}
                      />
                    ) : (
                      <>
                        <Text style={[styles.body, mine && styles.mineText]}>{showTranslation ? item.translatedBody : item.body}</Text>
                        {item.translatedBody != null && (
                          <Pressable
                            onPress={() =>
                              setRevealed((current) => {
                                const next = new Set(current);
                                if (next.has(item.messageId)) next.delete(item.messageId);
                                else next.add(item.messageId);
                                return next;
                              })
                            }
                            accessibilityRole="button"
                            style={styles.translatedTag}
                          >
                            <Icon name="translate" size={12} color={mine ? 'rgba(7,11,18,0.7)' : C7.teal} />
                            <Text style={[styles.revealLabel, mine && styles.mineMeta]}>
                              {revealed.has(item.messageId) ? 'Original · show translation' : `Translated${item.translatedLanguage ? ` to ${item.translatedLanguage.toUpperCase()}` : ''} · show original`}
                            </Text>
                          </Pressable>
                        )}
                      </>
                    )}
                    <View style={styles.metaRow}>
                      <Text style={[styles.metaText, mine && styles.mineMeta]}>{timeOf(item.createdAtMs)}</Text>
                      {mine ? (
                        <Text style={[styles.metaText, mine && styles.mineMeta, item.readAtMs !== null && styles.readTicks]}>
                          {item.readAtMs !== null ? '✓✓' : '✓'}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                </View>
              </View>
            );
          }}
        />

        {error !== null && (
          <View style={styles.error}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.composerWrap}>
          {recording ? (
            <View style={styles.composer}>
              <Pressable onPress={() => void cancelRecording()} accessibilityRole="button" style={styles.quietAction}>
                <Text style={styles.quietActionLabel}>Cancel</Text>
              </Pressable>
              <View style={styles.recordingMeter}>
                <View style={styles.recordingDot} />
                <Text style={styles.recordingText}>Recording · {clock(recordSeconds)}</Text>
              </View>
              <Pressable onPress={() => void stopRecording()} accessibilityRole="button" accessibilityLabel="Stop recording" style={[styles.roundButton, styles.stopButton]}>
                <View style={styles.stopSquare} />
              </Pressable>
            </View>
          ) : preview !== null ? (
            <View style={styles.composer}>
              <Pressable onPress={discardPreview} accessibilityRole="button" accessibilityLabel="Delete recording" style={styles.quietAction}>
                <Text style={[styles.quietActionLabel, { color: C7.red }]}>Delete</Text>
              </Pressable>
              <View style={styles.previewBox}>
                <VoiceNoteBubble
                  mine={false}
                  compact
                  loaded={loadedNote === 'preview'}
                  playing={loadedNote === 'preview' && playback.playing}
                  positionSeconds={loadedNote === 'preview' ? playback.currentTime : 0}
                  durationSeconds={loadedNote === 'preview' && playback.duration > 0 ? playback.duration : preview.durationMs / 1000}
                  onToggle={() => void togglePlayback('preview', async () => preview.uri)}
                  onSeek={seekLoaded}
                  clock={clock}
                />
              </View>
              <Pressable onPress={() => void sendPreview()} disabled={sending} accessibilityRole="button" accessibilityLabel="Send voice note" style={[styles.roundButton, styles.sendButton, sending && styles.sendDisabled]}>
                {sending ? <ActivityIndicator color={C7.ground} size="small" /> : <Icon name="chevron" size={22} color={C7.ground} strokeWidth={2.2} />}
              </Pressable>
            </View>
          ) : (
            <View style={styles.composer}>
              <Pressable
                onPress={() => void startRecording()}
                accessibilityRole="button"
                accessibilityLabel="Record a voice note"
                style={styles.roundButton}
              >
                <Icon name="mic" size={22} color={C7.text} />
              </Pressable>
              <TextInput
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                placeholder="Message"
                placeholderTextColor={C7.faint}
                multiline
              />
              <Pressable
                onPress={() => void sendText()}
                disabled={!canSend}
                accessibilityRole="button"
                accessibilityLabel="Send"
                style={[styles.roundButton, styles.sendButton, !canSend && styles.sendDisabled]}
              >
                {sending ? <ActivityIndicator color={C7.ground} size="small" /> : <Icon name="chevron" size={22} color={C7.ground} strokeWidth={2.2} />}
              </Pressable>
            </View>
          )}
          <Text style={[styles.footer, { paddingBottom: bottomInset + 6 }]}>
            {mode === 'translated'
              ? 'Translated · messages arrive in each reader’s language'
              : 'Normal · messages are free and not translated'}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/** A voice note with real playback state: play/pause, a seekable bar, position / duration. */
function VoiceNoteBubble({
  mine,
  compact = false,
  loaded,
  playing,
  positionSeconds,
  durationSeconds,
  onToggle,
  onSeek,
  clock,
}: {
  readonly mine: boolean;
  readonly compact?: boolean;
  readonly loaded: boolean;
  readonly playing: boolean;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly onToggle: () => void;
  readonly onSeek: (fraction: number) => void;
  readonly clock: (seconds: number) => string;
}): JSX.Element {
  const fraction = durationSeconds > 0 ? Math.min(1, positionSeconds / durationSeconds) : 0;
  return (
    <View style={[styles.voiceRow, compact && { gap: 8 }]}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityLabel={playing ? 'Pause' : 'Play'} style={[styles.voicePlay, mine && styles.voicePlayMine]}>
        {playing ? (
          <View style={styles.pauseBars}>
            <View style={[styles.pauseBar, mine && styles.pauseBarMine]} />
            <View style={[styles.pauseBar, mine && styles.pauseBarMine]} />
          </View>
        ) : (
          <Text style={[styles.voiceGlyph, mine && styles.mineText]}>▶</Text>
        )}
      </Pressable>
      <View style={{ flex: 1, gap: 4, minWidth: compact ? 120 : 150 }}>
        <Pressable
          accessibilityRole="adjustable"
          accessibilityLabel="Seek"
          onPress={(event) => {
            const { locationX } = event.nativeEvent;
            const width = (event.currentTarget as unknown as { _width?: number })._width;
            // Width is measured on layout below; before that a tap seeks to the start.
            onSeek(width && width > 0 ? locationX / width : 0);
          }}
          onLayout={(event) => {
            (event.currentTarget as unknown as { _width?: number })._width = event.nativeEvent.layout.width;
          }}
          style={styles.progressTrack}
        >
          <View style={[styles.progressFill, mine && styles.progressFillMine, { width: `${Math.round(fraction * 100)}%` }]} />
        </Pressable>
        <Text style={[styles.voiceLabel, mine && styles.mineText]}>
          {loaded ? `${clock(positionSeconds)} / ${clock(durationSeconds)}` : clock(durationSeconds)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 50,
    paddingBottom: 12,
    paddingHorizontal: 12,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: C7.panelEdge,
  },
  back: { transform: [{ rotate: '180deg' }], padding: 4 },
  headerPerson: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerIdentity: { flex: 1, gap: 1 },
  headerName: { color: C7.text, fontSize: 18, fontWeight: '600', fontFamily: 'serif' },
  headerHandle: { color: C7.muted, fontSize: 12 },
  headerCall: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(62,201,192,0.45)',
    backgroundColor: C7.tealSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },

  messages: { paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  dayChip: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: C7.panelEdge,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 3,
    marginVertical: 8,
  },
  dayChipText: { color: C7.muted, fontSize: 11 },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowTheirs: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '82%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, gap: 4 },
  mine: { backgroundColor: C7.teal, borderBottomRightRadius: 6 },
  theirs: { backgroundColor: 'rgba(14, 22, 36, 0.9)', borderWidth: 1, borderColor: C7.panelEdge, borderBottomLeftRadius: 6 },
  body: { color: C7.text, fontSize: 15.5, lineHeight: 21 },
  mineText: { color: C7.ground },
  translatedTag: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  revealLabel: { fontSize: 11, color: C7.teal },
  metaRow: { flexDirection: 'row', gap: 4, alignSelf: 'flex-end', marginTop: 2 },
  metaText: { fontSize: 10, color: C7.muted },
  mineMeta: { color: 'rgba(7,11,18,0.6)' },
  readTicks: { color: '#0b4f4a', fontWeight: '700' },

  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  voicePlay: { width: 34, height: 34, borderRadius: 17, backgroundColor: C7.tealSoft, alignItems: 'center', justifyContent: 'center' },
  voicePlayMine: { backgroundColor: 'rgba(7,11,18,0.15)' },
  voiceGlyph: { color: C7.teal, fontSize: 14 },
  pauseBars: { flexDirection: 'row', gap: 3 },
  pauseBar: { width: 3, height: 14, borderRadius: 1.5, backgroundColor: C7.teal },
  pauseBarMine: { backgroundColor: C7.ground },
  progressTrack: { height: 14, justifyContent: 'center' },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: C7.teal, minWidth: 4 },
  progressFillMine: { backgroundColor: 'rgba(7,11,18,0.6)' },
  voiceLabel: { color: C7.text, fontSize: 12 },
  recordingMeter: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 46 },
  recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C7.red },
  recordingText: { color: C7.text, fontSize: 15, fontWeight: '600' },
  stopButton: { backgroundColor: 'rgba(224,69,58,0.18)', borderColor: C7.red },
  stopSquare: { width: 16, height: 16, borderRadius: 3, backgroundColor: C7.red },
  previewBox: { flex: 1, backgroundColor: 'rgba(14,22,36,0.9)', borderWidth: 1, borderColor: C7.panelEdge, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 },
  quietAction: { paddingHorizontal: 8, paddingVertical: 12 },
  quietActionLabel: { color: C7.muted, fontSize: 14, fontWeight: '600' },

  callRow: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginVertical: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: 'rgba(14, 22, 36, 0.9)',
    borderWidth: 1,
    borderColor: C7.panelEdge,
    minWidth: 260,
  },
  callIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: C7.tealSoft, alignItems: 'center', justifyContent: 'center' },
  callIconMissed: { backgroundColor: 'rgba(224,69,58,0.14)' },
  callTitle: { color: C7.text, fontSize: 14, fontWeight: '600' },
  callMissed: { color: C7.red },
  callDetail: { color: C7.muted, fontSize: 11 },
  callBack: { borderRadius: 999, borderWidth: 1, borderColor: 'rgba(62,201,192,0.45)', paddingHorizontal: 12, paddingVertical: 6 },
  callBackLabel: { color: C7.teal, fontSize: 12, fontWeight: '700' },

  error: {
    marginHorizontal: 14,
    marginBottom: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#4a2620',
    backgroundColor: 'rgba(29,18,16,0.9)',
    padding: 10,
  },
  errorText: { color: '#e06c5b', fontSize: 12 },

  composerWrap: { borderTopWidth: 1, borderTopColor: C7.panelEdge, backgroundColor: 'rgba(7,11,18,0.85)' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 10 },
  roundButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: C7.panelEdge,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundButtonRecording: { backgroundColor: 'rgba(224,69,58,0.2)', borderColor: C7.red },
  recordingLabel: { color: C7.red, fontSize: 12, fontWeight: '700' },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 46,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: C7.panelEdge,
    borderRadius: 23,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: C7.text,
    fontSize: 15.5,
  },
  sendButton: { backgroundColor: C7.teal, borderColor: C7.teal },
  sendDisabled: { opacity: 0.4 },
  footer: { color: C7.faint, fontSize: 11, textAlign: 'center', paddingTop: 8 },
});
