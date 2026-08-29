/** @author masterzee001 */
/**
 * What you can do with a message, from a long press.
 *
 * THE WORDS MEAN WHAT THE SERVER DOES (founder ruling 29 Aug):
 *   Reply      quotes it above your next message
 *   Copy       the text to the clipboard
 *   Forward    a new message from you, carrying where it came from
 *   Share      the OS share sheet
 *   Edit       yours, text, within fifteen minutes; keeps an "edited" mark
 *   Unsend     removes it for both; "Message was removed" stays behind
 *   Delete for me   hides it for you alone, with an Undo
 * Only the actions the server would accept are shown.
 */
import { type JSX } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { C7 } from '../ui/c7';
import { Icon, type IconName } from '../ui/icons';

export type MessageAction = 'reply' | 'copy' | 'forward' | 'share' | 'edit' | 'retract' | 'hide' | 'pin' | 'unpin';

const REACTIONS = ['👍', '❤️', '😂', '🙏', '🔥', '👏'] as const;

export function MessageActionSheet({
  visible,
  actions,
  pinned,
  myReaction,
  onAction,
  onReact,
  onClose,
}: {
  readonly visible: boolean;
  readonly actions: readonly MessageAction[];
  readonly pinned: boolean;
  readonly myReaction: string | null;
  readonly onAction: (action: MessageAction) => void;
  readonly onReact: (emoji: string | null) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const rows: { action: MessageAction; label: string; icon: IconName; danger?: boolean }[] = [
    { action: 'reply', label: 'Reply', icon: 'message' },
    { action: 'copy', label: 'Copy', icon: 'share' },
    { action: 'forward', label: 'Forward', icon: 'phone-out' },
    { action: 'share', label: 'Share', icon: 'share' },
    { action: pinned ? 'unpin' : 'pin', label: pinned ? 'Unpin' : 'Pin', icon: 'programmes' },
    { action: 'edit', label: 'Edit', icon: 'gear' },
    { action: 'retract', label: 'Unsend', icon: 'close', danger: true },
    { action: 'hide', label: 'Delete for me', icon: 'close', danger: true },
  ];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.handle} />
          <View style={styles.reactions}>
            {REACTIONS.map((emoji) => (
              <Pressable
                key={emoji}
                onPress={() => onReact(myReaction === emoji ? null : emoji)}
                accessibilityRole="button"
                accessibilityLabel={`React ${emoji}`}
                style={[styles.reaction, myReaction === emoji && styles.reactionMine]}
              >
                <Text style={styles.reactionText}>{emoji}</Text>
              </Pressable>
            ))}
          </View>
          {rows
            .filter((row) => actions.includes(row.action))
            .map((row) => (
              <Pressable key={row.action} onPress={() => onAction(row.action)} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                <Icon name={row.icon} size={20} color={row.danger ? C7.red : C7.text} />
                <Text style={[styles.label, row.danger && styles.danger]}>{row.label}</Text>
              </Pressable>
            ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#0e1826', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 28, paddingTop: 8, borderWidth: 1, borderColor: C7.panelEdge },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)', marginBottom: 10 },
  reactions: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C7.panelEdge },
  reaction: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  reactionMine: { backgroundColor: C7.tealSoft, borderWidth: 1, borderColor: C7.teal },
  reactionText: { fontSize: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 22, paddingVertical: 14 },
  pressed: { backgroundColor: 'rgba(255,255,255,0.04)' },
  label: { color: C7.text, fontSize: 16 },
  danger: { color: C7.red },
});
