/** @author masterzee001 */
/**
 * Report, in the app.
 *
 * A person reports a message or another person without leaving the
 * conversation: pick a reason, add a line if they want, send. What travels
 * is METADATA -- the account reported, the message id, the reason, the
 * person's own words -- never the message body or any audio; the team that
 * reads reports pulls the content by id with the authority to do so. A sent
 * report says so and closes; a failure says so and stays open to try again.
 */
import { useState, type JSX } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { C7, PrimaryButton } from '../ui/c7';

export const REPORT_REASONS = [
  ['spam', 'Spam or scam'],
  ['harassment', 'Harassment or threats'],
  ['hate', 'Hate or abuse'],
  ['sexual', 'Sexual content'],
  ['violence', 'Violence or danger'],
  ['impersonation', 'Pretending to be someone'],
  ['other', 'Something else'],
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number][0];

export function ReportSheet({
  visible,
  subjectName,
  aboutMessage,
  onSubmit,
  onClose,
}: {
  readonly visible: boolean;
  readonly subjectName: string;
  readonly aboutMessage: boolean;
  readonly onSubmit: (reason: ReportReason, details: string) => Promise<boolean>;
  readonly onClose: () => void;
}): JSX.Element {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'form' | 'sent' | 'failed'>('form');

  const close = (): void => {
    setReason(null);
    setDetails('');
    setState('form');
    onClose();
  };

  const submit = async (): Promise<void> => {
    if (reason === null || busy) return;
    setBusy(true);
    const ok = await onSubmit(reason, details.trim());
    setBusy(false);
    setState(ok ? 'sent' : 'failed');
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Close">
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.handle} />
          {state === 'sent' ? (
            <>
              <Text style={styles.title}>Thank you</Text>
              <Text style={styles.body}>Your report was sent. We look at every one and will not tell {subjectName} who reported.</Text>
              <PrimaryButton label="Done" onPress={close} />
            </>
          ) : (
            <>
              <Text style={styles.title}>Report {aboutMessage ? 'this message' : subjectName}</Text>
              <Text style={styles.body}>What is wrong with it?</Text>
              <View style={styles.reasons}>
                {REPORT_REASONS.map(([code, label]) => (
                  <Pressable key={code} onPress={() => setReason(code)} accessibilityRole="radio" accessibilityState={{ selected: reason === code }} style={[styles.reason, reason === code && styles.reasonOn]}>
                    <View style={[styles.radio, reason === code && styles.radioOn]} />
                    <Text style={[styles.reasonLabel, reason === code && styles.reasonLabelOn]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                style={styles.input}
                value={details}
                onChangeText={setDetails}
                placeholder="Anything else we should know? (optional)"
                placeholderTextColor={C7.faint}
                multiline
                maxLength={500}
              />
              {state === 'failed' && <Text style={styles.failed}>The report could not be sent. Try again.</Text>}
              <PrimaryButton label={busy ? 'Sending…' : 'Send report'} onPress={() => void submit()} disabled={reason === null || busy} />
              <Pressable onPress={close} accessibilityRole="button" style={styles.cancel}>
                <Text style={styles.cancelLabel}>Cancel</Text>
              </Pressable>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#0e1826', borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderColor: C7.panelEdge, padding: 18, paddingBottom: 30, gap: 12 },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: C7.panelEdge, marginBottom: 4 },
  title: { color: C7.text, fontSize: 20, fontWeight: '600', fontFamily: 'serif' },
  body: { color: C7.muted, fontSize: 14, lineHeight: 20 },
  reasons: { gap: 4 },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 6, borderRadius: 10 },
  reasonOn: { backgroundColor: 'rgba(62,201,192,0.08)' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: C7.muted },
  radioOn: { borderColor: C7.teal, backgroundColor: C7.teal },
  reasonLabel: { color: C7.text, fontSize: 15 },
  reasonLabelOn: { color: C7.teal, fontWeight: '600' },
  input: { minHeight: 64, borderRadius: 12, borderWidth: 1, borderColor: C7.panelEdge, backgroundColor: 'rgba(255,255,255,0.04)', color: C7.text, fontSize: 14, padding: 12, textAlignVertical: 'top' },
  failed: { color: C7.amber, fontSize: 13 },
  cancel: { alignSelf: 'center', padding: 8 },
  cancelLabel: { color: C7.muted, fontSize: 14 },
});
