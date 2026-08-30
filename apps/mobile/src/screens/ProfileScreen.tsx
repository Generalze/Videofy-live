/** @author masterzee001 */
/**
 * Profile, to canon: the person first (picture in a teal ring, name,
 * @handle, the C7 badge, a line about them), the four counts, then the
 * rows -- Languages & Voice, Name shown in calls, About me, Availability,
 * Verification, Notifications (with this phone's registration), Privacy,
 * My C7 Voice -- the translation offer, and sign out.
 *
 * EVERY ROW LEADS SOMEWHERE. Each one reads a real field of GET /me and
 * writes it back through a real route; the rows themselves live in
 * profileRows.tsx so this file is the order and the state, not the widgets.
 *
 * THE VERIFICATION ROW SAYS WHAT VERIFICATION ACTUALLY GATES: email alone
 * unlocks hosting; phone and identity gate commercial products.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AvatarView } from '../media/AvatarView';
import { pickAvatar } from '../media/avatarPicker';
import type { Api, MeCounts, Profile, VerificationStatus } from '../api/client';
import type { RegistrationOutcome } from '../push/deviceRegistrationService';
import { C7, Chip, GlassCard } from '../ui/c7';
import { Icon } from '../ui/icons';
import { AboutMeRow, AvailabilityRow, CountsRow, NotificationsRow, PrivacyRow, Row, UpgradeRow, VoiceRow } from './profileRows';
import {
  canHear,
  canSpeak,
  capabilityNote,
  fetchLanguageCapabilities,
  filterChoices,
  languageChoices,
  languageName,
  withChosenFirst,
  type CapabilityRow,
  type LanguageChoice,
} from '../people/languageChoices';
import { INGEST_URL } from '../people/voiceEnrolment';

/**
 * How many languages a section shows at once. Ninety-eight chips is not a
 * picker, it is a wall; the search is how somebody reaches the rest, and the
 * current choice is always first so it is never behind a query.
 */
const SHOWN_UNSEARCHED = 8;
const SHOWN_SEARCHED = 14;

export interface ProfileScreenProps {
  readonly api: Api;
  /** Fetches the picture the way the app would, and reports status / type / size. */
  readonly probeAvatar: (accountId: string) => Promise<{ status: number; contentType: string; bytes: number } | null>;
  readonly deviceOutcome: RegistrationOutcome | null;
  readonly onRetryDevice: () => Promise<void>;
  readonly onSignOut: () => Promise<void>;
  /** The app lock's unlock preference (appLock.biometricsPreferred), and where a change goes. */
  readonly biometricsPreferred: boolean;
  readonly onBiometricsPreferred: (on: boolean) => void;
  /** The session's bearer token for media-ingest (voice enrolment), read at upload time and never kept. */
  readonly sessionToken: () => string | null;
}

type OpenRow = 'languages' | 'name' | 'about' | 'availability' | 'verification' | 'notifications' | 'privacy' | 'voice';

export function ProfileScreen({ api, probeAvatar, deviceOutcome, onRetryDevice, onSignOut, biometricsPreferred, onBiometricsPreferred, sessionToken }: ProfileScreenProps): JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [verification, setVerification] = useState<VerificationStatus | null>(null);
  const [counts, setCounts] = useState<MeCounts | null>(null);
  const [draftName, setDraftName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pictureNotice, setPictureNotice] = useState<string | null>(null);
  const [avatarEpoch, setAvatarEpoch] = useState(0);
  /*
   * THE PICTURE, DIAGNOSED. Staging serves the picture correctly to an
   * authenticated request (verified 29 Aug: 200 image/jpeg, right byte
   * counts), so if it does not show, the fault is between the phone's fetch
   * and the platform image. When the image reports an error, the picture is
   * fetched the way the app would (status, type, size -- never the bytes)
   * and the disagreement is written under the picture, so the failing layer
   * has a name instead of a guess.
   */
  const [pictureDiagnosis, setPictureDiagnosis] = useState<string | null>(null);
  /*
   * THE LANGUAGE CATALOGUE, AND WHAT THIS DEPLOYMENT CAN DO WITH IT.
   *
   * The names are bundled, so the picker works with no network. The capability
   * words come from media-ingest's public GET /languages/catalogue -- the same
   * rows the operator console reads, so the phone and the console cannot
   * disagree. `null` means the read has not happened or did not work, and
   * every row then reads `unknown` rather than pretending.
   */
  const [capabilities, setCapabilities] = useState<CapabilityRow[] | null>(null);
  const [languageQuery, setLanguageQuery] = useState('');
  const diagnosePicture = useCallback(
    (accountId: string, detail: string) => {
      void probeAvatar(accountId).then((probe) => {
        if (probe === null) {
          setPictureDiagnosis(`Image failed (${detail}); the fetch could not run.`);
          return;
        }
        setPictureDiagnosis(
          `Image failed (${detail}) but the server answered ${probe.status} ${probe.contentType} ${Math.round(probe.bytes / 1024)} KB.`,
        );
      });
    },
    [probeAvatar],
  );
  const [open, setOpen] = useState<OpenRow | null>(null);

  const changePicture = useCallback(async () => {
    setPictureNotice(null);
    const picked = await pickAvatar();
    if (!picked.ok) {
      if (picked.reason !== null) setPictureNotice(picked.reason);
      return;
    }
    setPictureNotice('Uploading…');
    const result = await api.setAvatar(picked.dataUrl);
    if (!result.ok) {
      setPictureNotice(result.error === 'network' ? 'Could not reach C7.' : String(result.error));
      return;
    }
    setAvatarEpoch((epoch) => epoch + 1);
    setPictureNotice('Picture updated.');
  }, [api]);

  const load = useCallback(async () => {
    const [me, status, tally] = await Promise.all([api.me(), api.verification(), api.counts()]);
    if (me.ok) {
      setProfile(me.value);
      setDraftName((current) => (current.length === 0 ? (me.value.displayName ?? '') : current));
    }
    if (status.ok) setVerification(status.value);
    if (tally.ok) setCounts(tally.value);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  const saveName = useCallback(async () => {
    const name = draftName.trim();
    if (name.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await api.setDisplayName(name);
    setNotice(result.ok ? 'Saved.' : result.error);
    if (result.ok) await load();
    setBusy(false);
  }, [api, busy, draftName, load]);

  const sendEmail = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const result = await api.sendVerificationEmail();
    setNotice(result.ok ? 'Verification email sent. The link lasts 30 minutes.' : result.error);
    setBusy(false);
  }, [api]);

  const emailVerified = verification?.email === 'verified';
  /*
   * The capability read: once, on mount, and never blocking anything. A phone
   * that cannot reach media ingest still gets the whole catalogue with honest
   * `unknown` states rather than an empty picker.
   */
  useEffect(() => {
    let cancelled = false;
    void fetchLanguageCapabilities({ fetch, ingestUrl: INGEST_URL }).then((rows) => {
      if (!cancelled) setCapabilities(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const spokenLanguage = profile?.spokenLanguage ?? profile?.defaultLanguage ?? null;
  const listeningLanguage = profile?.listeningLanguage ?? profile?.defaultLanguage ?? null;
  const choices = useMemo(
    () => languageChoices(capabilities ?? undefined),
    [capabilities],
  );
  const shown = languageQuery.trim().length === 0 ? SHOWN_UNSEARCHED : SHOWN_SEARCHED;
  const spokenOptions = useMemo(
    () => filterChoices(withChosenFirst(choices.filter(canSpeak), spokenLanguage), languageQuery, shown),
    [choices, spokenLanguage, languageQuery, shown],
  );
  const listeningOptions = useMemo(
    () => filterChoices(withChosenFirst(choices.filter(canHear), listeningLanguage), languageQuery, shown),
    [choices, listeningLanguage, languageQuery, shown],
  );

  /*
   * THE WARNING THAT ONLY A SPEAKER COULD OTHERWISE GIVE. When one of the
   * chosen languages is being served by a general voice vendor instead of the
   * 9jaLingo specialist, the audio plays and is wrong, and every signal the
   * app can see is green. So it is written here, in words, above the hint.
   */
  const chosenWarning = useMemo(() => {
    const flagged = choices.filter(
      (choice) => choice.degraded && (choice.code === spokenLanguage || choice.code === listeningLanguage),
    );
    if (flagged.length === 0) return null;
    return `${flagged.map((choice) => choice.label).join(' and ')}: this deployment has no specialist voice for it yet, so spoken output is a degraded rendering. Text stays correct.`;
  }, [choices, spokenLanguage, listeningLanguage]);

  const setLanguage = useCallback(
    async (languages: { spokenLanguage?: string; listeningLanguage?: string }) => {
      const result = await api.setLanguages(languages);
      if (result.ok) {
        void load();
        return;
      }
      // A refusal used to vanish: the old handler tested `ok` and did nothing
      // else, so a language the server would not accept looked like a tap that
      // simply did not register.
      setNotice(result.error ?? 'That language could not be saved.');
    },
    [api, load],
  );

  const toggle = (key: OpenRow) => () => setOpen((current) => (current === key ? null : key));

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.screen}>
      <GlassCard style={styles.identity}>
        {profile === null ? (
          <ActivityIndicator color={C7.teal} />
        ) : (
          <View style={styles.identityRow}>
            <Pressable onPress={() => void changePicture()} accessibilityRole="button" accessibilityLabel="Change picture" style={styles.avatarRing}>
              <AvatarView
                key={avatarEpoch}
                version={avatarEpoch}
                accountId={profile.accountId}
                name={profile.displayName ?? profile.username ?? '?'}
                size={104}
                onImageState={(state) => {
                  if (state.state === 'loaded') setPictureDiagnosis(null);
                  else diagnosePicture(profile.accountId, state.detail);
                }}
              />
              <View style={styles.avatarEdit}>
                <Icon name="plus" size={14} color={C7.ground} strokeWidth={2.4} />
              </View>
            </Pressable>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={styles.name}>{profile.displayName ?? profile.username ?? profile.accountId}</Text>
              <View style={styles.handleRow}>
                <Text style={styles.handle}>@{profile.username ?? profile.accountId}</Text>
                <Chip label="C7" tone="teal" />
              </View>
              {profile.bio.trim().length > 0 && <Text style={styles.bio}>{profile.bio.trim()}</Text>}
              <Text style={styles.email}>{profile.email}</Text>
              {pictureNotice !== null && <Text style={styles.pictureNotice}>{pictureNotice}</Text>}
              {pictureDiagnosis !== null && <Text style={styles.pictureNotice}>{pictureDiagnosis}</Text>}
            </View>
          </View>
        )}
      </GlassCard>

      <CountsRow counts={counts} />

      <Row
        icon="translate"
        title="Languages & Voice"
        subtitle={profile === null ? undefined : `Primary ${languageName(profile.defaultLanguage)} · I speak ${languageName(profile.spokenLanguage ?? profile.defaultLanguage)} · I prefer to hear ${languageName(profile.listeningLanguage ?? profile.defaultLanguage)}`}
        open={open === 'languages'}
        onPress={toggle('languages')}
      >
        {profile !== null && (
          <>
            <TextInput
              style={styles.input}
              value={languageQuery}
              onChangeText={setLanguageQuery}
              placeholder="Search languages (name, own name or code)"
              placeholderTextColor={C7.faint}
              autoCorrect={false}
              autoCapitalize="none"
              accessibilityLabel="Search languages"
            />

            <Text style={styles.label}>I speak</Text>
            <View style={styles.chips}>
              {spokenOptions.map((choice) => (
                <Chip
                  key={choice.code}
                  label={chipLabel(choice)}
                  tone={choice.degraded ? 'amber' : 'neutral'}
                  active={spokenLanguage === choice.code}
                  onPress={() => void setLanguage({ spokenLanguage: choice.code })}
                />
              ))}
              {spokenOptions.length === 0 && <Text style={styles.hint}>No language matches that.</Text>}
            </View>

            <Text style={styles.label}>I prefer to hear</Text>
            <View style={styles.chips}>
              {listeningOptions.map((choice) => (
                <Chip
                  key={choice.code}
                  label={chipLabel(choice)}
                  tone={choice.degraded ? 'amber' : 'neutral'}
                  active={listeningLanguage === choice.code}
                  onPress={() => void setLanguage({ listeningLanguage: choice.code })}
                />
              ))}
              {listeningOptions.length === 0 && <Text style={styles.hint}>No language matches that.</Text>}
            </View>

            {chosenWarning !== null && <Text style={styles.pictureNotice}>{chosenWarning}</Text>}
            <Text style={styles.hint}>
              {capabilities === null
                ? 'Translated messages and programmes follow these. This phone could not reach the translation service, so no language is marked as ready. Live calls currently carry English, Spanish and French; any other choice leaves calls on their own default.'
                : 'Translated messages and programmes follow these. Beta means a provider lists the language and nobody here has heard it yet; captions only means text without a voice. Live calls currently carry English, Spanish and French; any other choice leaves calls on their own default.'}
            </Text>
          </>
        )}
      </Row>

      <Row icon="profile" title="Name shown in calls" subtitle={profile?.displayName ?? 'Not set'} open={open === 'name'} onPress={toggle('name')}>
        <View style={styles.nameRow}>
          <TextInput style={styles.input} value={draftName} onChangeText={setDraftName} placeholder="Your name" placeholderTextColor={C7.faint} maxLength={40} />
          <Pressable onPress={() => void saveName()} disabled={busy} accessibilityRole="button" style={[styles.smallButton, busy && styles.disabled]}>
            <Text style={styles.smallButtonLabel}>Save</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>Your username is how people add you and cannot change. This name is what they see, and can.</Text>
      </Row>

      {profile !== null && <AboutMeRow api={api} bio={profile.bio} onChanged={reload} open={open === 'about'} onToggle={toggle('about')} />}

      {profile !== null && <AvailabilityRow api={api} availability={profile.availability} onChanged={reload} open={open === 'availability'} onToggle={toggle('availability')} />}

      <Row
        icon="shield"
        title="Verification"
        subtitle={verification === null ? undefined : emailVerified ? 'Email verified · you can start calls' : 'Verify your email to start calls'}
        open={open === 'verification'}
        onPress={toggle('verification')}
      >
        {verification !== null && (
          <>
            {(
              [
                ['Email', verification.email],
                ['Phone', verification.phone],
                ['Identity', verification.identity],
              ] as const
            ).map(([label, state]) => (
              <View key={label} style={styles.checkRow}>
                <Text style={state === 'verified' ? styles.checkDone : styles.checkPending}>{state === 'verified' ? '✓' : '·'}</Text>
                <Text style={styles.checkLabel}>{label} · {state}</Text>
              </View>
            ))}
            <Text style={styles.hint}>
              {emailVerified ? 'You can start calls. Phone and identity checks unlock commercial products later.' : 'You can already join calls and message contacts.'}
            </Text>
            {!emailVerified && (
              <Pressable onPress={() => void sendEmail()} disabled={busy} accessibilityRole="button" style={[styles.smallButton, styles.selfStart, busy && styles.disabled]}>
                <Text style={styles.smallButtonLabel}>Send verification email</Text>
              </Pressable>
            )}
          </>
        )}
      </Row>

      <NotificationsRow
        api={api}
        notificationsEnabled={profile?.notificationsEnabled ?? true}
        deviceOutcome={deviceOutcome}
        onRetryDevice={onRetryDevice}
        onChanged={reload}
        open={open === 'notifications'}
        onToggle={toggle('notifications')}
      />

      <PrivacyRow
        api={api}
        discoverable={profile?.discoverable ?? false}
        biometricsPreferred={biometricsPreferred}
        onBiometricsPreferred={onBiometricsPreferred}
        onChanged={reload}
        open={open === 'privacy'}
        onToggle={toggle('privacy')}
      />

      <VoiceRow sessionToken={sessionToken} enrolledLanguage={profile?.spokenLanguage ?? profile?.defaultLanguage ?? 'en'} open={open === 'voice'} onToggle={toggle('voice')} />

      <UpgradeRow />

      {notice !== null && <Text style={styles.notice}>{notice}</Text>}

      <Pressable onPress={() => void onSignOut()} accessibilityRole="button" style={({ pressed }) => [styles.signOut, pressed && styles.pressed]}>
        <Text style={styles.signOutLabel}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

/** "Yoruba · degraded voice": the name, and the one thing worth knowing. */
function chipLabel(choice: LanguageChoice): string {
  const note = capabilityNote(choice);
  return note === null ? choice.label : `${choice.label} · ${note}`;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { padding: 16, gap: 12, paddingBottom: 48 },
  identity: { padding: 18 },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  avatarRing: { borderRadius: 60, borderWidth: 2, borderColor: C7.teal, padding: 3 },
  avatarEdit: { position: 'absolute', right: 2, bottom: 2, width: 24, height: 24, borderRadius: 12, backgroundColor: C7.teal, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C7.ground },
  name: { color: C7.text, fontSize: 28, fontWeight: '600', fontFamily: 'serif', letterSpacing: -0.3 },
  handleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  handle: { color: C7.muted, fontSize: 15 },
  bio: { color: C7.text, fontSize: 14, lineHeight: 20, opacity: 0.9 },
  email: { color: C7.faint, fontSize: 13 },
  pictureNotice: { color: C7.amber, fontSize: 12 },
  label: { color: C7.faint, fontSize: 12, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { color: C7.muted, fontSize: 13, lineHeight: 19 },
  nameRow: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: C7.panelEdge, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, color: C7.text, fontSize: 15 },
  smallButton: { paddingHorizontal: 14, borderRadius: 12, backgroundColor: C7.tealDeep, borderWidth: 1, borderColor: 'rgba(62,201,192,0.7)', alignItems: 'center', justifyContent: 'center', minHeight: 40 },
  selfStart: { alignSelf: 'flex-start', paddingVertical: 9 },
  disabled: { opacity: 0.45 },
  smallButtonLabel: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkDone: { color: C7.teal, fontSize: 15, width: 16, fontWeight: '700' },
  checkPending: { color: C7.faint, fontSize: 15, width: 16 },
  checkLabel: { color: C7.text, fontSize: 14 },
  notice: { color: C7.amber, fontSize: 13, textAlign: 'center' },
  signOut: { alignItems: 'center', paddingVertical: 14 },
  pressed: { opacity: 0.7 },
  signOutLabel: { color: C7.muted, fontSize: 15 },
});
