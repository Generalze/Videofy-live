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
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
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
import { fetchTranslatedVoiceNoteAsDataUri, fetchVoiceNoteAsDataUri, formatDuration } from '../media/voiceNotes';
import { C7, C7Ground, Chip } from '../ui/c7';
import { Icon } from '../ui/icons';
import { MessageActionSheet, type MessageAction } from './MessageActionSheet';

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
   * MESSAGE ACTIONS (founder ruling 29 Aug). A long press opens the sheet;
   * the sheet offers only what the server would accept for THIS message.
   * Reply and Edit change the composer; Unsend and Delete-for-me change the
   * timeline through the server; Delete-for-me gets a few seconds of Undo.
   */
  const [sheetFor, setSheetFor] = useState<WireMessage | null>(null);
  const [replyTo, setReplyTo] = useState<WireMessage | null>(null);
  const [editing, setEditing] = useState<WireMessage | null>(null);
  const [undo, setUndo] = useState<{ messageId: string; until: number } | null>(null);
  const [forwarding, setForwarding] = useState<WireMessage | null>(null);
  const [contacts, setContacts] = useState<readonly ContactPerson[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode2, setMode2] = useState<'timeline' | 'search' | 'pinned'>('timeline');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<readonly WireMessage[] | null>(null);
  const [pinnedList, setPinnedList] = useState<readonly WireMessage[] | null>(null);
  const [settings, setSettings] = useState<{ muted: boolean; archived: boolean } | null>(null);
  /** A send that failed, kept so a tap can retry it rather than retyping. */
  const [failedSend, setFailedSend] = useState<{ body: string; replyToMessageId?: string } | null>(null);
  /** Which rendition a translated voice note plays: the derived audio, or the original. */
  const [playOriginal, setPlayOriginal] = useState<ReadonlySet<string>>(new Set());
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
    // second tap into a duplicate; a failure keeps it as a retry, not a loss.
    setDraft('');
    if (editing !== null) {
      const target = editing;
      setEditing(null);
      const result = await api.editMessage(target.messageId, body);
      if (!result.ok) {
        setDraft(body);
        setEditing(target);
        setError(result.status === 409 ? 'Edits are allowed for fifteen minutes after sending.' : result.error);
      } else {
        await load();
      }
      setSending(false);
      return;
    }
    const replyToMessageId = replyTo?.messageId;
    setReplyTo(null);
    const result = await api.sendText(partner.accountId, body, replyToMessageId);
    if (!result.ok) {
      setFailedSend(replyToMessageId === undefined ? { body } : { body, replyToMessageId });
      setError(result.status === 'network' ? 'Not sent — no connection. Tap Retry.' : result.error);
    } else {
      setFailedSend(null);
      await load();
    }
    setSending(false);
  }, [api, draft, editing, load, partner.accountId, replyTo, sending]);

  const retryFailedSend = useCallback(async () => {
    if (failedSend === null || sending) return;
    setSending(true);
    const result = await api.sendText(partner.accountId, failedSend.body, failedSend.replyToMessageId);
    if (result.ok) {
      setFailedSend(null);
      setError(null);
      await load();
    } else {
      setError(result.status === 'network' ? 'Still no connection. Tap Retry.' : result.error);
    }
    setSending(false);
  }, [api, failedSend, load, partner.accountId, sending]);

  /* ---- the actions themselves ---- */
  const runAction = useCallback(
    async (message: WireMessage, action: MessageAction) => {
      setSheetFor(null);
      switch (action) {
        case 'reply':
          setEditing(null);
          setReplyTo(message);
          return;
        case 'copy':
          await Clipboard.setStringAsync(message.translatedBody ?? message.body ?? '');
          return;
        case 'share':
          await Share.share({ message: message.translatedBody ?? message.body ?? '' });
          return;
        case 'forward': {
          const list = await api.contacts();
          setContacts(list.ok ? list.value.contacts : []);
          setForwarding(message);
          return;
        }
        case 'edit':
          setReplyTo(null);
          setEditing(message);
          setDraft(message.body ?? '');
          return;
        case 'pin':
        case 'unpin': {
          const result = await api.pinMessage(message.messageId, action === 'pin');
          if (!result.ok) setError(result.error);
          await load();
          return;
        }
        case 'retract':
          Alert.alert('Unsend this message?', 'It is removed for both of you. "Message was removed" stays in its place.', [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Unsend',
              style: 'destructive',
              onPress: () => {
                void api.retractMessage(message.messageId).then(async (result) => {
                  if (!result.ok) setError(result.error);
                  await load();
                });
              },
            },
          ]);
          return;
        case 'hide': {
          const result = await api.hideMessage(message.messageId);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setUndo({ messageId: message.messageId, until: Date.now() + 6000 });
          await load();
          return;
        }
      }
    },
    [api, load],
  );

  const undoHide = useCallback(async () => {
    if (undo === null) return;
    const target = undo;
    setUndo(null);
    const result = await api.unhideMessage(target.messageId);
    if (!result.ok) setError(result.error);
    await load();
  }, [api, load, undo]);

  useEffect(() => {
    if (undo === null) return undefined;
    const timer = setTimeout(() => setUndo(null), Math.max(0, undo.until - Date.now()));
    return () => clearTimeout(timer);
  }, [undo]);

  const react = useCallback(
    async (message: WireMessage, emoji: string | null) => {
      setSheetFor(null);
      const result = await api.reactToMessage(message.messageId, emoji);
      if (!result.ok) setError(result.error);
      await load();
    },
    [api, load],
  );

  const forwardTo = useCallback(
    async (target: ContactPerson) => {
      if (forwarding === null) return;
      const message = forwarding;
      setForwarding(null);
      const result = await api.forwardMessage(target.accountId, message.messageId);
      if (!result.ok) setError(result.error);
      else setError(null);
    },
    [api, forwarding],
  );

  const actionsFor = useCallback(
    (message: WireMessage): MessageAction[] => {
      if (message.retractedAtMs != null) return ['hide'];
      const mine = message.senderId === selfId;
      const text = message.kind === 'text';
      const editable = mine && text && Date.now() - message.createdAtMs < 15 * 60 * 1000;
      return [
        'reply',
        ...(text ? (['copy', 'share'] as MessageAction[]) : []),
        'forward',
        message.pinnedByMe ? 'unpin' : 'pin',
        ...(editable ? (['edit'] as MessageAction[]) : []),
        ...(mine ? (['retract'] as MessageAction[]) : []),
        'hide',
      ];
    },
    [selfId],
  );

  /* ---- search, pinned, settings ---- */
  useEffect(() => {
    if (mode2 !== 'search') return undefined;
    const q = searchQuery.trim();
    if (q.length === 0) {
      setSearchResults(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      void api.searchMessages(partner.accountId, q).then((result) => setSearchResults(result.ok ? result.value : []));
    }, 300);
    return () => clearTimeout(timer);
  }, [api, mode2, partner.accountId, searchQuery]);

  useEffect(() => {
    if (mode2 !== 'pinned') return;
    void api.pinnedMessages(partner.accountId).then((result) => setPinnedList(result.ok ? result.value : []));
  }, [api, mode2, partner.accountId, messages]);

  useEffect(() => {
    void api.conversations().then((result) => {
      if (!result.ok) return;
      const entry = result.value.find((item) => item.partner.accountId === partner.accountId);
      setSettings({ muted: entry?.muted ?? false, archived: entry?.archived ?? false });
    });
  }, [api, partner.accountId]);

  const updateSettings = useCallback(
    async (next: { muted?: boolean; archived?: boolean }) => {
      setMenuOpen(false);
      const result = await api.conversationSettings(partner.accountId, next);
      if (result.ok) setSettings(result.value);
      else setError(result.error);
    },
    [api, partner.accountId],
  );

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
          <Pressable onPress={() => setMenuOpen((open) => !open)} accessibilityRole="button" accessibilityLabel="More" hitSlop={8} style={styles.headerMore}>
            <Icon name="more" size={20} color={C7.muted} />
          </Pressable>
        </View>
        {menuOpen && (
          <View style={styles.menu}>
            <Pressable onPress={() => { setMenuOpen(false); setMode2(mode2 === 'search' ? 'timeline' : 'search'); }} accessibilityRole="button" style={styles.menuItem}>
              <Icon name="search" size={18} color={C7.text} />
              <Text style={styles.menuLabel}>{mode2 === 'search' ? 'Close search' : 'Search in conversation'}</Text>
            </Pressable>
            <Pressable onPress={() => { setMenuOpen(false); setMode2(mode2 === 'pinned' ? 'timeline' : 'pinned'); }} accessibilityRole="button" style={styles.menuItem}>
              <Icon name="programmes" size={18} color={C7.text} />
              <Text style={styles.menuLabel}>{mode2 === 'pinned' ? 'Back to messages' : 'Pinned messages'}</Text>
            </Pressable>
            <Pressable onPress={() => void updateSettings({ muted: !(settings?.muted ?? false) })} accessibilityRole="button" style={styles.menuItem}>
              <Icon name="bell" size={18} color={C7.text} />
              <Text style={styles.menuLabel}>{settings?.muted ? 'Unmute' : 'Mute notifications'}</Text>
            </Pressable>
            <Pressable onPress={() => void updateSettings({ archived: !(settings?.archived ?? false) })} accessibilityRole="button" style={styles.menuItem}>
              <Icon name="lock" size={18} color={C7.text} />
              <Text style={styles.menuLabel}>{settings?.archived ? 'Unarchive' : 'Archive conversation'}</Text>
            </Pressable>
          </View>
        )}
        {mode2 === 'search' && (
          <View style={styles.searchBar}>
            <Icon name="search" size={18} color={C7.muted} />
            <TextInput style={styles.searchInput} value={searchQuery} onChangeText={setSearchQuery} placeholder="Search this conversation" placeholderTextColor={C7.faint} autoFocus />
            <Pressable onPress={() => { setMode2('timeline'); setSearchQuery(''); }} accessibilityRole="button" accessibilityLabel="Close search" hitSlop={8}>
              <Icon name="close" size={16} color={C7.muted} />
            </Pressable>
          </View>
        )}
        {mode2 === 'pinned' && (
          <View style={styles.searchBar}>
            <Icon name="programmes" size={18} color={C7.teal} />
            <Text style={[styles.searchInput, { color: C7.muted }]}>{pinnedList === null ? 'Pinned messages' : `${pinnedList.length} pinned`}</Text>
            <Pressable onPress={() => setMode2('timeline')} accessibilityRole="button" accessibilityLabel="Back to messages" hitSlop={8}>
              <Icon name="close" size={16} color={C7.muted} />
            </Pressable>
          </View>
        )}

        <FlatList
          style={styles.fill}
          inverted
          data={mode2 === 'search' ? (searchResults ?? []) : mode2 === 'pinned' ? (pinnedList ?? []) : messages}
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
            const retracted = item.retractedAtMs != null;
            const translatedVoice = item.kind === 'voice' && item.translatedAudioAvailable === true;
            const useOriginal = !translatedVoice || playOriginal.has(item.messageId);
            const noteKey = useOriginal ? item.messageId : `${item.messageId}:translated`;
            const noteDurationMs = useOriginal ? (item.mediaDurationMs ?? 0) : (item.translatedDurationMs ?? item.mediaDurationMs ?? 0);
            return (
              <View>
                {dayChip}
                <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
                  <Pressable onLongPress={() => setSheetFor(item)} delayLongPress={280} style={[styles.bubble, mine ? styles.mine : styles.theirs, retracted && styles.retracted]}>
                    {item.replyTo != null && (
                      <View style={[styles.quote, mine && styles.quoteMine]}>
                        <Text style={[styles.quoteWho, mine && styles.mineMeta]}>{item.replyTo.senderId === selfId ? 'You' : name}</Text>
                        <Text style={[styles.quoteText, mine && styles.mineText]} numberOfLines={2}>{item.replyTo.preview}</Text>
                      </View>
                    )}
                    {item.forwardedFrom != null && (
                      <Text style={[styles.forwarded, mine && styles.mineMeta]}>↪ Forwarded</Text>
                    )}
                    {retracted ? (
                      <Text style={[styles.retractedText, mine && styles.mineMeta]}>Message was removed</Text>
                    ) : item.kind === 'voice' ? (
                      <>
                        {translatedVoice && (
                          <View style={styles.voiceChoice}>
                            <Pressable onPress={() => setPlayOriginal((current) => { const next = new Set(current); next.delete(item.messageId); return next; })} accessibilityRole="button">
                              <Text style={[styles.voiceChoiceLabel, !useOriginal && styles.voiceChoiceOn, mine && styles.mineMeta]}>Translated ▶</Text>
                            </Pressable>
                            <Pressable onPress={() => setPlayOriginal((current) => new Set(current).add(item.messageId))} accessibilityRole="button">
                              <Text style={[styles.voiceChoiceLabel, useOriginal && styles.voiceChoiceOn, mine && styles.mineMeta]}>Original</Text>
                            </Pressable>
                          </View>
                        )}
                        <VoiceNoteBubble
                          mine={mine}
                          loaded={loadedNote === noteKey}
                          playing={loadedNote === noteKey && playback.playing}
                          positionSeconds={loadedNote === noteKey ? playback.currentTime : 0}
                          durationSeconds={loadedNote === noteKey && playback.duration > 0 ? playback.duration : noteDurationMs / 1000}
                          onToggle={() =>
                            void togglePlayback(noteKey, () =>
                              useOriginal
                                ? fetchVoiceNoteAsDataUri(authorizedFetch, item.messageId)
                                : fetchTranslatedVoiceNoteAsDataUri(authorizedFetch, item.messageId),
                            )
                          }
                          onSeek={seekLoaded}
                          clock={clock}
                        />
                        {translatedVoice && !useOriginal && item.translatedBody != null && (
                          <Text style={[styles.voiceTranscript, mine && styles.mineMeta]} numberOfLines={3}>{item.translatedBody}</Text>
                        )}
                      </>
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
                      {item.editedAtMs != null && !retracted && <Text style={[styles.metaText, mine && styles.mineMeta]}>edited ·</Text>}
                      <Text style={[styles.metaText, mine && styles.mineMeta]}>{timeOf(item.createdAtMs)}</Text>
                      {mine ? (
                        <Text style={[styles.metaText, mine && styles.mineMeta, item.readAtMs !== null && styles.readTicks]}>
                          {item.readAtMs !== null ? '✓✓' : '✓'}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                </View>
                {item.reactions !== undefined && item.reactions.length > 0 && (
                  <View style={[styles.reactionsRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
                    {item.reactions.map((reaction) => (
                      <Pressable key={reaction.emoji} onPress={() => void react(item, reaction.mine ? null : reaction.emoji)} accessibilityRole="button" style={[styles.reactionChip, reaction.mine && styles.reactionChipMine]}>
                        <Text style={styles.reactionChipText}>{reaction.emoji}{reaction.count > 1 ? ` ${reaction.count}` : ''}</Text>
                      </Pressable>
                    ))}
                  </View>
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

        {undo !== null && (
          <View style={styles.snackbar}>
            <Text style={styles.snackbarText}>Message deleted for you</Text>
            <Pressable onPress={() => void undoHide()} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.snackbarAction}>Undo</Text>
            </Pressable>
          </View>
        )}
        {failedSend !== null && (
          <View style={styles.snackbar}>
            <Text style={styles.snackbarText} numberOfLines={1}>Not sent: {failedSend.body}</Text>
            <Pressable onPress={() => void retryFailedSend()} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.snackbarAction}>{sending ? 'Sending…' : 'Retry'}</Text>
            </Pressable>
            <Pressable onPress={() => { setFailedSend(null); setError(null); }} accessibilityRole="button" accessibilityLabel="Discard" hitSlop={8}>
              <Icon name="close" size={16} color={C7.muted} />
            </Pressable>
          </View>
        )}
        <View style={styles.composerWrap}>
          {(replyTo !== null || editing !== null) && (
            <View style={styles.contextBar}>
              <View style={styles.contextAccent} />
              <View style={{ flex: 1 }}>
                <Text style={styles.contextWho}>{editing !== null ? 'Editing your message' : `Replying to ${replyTo?.senderId === selfId ? 'yourself' : name}`}</Text>
                {replyTo !== null && (
                  <Text style={styles.contextText} numberOfLines={1}>{replyTo.kind === 'voice' ? 'Voice note' : (replyTo.translatedBody ?? replyTo.body ?? '')}</Text>
                )}
              </View>
              <Pressable onPress={() => { setReplyTo(null); if (editing !== null) { setEditing(null); setDraft(''); } }} accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={8}>
                <Icon name="close" size={16} color={C7.muted} />
              </Pressable>
            </View>
          )}
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

      <MessageActionSheet
        visible={sheetFor !== null}
        actions={sheetFor === null ? [] : actionsFor(sheetFor)}
        pinned={sheetFor?.pinnedByMe === true}
        myReaction={sheetFor?.reactions?.find((r) => r.mine)?.emoji ?? null}
        onAction={(action) => { if (sheetFor !== null) void runAction(sheetFor, action); }}
        onReact={(emoji) => { if (sheetFor !== null) void react(sheetFor, emoji); }}
        onClose={() => setSheetFor(null)}
      />

      <Modal visible={forwarding !== null} transparent animationType="fade" onRequestClose={() => setForwarding(null)}>
        <Pressable style={styles.backdrop} onPress={() => setForwarding(null)}>
          <Pressable style={styles.pickerSheet} onPress={() => undefined}>
            <Text style={styles.pickerTitle}>Forward to</Text>
            {contacts === null && <ActivityIndicator color={C7.teal} />}
            {contacts !== null && contacts.length === 0 && <Text style={styles.pickerEmpty}>No contacts to forward to.</Text>}
            {contacts?.map((person) => (
              <Pressable key={person.accountId} onPress={() => void forwardTo(person)} accessibilityRole="button" style={styles.pickerRow}>
                <AvatarView accountId={person.accountId} name={person.displayName ?? person.username ?? person.accountId} size={36} />
                <Text style={styles.pickerName}>{person.displayName ?? person.username ?? person.accountId}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
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
  headerMore: { padding: 6 },
  menu: { position: 'absolute', right: 12, top: 96, zIndex: 20, elevation: 8, backgroundColor: '#0e1826', borderWidth: 1, borderColor: C7.panelEdge, borderRadius: 14, paddingVertical: 6, minWidth: 220 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
  menuLabel: { color: C7.text, fontSize: 14 },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 12, marginTop: 8, borderRadius: 999, borderWidth: 1, borderColor: C7.panelEdge, backgroundColor: 'rgba(255,255,255,0.04)', paddingHorizontal: 14 },
  searchInput: { flex: 1, color: C7.text, fontSize: 15, paddingVertical: 9 },
  retracted: { opacity: 0.6 },
  retractedText: { color: C7.muted, fontSize: 14, fontStyle: 'italic' },
  quote: { borderLeftWidth: 2, borderLeftColor: C7.teal, paddingLeft: 8, marginBottom: 4, gap: 1 },
  quoteMine: { borderLeftColor: 'rgba(7,11,18,0.5)' },
  quoteWho: { color: C7.teal, fontSize: 11, fontWeight: '700' },
  quoteText: { color: C7.muted, fontSize: 13 },
  forwarded: { color: C7.muted, fontSize: 11, fontStyle: 'italic', marginBottom: 2 },
  voiceChoice: { flexDirection: 'row', gap: 12, marginBottom: 4 },
  voiceChoiceLabel: { color: C7.muted, fontSize: 12 },
  voiceChoiceOn: { color: C7.teal, fontWeight: '700' },
  voiceTranscript: { color: C7.muted, fontSize: 12, fontStyle: 'italic', marginTop: 4 },
  reactionsRow: { flexDirection: 'row', gap: 4, marginTop: -2, paddingHorizontal: 6 },
  reactionChip: { borderRadius: 999, borderWidth: 1, borderColor: C7.panelEdge, backgroundColor: 'rgba(14,22,36,0.95)', paddingHorizontal: 8, paddingVertical: 2 },
  reactionChipMine: { borderColor: C7.teal, backgroundColor: C7.tealSoft },
  reactionChipText: { color: C7.text, fontSize: 12 },
  snackbar: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 14, marginBottom: 6, borderRadius: 12, backgroundColor: '#0e1826', borderWidth: 1, borderColor: C7.panelEdge, paddingHorizontal: 14, paddingVertical: 10 },
  snackbarText: { flex: 1, color: C7.text, fontSize: 13 },
  snackbarAction: { color: C7.teal, fontSize: 13, fontWeight: '700' },
  contextBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 8 },
  contextAccent: { width: 3, height: 32, borderRadius: 2, backgroundColor: C7.teal },
  contextWho: { color: C7.teal, fontSize: 12, fontWeight: '700' },
  contextText: { color: C7.muted, fontSize: 13 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  pickerSheet: { backgroundColor: '#0e1826', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 18, paddingBottom: 32, gap: 6, borderWidth: 1, borderColor: C7.panelEdge, maxHeight: '70%' },
  pickerTitle: { color: C7.text, fontSize: 18, fontWeight: '600', fontFamily: 'serif', marginBottom: 6 },
  pickerEmpty: { color: C7.muted, fontSize: 14 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  pickerName: { color: C7.text, fontSize: 16 },
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
