/** @author masterzee001 */
/**
 * The Profile's rows, each one small enough to read whole.
 *
 * Every row owns its own draft, busy flag and notice, talks to the server
 * through the one Api it is handed, and tells the screen `onChanged` when
 * the profile it was showing is stale. The screen reloads; nothing here
 * guesses the server's answer.
 *
 * SWITCHES ARE OPTIMISTIC AND HONEST: they flip at once, and flip back with
 * a line of text if the server refused. A switch that waits for the network
 * reads as broken; one that stays flipped after a refusal is lying.
 *
 * MY C7 VOICE records with expo-audio exactly as a voice note does (the
 * ChatScreen hook), then posts the bytes to media-ingest through
 * people/voiceEnrolment. The sample is deleted from the phone after the
 * upload, whatever the answer; a biometric recording has no business in a
 * cache directory.
 */
import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { File } from 'expo-file-system';
import type { Api, Availability, MeCounts } from '../api/client';
import type { RegistrationOutcome } from '../push/deviceRegistrationService';
import { deleteVoice, ENROLMENT_MIME_TYPE, enrolVoice, INGEST_URL, judgeTake, MAX_TAKE_MS, takeCounter, voiceStatus } from '../people/voiceEnrolment';
import { C7, Chip, GlassCard } from '../ui/c7';
import { Icon, type IconName } from '../ui/icons';

const DEVICE_EXPLANATION: Record<Extract<RegistrationOutcome, { ok: false }>['reason'], string> = {
  'not-signed-in': 'The session ended before the device could be registered.',
  'permission-denied': 'Notifications are off for this app, so calls cannot ring this phone.',
  'no-token': 'Firebase did not issue a token for this build.',
  unauthorized: 'The session was rejected. Sign in again.',
  rejected: 'The server would not accept this device.',
  network: 'Could not reach Videofy from this phone.',
};

interface RowShell {
  readonly open: boolean;
  readonly onToggle: () => void;
}

export function Row({ icon, title, subtitle, open, onPress, children }: { readonly icon: IconName; readonly title: string; readonly subtitle?: string | undefined; readonly open?: boolean; readonly onPress?: () => void; readonly children?: ReactNode }): JSX.Element {
  return (
    <GlassCard padded={false} style={styles.rowCard}>
      <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.rowHead, pressed && onPress && styles.pressed]}>
        <View style={styles.rowIcon}>
          <Icon name={icon} size={22} color={C7.teal} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.rowTitle}>{title}</Text>
          {subtitle !== undefined && <Text style={styles.rowSubtitle}>{subtitle}</Text>}
        </View>
        {onPress !== undefined && <Icon name="chevron" size={18} color={C7.muted} />}
      </Pressable>
      {open && children !== undefined && <View style={styles.rowBody}>{children}</View>}
    </GlassCard>
  );
}

/** connections / calls / following / saved, under the identity card. */
export function CountsRow({ counts }: { readonly counts: MeCounts | null }): JSX.Element {
  const cells: readonly [string, number | null][] = [
    ['Connections', counts?.connections ?? null],
    ['Calls', counts?.calls ?? null],
    ['Following', counts?.following ?? null],
    ['Saved', counts?.saved ?? null],
  ];
  return (
    <GlassCard padded={false} style={styles.counts}>
      {cells.map(([label, value], index) => (
        <View key={label} style={[styles.countCell, index > 0 && styles.countDivider]}>
          <Text style={styles.countValue}>{value === null ? '–' : value.toLocaleString()}</Text>
          <Text style={styles.countLabel}>{label}</Text>
        </View>
      ))}
    </GlassCard>
  );
}

export function AboutMeRow({ api, bio, onChanged, open, onToggle }: RowShell & { readonly api: Api; readonly bio: string; readonly onChanged: () => void }): JSX.Element {
  const [draft, setDraft] = useState(bio);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) setDraft(bio);
  }, [bio, dirty]);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const result = await api.updateProfile({ bio: draft.trim() });
    setNotice(result.ok ? 'Saved.' : result.error);
    if (result.ok) {
      setDirty(false);
      onChanged();
    }
    setBusy(false);
  }, [api, busy, draft, onChanged]);

  return (
    <Row icon="chat" title="About me" subtitle={bio.length > 0 ? bio : 'A line about you, shown on your profile'} open={open} onPress={onToggle}>
      <TextInput
        style={[styles.input, styles.bioInput]}
        value={draft}
        onChangeText={(text) => { setDraft(text); setDirty(true); }}
        placeholder="What you do, what you care about"
        placeholderTextColor={C7.faint}
        maxLength={160}
        multiline
      />
      <View style={styles.between}>
        <Text style={styles.counter}>{draft.length}/160</Text>
        <Pressable onPress={() => void save()} disabled={busy || !dirty} accessibilityRole="button" style={[styles.smallButton, (busy || !dirty) && styles.disabled]}>
          <Text style={styles.smallButtonLabel}>Save</Text>
        </Pressable>
      </View>
      {notice !== null && <Text style={styles.notice}>{notice}</Text>}
    </Row>
  );
}

const AVAILABILITY: readonly [Availability, string][] = [
  ['auto', 'Auto'],
  ['busy', 'Busy'],
  ['away', 'Away'],
];

const AVAILABILITY_WORDS: Record<Availability, string> = {
  auto: 'Auto · contacts see your live presence',
  busy: 'Busy · shown to your contacts',
  away: 'Away · shown to your contacts',
};

export function AvailabilityRow({ api, availability, onChanged, open, onToggle }: RowShell & { readonly api: Api; readonly availability: Availability; readonly onChanged: () => void }): JSX.Element {
  const [notice, setNotice] = useState<string | null>(null);
  const choose = useCallback(
    async (next: Availability) => {
      setNotice(null);
      const result = await api.updateProfile({ availability: next });
      if (result.ok) onChanged();
      else setNotice(result.error);
    },
    [api, onChanged],
  );
  return (
    <Row icon="clock" title="Availability" subtitle={AVAILABILITY_WORDS[availability]} open={open} onPress={onToggle}>
      <View style={styles.chips}>
        {AVAILABILITY.map(([code, label]) => (
          <Chip key={code} label={label} active={availability === code} onPress={() => void choose(code)} />
        ))}
      </View>
      <Text style={styles.hint}>Busy and Away show to your contacts instead of your live presence.</Text>
      {notice !== null && <Text style={styles.notice}>{notice}</Text>}
    </Row>
  );
}

function Toggle({ label, value, onChange, disabled = false }: { readonly label: string; readonly value: boolean; readonly onChange: (next: boolean) => void; readonly disabled?: boolean }): JSX.Element {
  return (
    <View style={styles.between}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ false: 'rgba(255,255,255,0.14)', true: C7.tealDeep }} thumbColor={value ? C7.teal : C7.muted} />
    </View>
  );
}

export function NotificationsRow({
  api,
  notificationsEnabled,
  deviceOutcome,
  onRetryDevice,
  onChanged,
  open,
  onToggle,
}: RowShell & {
  readonly api: Api;
  readonly notificationsEnabled: boolean;
  readonly deviceOutcome: RegistrationOutcome | null;
  readonly onRetryDevice: () => Promise<void>;
  readonly onChanged: () => void;
}): JSX.Element {
  const [shown, setShown] = useState(notificationsEnabled);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setShown(notificationsEnabled), [notificationsEnabled]);

  const flip = useCallback(
    async (next: boolean) => {
      setShown(next);
      setNotice(null);
      const result = await api.updateProfile({ notificationsEnabled: next });
      if (result.ok) onChanged();
      else {
        setShown(!next);
        setNotice(result.error);
      }
    },
    [api, onChanged],
  );

  const deviceWords = deviceOutcome === null ? 'Registering this phone…' : deviceOutcome.ok ? 'This phone can ring for calls and messages' : 'This phone cannot ring yet';
  return (
    <Row icon="bell" title="Notifications" subtitle={`${shown ? 'Messages and live reminders on' : 'Messages and live reminders off'} · ${deviceWords}`} open={open} onPress={onToggle}>
      <Toggle label="Messages and live reminders" value={shown} onChange={(next) => void flip(next)} />
      <Text style={styles.hint}>Calls always ring. This is for messages and live reminders.</Text>
      {notice !== null && <Text style={styles.notice}>{notice}</Text>}
      <Text style={styles.label}>This phone</Text>
      {deviceOutcome !== null && !deviceOutcome.ok && (
        <>
          <Text style={styles.warnText}>{DEVICE_EXPLANATION[deviceOutcome.reason]}</Text>
          <Pressable onPress={() => void onRetryDevice()} accessibilityRole="button" style={[styles.smallButton, styles.selfStart]}>
            <Text style={styles.smallButtonLabel}>Try again</Text>
          </Pressable>
        </>
      )}
      {deviceOutcome?.ok === true && <Text style={styles.hint}>Registered. Calls and messages can reach this phone.</Text>}
      {deviceOutcome === null && <Text style={styles.hint}>Registering this phone…</Text>}
    </Row>
  );
}

export function PrivacyRow({
  api,
  discoverable,
  biometricsPreferred,
  onBiometricsPreferred,
  onChanged,
  open,
  onToggle,
}: RowShell & {
  readonly api: Api;
  readonly discoverable: boolean;
  readonly biometricsPreferred: boolean;
  readonly onBiometricsPreferred: (on: boolean) => void;
  readonly onChanged: () => void;
}): JSX.Element {
  const [shown, setShown] = useState(discoverable);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setShown(discoverable), [discoverable]);

  const flip = useCallback(
    async (next: boolean) => {
      setShown(next);
      setNotice(null);
      const result = await api.setDiscoverable(next);
      if (result.ok) onChanged();
      else {
        setShown(!next);
        setNotice(result.error);
      }
    },
    [api, onChanged],
  );

  return (
    <Row icon="lock" title="Privacy" subtitle={`${shown ? 'Discoverable by username' : 'Not discoverable'} · ${biometricsPreferred ? 'biometric unlock on' : 'password unlock'}`} open={open} onPress={onToggle}>
      <Toggle label="Discoverable by username" value={shown} onChange={(next) => void flip(next)} />
      <Text style={styles.hint}>Off by default. On lets people who know your username find and add you; your profile stays private to everyone else.</Text>
      {notice !== null && <Text style={styles.notice}>{notice}</Text>}
      <Toggle label="Unlock with fingerprint or face" value={biometricsPreferred} onChange={onBiometricsPreferred} />
      <Text style={styles.hint}>The app locks after an hour away. Biometrics make unlocking one touch.</Text>
    </Row>
  );
}

type VoicePhase = 'idle' | 'recording' | 'saving';

export function VoiceRow({
  sessionToken,
  enrolledLanguage,
  open,
  onToggle,
}: RowShell & {
  /** The session's bearer token for media-ingest, read at upload time and never kept. */
  readonly sessionToken: () => string | null;
  /** The language the sample will be spoken in: what the person speaks. */
  readonly enrolledLanguage: string;
}): JSX.Element {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<'unknown' | 'saved' | 'ready' | 'deleted'>('unknown');
  const startedAt = useRef(0);

  /* On a fresh launch the row asks what is on file, so "Your voice is enrolled" is true, not remembered. */
  useEffect(() => {
    let live = true;
    const token = sessionToken();
    if (token === null) return undefined;
    void voiceStatus({ fetch, ingestUrl: INGEST_URL, token }).then((found) => {
      if (!live || found === null) return;
      setStatus(found === 'none' ? 'deleted' : found);
    });
    return () => {
      live = false;
    };
  }, [sessionToken]);
  /* The 30 s ceiling fires from a timer; a second tick while stop() is still resolving must not finish twice. */
  const finishing = useRef(false);

  const finish = useCallback(async () => {
    if (finishing.current) return;
    finishing.current = true;
    const durationMs = Date.now() - startedAt.current;
    setPhase('saving');
    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri;
    } catch {
      uri = null;
    }
    if (uri === null) {
      setNotice('Nothing was recorded.');
      setPhase('idle');
      finishing.current = false;
      return;
    }
    const file = new File(uri);
    try {
      if (judgeTake(durationMs) === 'too-short') {
        setNotice('Keep talking for at least 20 seconds, then stop.');
        return;
      }
      const token = sessionToken();
      if (token === null) {
        setNotice('Sign in again to record your voice.');
        return;
      }
      const audio = await file.arrayBuffer();
      const outcome = await enrolVoice({ fetch, ingestUrl: INGEST_URL, token, enrolledLanguage, audio, mimeType: ENROLMENT_MIME_TYPE });
      setNotice(outcome.message);
      if (outcome.ok) setStatus(outcome.personalVoiceReady ? 'ready' : 'saved');
    } catch {
      setNotice('That recording could not be sent.');
    } finally {
      try {
        file.delete();
      } catch {
        // Already gone, or not ours to remove.
      }
      setPhase('idle');
      finishing.current = false;
    }
  }, [enrolledLanguage, recorder, sessionToken]);

  const start = useCallback(async () => {
    setNotice(null);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setNotice('Microphone access is needed to record your voice.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAt.current = Date.now();
      setElapsedMs(0);
      setPhase('recording');
    } catch {
      setNotice('Recording is unavailable. If this app was installed a while ago, install the newest build.');
    }
  }, [recorder]);

  const cancel = useCallback(async () => {
    if (finishing.current) return;
    setPhase('idle');
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (uri !== null) new File(uri).delete();
    } catch {
      // Nothing to keep either way.
    }
  }, [recorder]);

  /* The counter, and the ceiling: at 30 s the take is finished for the person. */
  useEffect(() => {
    if (phase !== 'recording') return undefined;
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt.current;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_TAKE_MS) void finish();
    }, 250);
    return () => clearInterval(timer);
  }, [finish, phase]);

  const remove = useCallback(async () => {
    const token = sessionToken();
    if (token === null) {
      setNotice('Sign in again to delete your voice.');
      return;
    }
    setPhase('saving');
    const outcome = await deleteVoice({ fetch, ingestUrl: INGEST_URL, token });
    setNotice(outcome.message);
    if (outcome.ok) setStatus('deleted');
    setPhase('idle');
  }, [sessionToken]);

  const subtitle =
    status === 'ready' ? 'Your voice is enrolled' : status === 'saved' ? 'Sample saved · personal voice pending' : status === 'deleted' ? 'No voice on file' : 'A short sample so translated speech sounds like you';
  const canStop = elapsedMs >= 20_000;

  return (
    <Row icon="wave" title="My C7 Voice" subtitle={subtitle} open={open} onPress={onToggle}>
      <Text style={styles.hint}>
        Record 20 to 30 seconds of yourself talking naturally, in the language you speak. When a call or programme is translated, the other side hears it in a voice built from this sample instead of a standard one. Your recording is used only for that; it is never used to train anything.
      </Text>
      {phase === 'recording' ? (
        <>
          <View style={styles.between}>
            <View style={styles.recordingRow}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingCounter}>{takeCounter(elapsedMs)}</Text>
              <Text style={styles.hint}>{canStop ? 'Enough recorded. Stop when you like.' : 'Keep talking…'}</Text>
            </View>
          </View>
          <View style={styles.actions}>
            <Pressable onPress={() => void finish()} disabled={!canStop} accessibilityRole="button" style={[styles.smallButton, !canStop && styles.disabled]}>
              <Text style={styles.smallButtonLabel}>Stop and save</Text>
            </Pressable>
            <Pressable onPress={() => void cancel()} accessibilityRole="button" style={styles.quiet}>
              <Text style={styles.quietLabel}>Cancel</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <View style={styles.actions}>
          <Pressable onPress={() => void start()} disabled={phase === 'saving'} accessibilityRole="button" style={[styles.smallButton, phase === 'saving' && styles.disabled]}>
            <Icon name="mic" size={16} color="#ffffff" />
            <Text style={styles.smallButtonLabel}>{phase === 'saving' ? 'Saving…' : status === 'unknown' || status === 'deleted' ? 'Record my voice' : 'Record again'}</Text>
          </Pressable>
          <Pressable onPress={() => void remove()} disabled={phase === 'saving'} accessibilityRole="button" style={styles.quiet}>
            <Text style={styles.quietLabel}>Delete my voice</Text>
          </Pressable>
        </View>
      )}
      {notice !== null && <Text style={styles.notice}>{notice}</Text>}
    </Row>
  );
}

/**
 * The plans page, if there is one. Not a secret: `EXPO_PUBLIC_` values are
 * compiled into the bundle. Empty or unset means there is no page yet.
 */
const PLANS_URL = process.env['EXPO_PUBLIC_PLANS_URL'];

/** Where the Plans row points, or null when it must not be shown. Exported so the rule is testable. */
export function plansUrl(raw: string | undefined = PLANS_URL): string | null {
  const trimmed = (raw ?? '').trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * PLANS, NOT UPGRADE (founder ruling 29 Aug 2026, LOCKED): "Upgrade is
 * hidden until billing exists; a page that only explains plans is 'View
 * plans', and 'Upgrade' returns only with checkout and entitlement
 * activation." So this row renders nothing unless EXPO_PUBLIC_PLANS_URL
 * names a page, and when it does the button says View plans and opens
 * that page. The export keeps its name so the Profile needs no change.
 */
export function UpgradeRow(): JSX.Element | null {
  const url = plansUrl();
  if (url === null) return null;
  return (
    <GlassCard accent style={styles.upgrade}>
      <Text style={styles.upgradeTitle}>Plans</Text>
      <Text style={styles.hint}>Translated calls and programmes are metered; normal calls are free.</Text>
      <Pressable onPress={() => void Linking.openURL(url)} accessibilityRole="button" style={[styles.smallButton, styles.selfStart]}>
        <Text style={styles.smallButtonLabel}>View plans</Text>
      </Pressable>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  rowCard: { padding: 0 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  rowIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: C7.tealSoft, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { color: C7.text, fontSize: 19, fontWeight: '600', fontFamily: 'serif' },
  rowSubtitle: { color: C7.muted, fontSize: 13, lineHeight: 18 },
  rowBody: { paddingHorizontal: 16, paddingBottom: 16, gap: 8, borderTopWidth: 1, borderTopColor: C7.panelEdge, paddingTop: 12 },
  pressed: { opacity: 0.7 },
  counts: { flexDirection: 'row', paddingVertical: 14 },
  countCell: { flex: 1, alignItems: 'center', gap: 2 },
  countDivider: { borderLeftWidth: 1, borderLeftColor: C7.panelEdge },
  countValue: { color: C7.text, fontSize: 22, fontWeight: '600', fontFamily: 'serif', fontVariant: ['tabular-nums'] },
  countLabel: { color: C7.muted, fontSize: 12 },
  label: { color: C7.faint, fontSize: 12, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { color: C7.muted, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  warnText: { color: C7.amber, fontSize: 13, lineHeight: 19 },
  notice: { color: C7.amber, fontSize: 13, lineHeight: 18 },
  input: { backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: C7.panelEdge, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, color: C7.text, fontSize: 15 },
  bioInput: { minHeight: 72, textAlignVertical: 'top' },
  counter: { color: C7.faint, fontSize: 12 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  toggleLabel: { color: C7.text, fontSize: 15, flexShrink: 1 },
  smallButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 14, borderRadius: 12, backgroundColor: C7.tealDeep, borderWidth: 1, borderColor: 'rgba(62,201,192,0.7)', minHeight: 40 },
  selfStart: { alignSelf: 'flex-start', paddingVertical: 9 },
  disabled: { opacity: 0.45 },
  smallButtonLabel: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  quiet: { paddingHorizontal: 10, paddingVertical: 8 },
  quietLabel: { color: C7.muted, fontSize: 13 },
  recordingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C7.red },
  recordingCounter: { color: C7.text, fontSize: 18, fontWeight: '600', fontFamily: 'serif', fontVariant: ['tabular-nums'] },
  upgrade: { gap: 8 },
  upgradeTitle: { color: C7.text, fontSize: 18, fontWeight: '600', fontFamily: 'serif', lineHeight: 24 },
});
