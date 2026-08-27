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
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
} from 'expo-audio';
import { File } from 'expo-file-system';
import type { Api, ContactPerson, WireMessage } from '../api/client';
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
  const [messages, setMessages] = useState<readonly WireMessage[]>([]);
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
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setError('Microphone access is needed for voice notes.');
      return;
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordStartedAt.current = Date.now();
      setRecordSeconds(0);
      setRecording(true);
    } catch {
      setError('Recording could not start on this device.');
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

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button" style={styles.headerButton}>
          <Text style={styles.headerAction}>{'‹'} Back</Text>
        </Pressable>
        <Text style={styles.headerName} numberOfLines={1}>
          {name}
        </Text>
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
        keyExtractor={(message) => message.messageId}
        contentContainerStyle={styles.messages}
        renderItem={({ item }) => {
          const mine = item.senderId === selfId;
          return (
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
                <Text style={[styles.body, mine && styles.mineText]}>{item.body}</Text>
              )}
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
          onPressOut={() => void stopAndSend()}
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
      <Text style={styles.footer}>Normal mode - messages are free and not translated.</Text>
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
  headerName: { flex: 1, color: '#e4ebf1', fontSize: 17, fontWeight: '600', textAlign: 'center' },

  messages: { paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  bubble: { maxWidth: '80%', borderRadius: 14, paddingHorizontal: 13, paddingVertical: 9 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#3ec9c0' },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#161d25' },
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
