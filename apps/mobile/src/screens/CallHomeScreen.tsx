/** @author masterzee001 */
/**
 * Conference, to canon: start one, or join one by its code.
 *
 * CONFERENCES ONLY (founder ruling 2026-08-28): this is the only place a
 * human-readable call code exists. Direct calls start from a person.
 * START MEANS START (addendum 2026-08-29): the conference opens at once
 * with a fresh code, shown on the call screen.
 *
 * THE START CARD IS THE SETUP (29 Aug). A title, who may enter, and which
 * languages the host offers listeners travel with the creating join and
 * come back on call:state for everyone to see. Public: listed below for
 * anyone to join. Private: only with the code. Restricted: the host admits
 * each person at the door. All three are gateway-enforced; none is a
 * control that does nothing.
 *
 * TWO LISTS UNDER THE CARDS. Public conferences come from the gateway
 * (GET /calls/public, no session needed -- a public room is public). Recent
 * ones are this phone's own memory of what it started or joined, kept in
 * the secure store and read again every time the screen appears.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { normalizeCallCode } from '@videofy-live/call-client-core';
import { C7, Chip, GlassCard, PrimaryButton, SectionHeading } from '../ui/c7';
import { Icon, type IconName } from '../ui/icons';
import {
  CONFERENCE_TARGET_LANGUAGE_MAX,
  CONFERENCE_TITLE_MAX,
  PRIVACY_CHOICES,
  buildConferenceSetup,
  commonLanguages,
  languageLabel,
  moreLanguages,
  privacyExplanation,
  toggleLanguage,
  type ConferencePrivacy,
  type ConferenceSetup,
} from '../conference/conferenceSetup';
import { recentConferences, type RecentConference } from '../conference/recentConferences';
import {
  agoWords,
  conferenceTitle,
  fetchPublicConferences,
  peopleWords,
  startedWords,
  type PublicConference,
} from '../conference/publicConferences';

/** Not a secret; compiled into the bundle like every EXPO_PUBLIC_ value. */
const GATEWAY_URL = process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://staging.consummate7.com';

const ADJECTIVES = ['amber', 'bright', 'calm', 'clear', 'coral', 'gentle', 'golden', 'quiet'];
const NOUNS = ['river', 'harbour', 'meadow', 'summit', 'lantern', 'compass', 'orchard', 'beacon'];

function generateCallCode(): string {
  const pick = (words: readonly string[]): string => words[Math.floor(Math.random() * words.length)] ?? 'call';
  const digits = String(Math.floor(Math.random() * 90) + 10);
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${digits}`;
}

const PRIVACY_ICON: Record<ConferencePrivacy, IconName> = {
  public: 'globe',
  private: 'lock',
  restricted: 'shield',
};

export interface CallHomeScreenProps {
  readonly emailVerified: boolean | null;
  /**
   * Start passes a fresh code AND the setup the host chose; Join by code,
   * a public row and a recent row pass the code alone -- the conference
   * that exists is authoritative and the gateway would ignore a setup.
   */
  readonly onJoin: (callId: string, setup?: ConferenceSetup) => void;
}

export function CallHomeScreen({ emailVerified, onJoin }: CallHomeScreenProps): JSX.Element {
  const [code, setCode] = useState('');
  const normalised = normalizeCallCode(code);

  // ---- the setup ------------------------------------------------------
  const [title, setTitle] = useState('');
  const [privacy, setPrivacy] = useState<ConferencePrivacy>('private');
  const [languages, setLanguages] = useState<readonly string[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [query, setQuery] = useState('');
  const common = useMemo(() => commonLanguages(), []);
  const more = useMemo(() => moreLanguages(query, languages), [query, languages]);
  const atLimit = languages.length >= CONFERENCE_TARGET_LANGUAGE_MAX;

  const start = useCallback(() => {
    onJoin(generateCallCode(), buildConferenceSetup({ title, privacy, targetLanguages: languages }));
  }, [onJoin, title, privacy, languages]);

  // ---- the lists ------------------------------------------------------
  const [publicCalls, setPublicCalls] = useState<readonly PublicConference[] | null>(null);
  const [recent, setRecent] = useState<readonly RecentConference[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const [listing, remembered] = await Promise.all([fetchPublicConferences(GATEWAY_URL), recentConferences.read()]);
    setPublicCalls(listing);
    setRecent(remembered);
    setNowMs(Date.now());
  }, []);

  // On mount (which is also focus: the tab renders this screen only while
  // it is selected) and whenever the app comes back to the foreground.
  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <GlassCard accent style={{ gap: 14 }}>
        <View style={styles.head}>
          <View style={styles.orb}>
            <Icon name="wave" size={26} color={C7.teal} />
            <View style={styles.orbBadge}>
              <Icon name="plus" size={12} color={C7.ground} strokeWidth={2.4} />
            </View>
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.title}>Start conference</Text>
            <Text style={styles.body}>Host a new conference and invite others with its code.</Text>
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Conference title</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            maxLength={CONFERENCE_TITLE_MAX}
            placeholder="e.g. Global Leadership Dialogue"
            placeholderTextColor={C7.faint}
            returnKeyType="done"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Privacy</Text>
          <View style={styles.tierRow}>
            {PRIVACY_CHOICES.map((choice) => {
              const active = choice.key === privacy;
              return (
                <Pressable
                  key={choice.key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => setPrivacy(choice.key)}
                  style={({ pressed }) => [styles.tier, active && styles.tierActive, pressed && styles.pressed]}
                >
                  <Icon name={PRIVACY_ICON[choice.key]} size={18} color={active ? C7.teal : C7.muted} />
                  <Text style={[styles.tierLabel, active && styles.tierLabelActive]}>{choice.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.explain}>{privacyExplanation(privacy)}</Text>
        </View>

        <View style={styles.field}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>Target languages</Text>
            <Text style={styles.count}>
              {languages.length} of {CONFERENCE_TARGET_LANGUAGE_MAX}
            </Text>
          </View>
          <Text style={styles.explain}>Languages you offer listeners. Shown to everyone who joins.</Text>
          <View style={styles.chips}>
            {languages.map((selected) => (
              <Chip
                key={selected}
                label={languageLabel(selected)}
                active
                onPress={() => setLanguages((current) => toggleLanguage(current, selected))}
                trailing={<Icon name="close" size={12} color="#ffffff" strokeWidth={2.2} />}
              />
            ))}
            {common
              .filter((language) => !languages.includes(language.code))
              .map((language) => (
                <Chip
                  key={language.code}
                  label={language.englishName}
                  {...(atLimit ? {} : { onPress: () => setLanguages((current) => toggleLanguage(current, language.code)) })}
                />
              ))}
            <Chip
              label={moreOpen ? 'Less' : 'More'}
              tone="teal"
              onPress={() => setMoreOpen((open) => !open)}
              trailing={<Icon name={moreOpen ? 'close' : 'plus'} size={12} color={C7.teal} strokeWidth={2.2} />}
            />
          </View>
          {atLimit && <Text style={styles.explain}>That is the most a conference can offer. Remove one to add another.</Text>}
          {moreOpen && (
            <View style={{ gap: 10 }}>
              <TextInput
                style={styles.input}
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Search languages"
                placeholderTextColor={C7.faint}
              />
              <View style={styles.chips}>
                {more.map((language) => (
                  <Chip
                    key={language.code}
                    label={language.englishName}
                    {...(atLimit ? {} : { onPress: () => setLanguages((current) => toggleLanguage(current, language.code)) })}
                  />
                ))}
                {more.length === 0 && <Text style={styles.explain}>No language matches that.</Text>}
              </View>
            </View>
          )}
        </View>

        <PrimaryButton label="Start Conference" onPress={start} leading={<Icon name="camera" size={18} color="#ffffff" />} />
        {emailVerified === false && (
          <Text style={styles.warn}>Starting a conference needs a verified email (see Profile). Joining one works now.</Text>
        )}
      </GlassCard>

      <GlassCard style={{ gap: 14 }}>
        <View style={styles.head}>
          <View style={styles.orb}>
            <Icon name="people" size={26} color={C7.teal} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.title}>Join conference</Text>
            <Text style={styles.body}>Enter a conference code to join instantly.</Text>
          </View>
        </View>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Enter conference code"
          placeholderTextColor={C7.faint}
          onSubmitEditing={() => normalised.length > 0 && onJoin(normalised)}
        />
        <PrimaryButton label="Join Conference" onPress={() => onJoin(normalised)} disabled={normalised.length === 0} />
      </GlassCard>

      <SectionHeading title="Public conferences" subtitle="Open to anyone, right now." action="Refresh" onAction={() => void refresh()} />
      <GlassCard padded={false}>
        {publicCalls === null && (
          <View style={styles.rowEmpty}>
            <ActivityIndicator color={C7.teal} />
          </View>
        )}
        {publicCalls !== null && publicCalls.length === 0 && (
          <View style={styles.rowEmpty}>
            <Text style={styles.empty}>No public conferences right now.</Text>
          </View>
        )}
        {publicCalls?.map((entry, index) => (
          <Pressable
            key={entry.callId}
            accessibilityRole="button"
            onPress={() => onJoin(entry.callId)}
            style={({ pressed }) => [styles.row, index > 0 && styles.rowDivider, pressed && styles.pressed]}
          >
            <View style={styles.rowIcon}>
              <Icon name="globe" size={20} color={C7.teal} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {conferenceTitle(entry.title)}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {peopleWords(entry.participantCount)} · {startedWords(entry.createdAtMs, nowMs)}
              </Text>
            </View>
            <Icon name="chevron" size={18} color={C7.faint} />
          </Pressable>
        ))}
      </GlassCard>

      <SectionHeading title="Recent" subtitle="Conferences this phone started or joined." />
      <GlassCard padded={false}>
        {recent.length === 0 && (
          <View style={styles.rowEmpty}>
            <Text style={styles.empty}>Conferences you start or join appear here.</Text>
          </View>
        )}
        {recent.map((entry, index) => (
          <Pressable
            key={entry.callId}
            accessibilityRole="button"
            onPress={() => onJoin(entry.callId)}
            style={({ pressed }) => [styles.row, index > 0 && styles.rowDivider, pressed && styles.pressed]}
          >
            <View style={styles.rowIcon}>
              <Icon name="clock" size={20} color={C7.muted} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {entry.title ?? entry.callId}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {entry.title === null ? '' : `${entry.callId} · `}
                {entry.role === 'started' ? 'started' : 'joined'} {agoWords(entry.atMs, nowMs)}
              </Text>
            </View>
            <Icon name="chevron" size={18} color={C7.faint} />
          </Pressable>
        ))}
      </GlassCard>

      <Text style={styles.footnote}>To call a contact directly, use Call beside their name in People.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { padding: 16, gap: 14, paddingBottom: 40 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  orb: { width: 64, height: 64, borderRadius: 32, backgroundColor: C7.tealSoft, borderWidth: 1, borderColor: 'rgba(62,201,192,0.4)', alignItems: 'center', justifyContent: 'center' },
  orbBadge: { position: 'absolute', right: -2, bottom: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: C7.teal, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C7.ground },
  title: { color: C7.text, fontSize: 24, fontWeight: '600', fontFamily: 'serif', letterSpacing: -0.2 },
  body: { color: C7.muted, fontSize: 14, lineHeight: 19 },
  field: { gap: 8 },
  label: { color: C7.text, fontSize: 14, fontWeight: '600' },
  labelRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  count: { color: C7.faint, fontSize: 12 },
  explain: { color: C7.muted, fontSize: 13, lineHeight: 18 },
  input: { backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: C7.panelEdge, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, color: C7.text, fontSize: 17, letterSpacing: 1 },
  tierRow: { flexDirection: 'row', gap: 8 },
  tier: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 14, borderWidth: 1, borderColor: C7.panelEdge, backgroundColor: 'rgba(255,255,255,0.04)', paddingVertical: 11, paddingHorizontal: 8 },
  tierActive: { borderColor: C7.teal, backgroundColor: C7.tealSoft },
  tierLabel: { color: C7.muted, fontSize: 14, fontWeight: '600' },
  tierLabelActive: { color: C7.teal },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  warn: { color: C7.amber, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  rowDivider: { borderTopWidth: 1, borderTopColor: C7.panelEdge },
  rowEmpty: { paddingHorizontal: 16, paddingVertical: 18, alignItems: 'center' },
  rowIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: C7.panelEdge, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { color: C7.text, fontSize: 16, fontWeight: '600' },
  rowMeta: { color: C7.muted, fontSize: 13 },
  empty: { color: C7.faint, fontSize: 13, textAlign: 'center' },
  pressed: { opacity: 0.75 },
  footnote: { color: C7.faint, fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
});
