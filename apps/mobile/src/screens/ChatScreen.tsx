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
}

export function ChatScreen({
  api,
  authorizedFetch,
  selfId,
  partner,
  onBack,
  onCall,
}: ChatScreenProps): JSX.Element {
  const [messages, setMessages] = useState<readonly TimelineItem[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const player = useAudioPlayer();
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

  const stopAndSend = useCallback(async () => {
    setRecording(false);
    const durationMs = Date.now() - recordStartedAt.current;
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (uri === null || durationMs < 500) {
        setError(durationMs < 500 ? 'Hold to record a voice note.' : 'Nothing was recorded.');
        return;
      }
      if (durationMs > 120_000) {
        setError('Voice notes can be up to two minutes.');
        return;
      }
      setSending(true);
      const audioBase64 = await new File(uri).base64();
      const result = await api.sendVoice(partner.accountId, audioBase64, durationMs);
      if (!result.ok) setError(result.error);
      else await load();
    } catch {
      setError('That voice note could not be sent.');
    } finally {
      setSending(false);
    }
  }, [api, load, partner.accountId, recorder]);

  const play = useCallback(
    async (message: WireMessage) => {
      setPlayingId(message.messageId);
      const source = await fetchVoiceNoteAsDataUri(authorizedFetch, message.messageId);
      if (source === null) {
        setPlayingId(null);
        setError('That voice note could not be fetched.');
        return;
      }
      try {
        player.replace({ uri: source });
        player.play();
      } catch {
        setError('Playback failed on this device.');
      }
      setPlayingId(null);
    },
    [authorizedFetch, player],
  );

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
                      <Pressable onPress={() => void play(item)} accessibilityRole="button" style={styles.voiceRow}>
                        <View style={[styles.voicePlay, mine && styles.voicePlayMine]}>
                          {playingId === item.messageId ? (
                            <ActivityIndicator color={mine ? C7.ground : C7.teal} size="small" />
                          ) : (
                            <Text style={[styles.voiceGlyph, mine && styles.mineText]}>▶</Text>
                          )}
                        </View>
                        <View style={styles.voiceBars}>
                          {[6, 12, 9, 16, 8, 14, 7, 11].map((h, i) => (
                            <View key={i} style={[styles.voiceBar, { height: h }, mine && styles.voiceBarMine]} />
                          ))}
                        </View>
                        <Text style={[styles.voiceLabel, mine && styles.mineText]}>{formatDuration(item.mediaDurationMs)}</Text>
                      </Pressable>
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
          <View style={styles.composer}>
            <Pressable
              onPressIn={() => void startRecording()}
              onPressOut={() => {
                if (recording) void stopAndSend();
              }}
              accessibilityRole="button"
              accessibilityLabel="Hold to record a voice note"
              style={[styles.roundButton, recording && styles.roundButtonRecording]}
            >
              {recording ? <Text style={styles.recordingLabel}>{recordSeconds}s</Text> : <Icon name="mic" size={22} color={C7.text} />}
            </Pressable>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={recording ? 'Recording…' : 'Message'}
              placeholderTextColor={C7.faint}
              editable={!recording}
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
  voiceBars: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  voiceBar: { width: 3, borderRadius: 2, backgroundColor: 'rgba(62,201,192,0.7)' },
  voiceBarMine: { backgroundColor: 'rgba(7,11,18,0.5)' },
  voiceLabel: { color: C7.text, fontSize: 13 },

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
