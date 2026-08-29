/** @author masterzee001 */
/**
 * Conference, to canon: start one, or join one by its code.
 *
 * CONFERENCES ONLY (founder ruling 2026-08-28): this is the only place a
 * human-readable call code exists. Direct calls start from a person.
 * START MEANS START (addendum 2026-08-29): the conference opens at once
 * with a fresh code, shown on the call screen.
 *
 * WHAT THE CANON SHOWS AND THIS BUILD DOES NOT CLAIM: privacy tiers,
 * target languages and recent conferences. Conferences in this build are
 * normal mode with no code-gated privacy; a control that did nothing
 * would be a lie on the screen. The language catalogue lands with the
 * programme wave and both screens pick it up together.
 */
import { useState, type JSX } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { normalizeCallCode } from '@videofy-live/call-client-core';
import { C7, GlassCard, PrimaryButton } from '../ui/c7';
import { Icon } from '../ui/icons';

const ADJECTIVES = ['amber', 'bright', 'calm', 'clear', 'coral', 'gentle', 'golden', 'quiet'];
const NOUNS = ['river', 'harbour', 'meadow', 'summit', 'lantern', 'compass', 'orchard', 'beacon'];

function generateCallCode(): string {
  const pick = (words: readonly string[]): string => words[Math.floor(Math.random() * words.length)] ?? 'call';
  const digits = String(Math.floor(Math.random() * 90) + 10);
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${digits}`;
}

export interface CallHomeScreenProps {
  readonly emailVerified: boolean | null;
  readonly onJoin: (callId: string) => void;
}

export function CallHomeScreen({ emailVerified, onJoin }: CallHomeScreenProps): JSX.Element {
  const [code, setCode] = useState('');
  const normalised = normalizeCallCode(code);

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.screen}>
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
        <PrimaryButton
          label="Start Conference"
          onPress={() => onJoin(generateCallCode())}
          leading={<Icon name="camera" size={18} color="#ffffff" />}
        />
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

      <Text style={styles.footnote}>
        Conferences are normal mode in this build: your camera and voice, no translation. To call a
        contact directly, use Call beside their name in People.
      </Text>
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
  input: { backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: C7.panelEdge, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, color: C7.text, fontSize: 17, letterSpacing: 1 },
  warn: { color: C7.amber, fontSize: 13, lineHeight: 19 },
  footnote: { color: C7.faint, fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
});
