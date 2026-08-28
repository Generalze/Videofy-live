/** @author masterzee001 */
/**
 * CONFERENCES ONLY (founder ruling 2026-08-28): start one, or join one by
 * its code. This is the only place a human-readable call code exists.
 * Direct calls are person-to-person and start from a contact, a chat or an
 * incoming call -- never from a code, and never from here. `normalizeCallCode`
 * is the shared contract that makes a code typed here reach the same
 * conference as the same code typed anywhere else.
 */
import { useState, type JSX } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { normalizeCallCode } from '@videofy-live/call-client-core';

const ADJECTIVES = ['amber', 'bright', 'calm', 'clear', 'coral', 'gentle', 'golden', 'quiet'];
const NOUNS = ['river', 'harbour', 'meadow', 'summit', 'lantern', 'compass', 'orchard', 'beacon'];

function generateCallCode(): string {
  const pick = (words: readonly string[]): string =>
    words[Math.floor(Math.random() * words.length)] ?? 'call';
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
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Conference</Text>
        <Text style={styles.cardBody}>
          Start a conference and share its code, or join one with the code you were given.
        </Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="call code"
          placeholderTextColor="#4a545f"
          onSubmitEditing={() => normalised.length > 0 && onJoin(normalised)}
        />
        <View style={styles.row}>
          <Pressable
            style={({ pressed }) => [styles.button, styles.flex, pressed && styles.pressed]}
            onPress={() => setCode(generateCallCode())}
            accessibilityRole="button"
          >
            <Text style={styles.buttonLabel}>Start</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.flex,
              normalised.length === 0 && styles.disabled,
              pressed && normalised.length > 0 && styles.pressed,
            ]}
            onPress={() => onJoin(normalised)}
            disabled={normalised.length === 0}
            accessibilityRole="button"
          >
            <Text style={styles.buttonLabel}>Join</Text>
          </Pressable>
        </View>
        {emailVerified === false && (
          <Text style={styles.warn}>
            Starting a conference needs a verified email (see Profile). Joining one works now.
          </Text>
        )}
      </View>

      <Text style={styles.footnote}>
        Calls are normal mode in this build: your camera and voice, no translation. To call a
        contact directly, use the Call button beside their name.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#0b0f14' },
  screen: { padding: 16, gap: 14 },
  card: {
    backgroundColor: '#141a21',
    borderWidth: 1,
    borderColor: '#273039',
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  cardTitle: { color: '#e4ebf1', fontSize: 16, fontWeight: '600' },
  cardBody: { color: '#8d99a6', fontSize: 14, lineHeight: 20 },
  input: {
    backgroundColor: '#0b0f14',
    borderWidth: 1,
    borderColor: '#273039',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#e4ebf1',
    fontSize: 18,
    fontFamily: 'monospace',
    letterSpacing: 2,
  },
  row: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  button: {
    backgroundColor: '#3ec9c0',
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: 'center',
  },
  disabled: { backgroundColor: '#1f3a38' },
  pressed: { opacity: 0.75 },
  buttonLabel: { color: '#0b0f14', fontSize: 15, fontWeight: '700' },
  warn: { color: '#d9a441', fontSize: 13, lineHeight: 19 },
  footnote: { color: '#5d6874', fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
});
