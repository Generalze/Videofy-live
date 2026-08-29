/** @author masterzee001 */
/**
 * One conversation: text, voice notes, and a call button.
 *
 * NORMAL MODE, AND THE SCREEN SAYS SO ONCE. Nothing here translates and
 * nothing here charges -- that is the product rule (translation is the billable
 * unit, and it is not in this build), stated in a footer line rather than
 * implied by absence.
 *
 * THE LIST IS INVERTED. Chat reads bottom-up: the newest message sits at the
 * keyboard edge, history loads upward. FlatList's `inverted` gives that for
 * free, at the price of the data array being newest-first -- which is exactly
 * the order the server already returns, so nothing is re-sorted anywhere.
 *
 * VOICE NOTES HOLD THE RECORDER, NOT THE TRANSCRIPT. Recording uses
 * expo-audio's hook; the file is read back as base64 and posted through the
 * same JSON path as everything else. Playback fetches through authorizedFetch
 * into a data URI, so the credential never leaves the session layer and the
 * player never needs to know the route is protected.
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
      /*
       * INSIDE the try, deliberately: on a build whose APK predates the
       * expo-audio native module, this call is the first to hit the missing
       * binary, and outside a catch it became a silent unhandled rejection
       * -- 'recording not working' with no diagnostic, on a real phone.
       */
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setError('Microphone access is needed for voice notes.');
        return;
      }
      // allowsRecording is an iOS-only field in this expo-audio release; the
      // Android gate is the RECORD_AUDIO permission requested above.
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
    return day.toDateString().slice(0, 10);
  };

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button" style={styles.headerButton}>
          <Text style={styles.headerAction}>{'‹'} Back</Text>
        </Pressable>
        <View style={styles.headerIdentity}>
          <AvatarView accountId={partner.accountId} name={name} size={30} />
          <Text style={styles.headerName} numberOfLines={1}>
            {name}
          </Text>
        </View>
        <Pressable
          onPress={() => void toggleMode()}
          accessibilityRole="button"
          style={[styles.modePill, mode === 'translated' && styles.modePillOn]}
        >
          <Text style={[styles.modePillLabel, mode === 'translated' && styles.modePillLabelOn]}>
            {mode === 'translated' ? 'Translating' : 'Translate'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => onCall(partner)}
          accessibilityRole="button"
          style={styles.headerButton}
        >
          <Text style={styles.headerAction}>Call</Text>
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
           * index + 1. A day chip belongs above the first message of each day
           * -- the one whose older neighbour is missing or from another day.
           */
          const older = messages[index + 1];
          const firstOfDay =
            older === undefined ||
            new Date(older.createdAtMs).toDateString() !== new Date(item.createdAtMs).toDateString();
          if (item.kind === 'call') {
            // A CALL IN THE TIMELINE: centred, like a phone's log, with the
            // way back into a call one tap away.
            const words = callHistoryWords(item);
            return (
              <View>
                {firstOfDay ? (
                  <View style={styles.dayChip}>
                    <Text style={styles.dayChipText}>{dayOf(item.createdAtMs)}</Text>
                  </View>
                ) : null}
                <View style={styles.callRow}>
                  <Text style={[styles.callTitle, words.missed && styles.callMissed]}>
                    {`${item.direction === 'outgoing' ? '↗' : '↙'} ${words.title}`}
                  </Text>
                  <Text style={styles.callDetail}>
                    {words.detail === null ? timeOf(item.createdAtMs) : `${words.detail} · ${timeOf(item.createdAtMs)}`}
                  </Text>
                  <Pressable onPress={() => onCall(partner)} accessibilityRole="button">
                    <Text style={styles.callBack}>Call back</Text>
                  </Pressable>
                </View>
              </View>
            );
          }
          const mine = item.senderId === selfId;
          return (
            <View>
              {firstOfDay ? (
                <View style={styles.dayChip}>
                  <Text style={styles.dayChipText}>{dayOf(item.createdAtMs)}</Text>
                </View>
              ) : null}
            <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
              {item.kind === 'voice' ? (
                <Pressable
                  onPress={() => void play(item)}
                  accessibilityRole="button"
                  style={styles.voiceRow}
                >
                  {playingId === item.messageId ? (
                    <ActivityIndicator color={mine ? '#0b0f14' : '#3ec9c0'} size="small" />
                  ) : (
                    <Text style={[styles.voiceGlyph, mine && styles.mineText]}>{'▶'}</Text>
                  )}
                  <Text style={[styles.voiceLabel, mine && styles.mineText]}>
                    Voice note {formatDuration(item.mediaDurationMs)}
                  </Text>
                </Pressable>
              ) : (
                <>
                  <Text style={[styles.body, mine && styles.mineText]}>
                    {item.translatedBody != null && !revealed.has(item.messageId)
                      ? item.translatedBody
                      : item.body}
                  </Text>
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
                    >
                      <Text style={[styles.revealLabel, mine && styles.mineMeta]}>
                        {revealed.has(item.messageId)
                          ? 'original · show translation'
                          : 'translated · show original'}
                      </Text>
                    </Pressable>
                  )}
                </>
              )}
              <View style={styles.metaRow}>
                <Text style={[styles.metaText, mine && styles.mineMeta]}>{timeOf(item.createdAtMs)}</Text>
                {mine ? (
                  /* One tick: the server holds it. Two: they marked it read. */
                  <Text style={[styles.metaText, mine && styles.mineMeta, item.readAtMs !== null && styles.readTicks]}>
                    {item.readAtMs !== null ? '✓✓' : '✓'}
                  </Text>
                ) : null}
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

      <View style={styles.composer}>
        <Pressable
          onPressIn={() => void startRecording()}
          onPressOut={() => {
            if (recording) void stopAndSend();
          }}
          accessibilityRole="button"
          style={[styles.micButton, recording && styles.micActive]}
        >
          <Text style={styles.micLabel}>{recording ? `${recordSeconds}s` : 'Hold'}</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={recording ? 'Recording…' : 'Message'}
          placeholderTextColor="#4a545f"
          editable={!recording}
          multiline
        />
        <Pressable
          onPress={() => void sendText()}
          disabled={draft.trim().length === 0 || sending}
          accessibilityRole="button"
          style={[styles.sendButton, (draft.trim().length === 0 || sending) && styles.sendDisabled]}
        >
          {sending ? (
            <ActivityIndicator color="#0b0f14" size="small" />
          ) : (
            <Text style={styles.sendLabel}>Send</Text>
          )}
        </Pressable>
      </View>
      <Text style={[styles.footer, { paddingBottom: bottomInset }]}>
        {mode === 'translated'
          ? 'Translated mode - messages arrive in each reader’s language. Free during staging.'
          : 'Normal mode - messages are free and not translated.'}
      </Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#0b0f14' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 48,
    paddingBottom: 12,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#161d25',
    gap: 8,
  },
  headerButton: { paddingHorizontal: 8, paddingVertical: 4 },
  headerAction: { color: '#3ec9c0', fontSize: 15, fontWeight: '600' },
  headerName: { color: '#e4ebf1', fontSize: 17, fontWeight: '600', flexShrink: 1 },
  headerIdentity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  dayChip: {
    alignSelf: 'center',
    backgroundColor: '#141a21',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 3,
    marginVertical: 6,
  },
  dayChipText: { color: '#5d6874', fontSize: 11 },
  callRow: {
    alignSelf: 'center',
    alignItems: 'center',
    gap: 3,
    marginVertical: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: '#10161d',
    borderWidth: 1,
    borderColor: '#1c242d',
    minWidth: 200,
  },
  callTitle: { color: '#c9d3dc', fontSize: 13, fontWeight: '600' },
  callMissed: { color: '#e06c5b' },
  callDetail: { color: '#5d6874', fontSize: 11 },
  callBack: { color: '#3ec9c0', fontSize: 12, fontWeight: '700', marginTop: 4 },
  metaRow: { flexDirection: 'row', gap: 4, alignSelf: 'flex-end', marginTop: 2 },
  modePill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#273039',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  modePillOn: { borderColor: '#3ec9c0', backgroundColor: '#102a28' },
  modePillLabel: { color: '#8d99a6', fontSize: 12, fontWeight: '600' },
  modePillLabelOn: { color: '#3ec9c0' },
  revealLabel: { fontSize: 10, fontStyle: 'italic', color: '#5d6874', marginTop: 2 },
  metaText: { fontSize: 10, color: '#5d6874' },
  mineMeta: { color: 'rgba(11,15,20,0.55)' },
  readTicks: { color: '#0b4f4a', fontWeight: '700' },

  messages: { paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  bubble: { maxWidth: '80%', borderRadius: 14, paddingHorizontal: 13, paddingVertical: 9 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#3ec9c0', borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#161d25', borderBottomLeftRadius: 4 },
  body: { color: '#e4ebf1', fontSize: 15, lineHeight: 20 },
  mineText: { color: '#0b0f14' },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  voiceGlyph: { color: '#3ec9c0', fontSize: 14 },
  voiceLabel: { color: '#e4ebf1', fontSize: 14 },

  error: {
    marginHorizontal: 14,
    marginBottom: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#4a2620',
    backgroundColor: '#1d1210',
    padding: 10,
  },
  errorText: { color: '#e06c5b', fontSize: 12 },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#161d25',
  },
  micButton: {
    width: 52,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#141a21',
    borderWidth: 1,
    borderColor: '#273039',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micActive: { backgroundColor: '#3a1d18', borderColor: '#e06c5b' },
  micLabel: { color: '#8d99a6', fontSize: 12, fontWeight: '600' },
  input: {
    flex: 1,
    maxHeight: 110,
    backgroundColor: '#141a21',
    borderWidth: 1,
    borderColor: '#273039',
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 10,
    color: '#e4ebf1',
    fontSize: 15,
  },
  sendButton: {
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#3ec9c0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { backgroundColor: '#1f3a38' },
  sendLabel: { color: '#0b0f14', fontSize: 15, fontWeight: '700' },
  footer: { color: '#3a434d', fontSize: 11, textAlign: 'center', paddingVertical: 8 },
});
