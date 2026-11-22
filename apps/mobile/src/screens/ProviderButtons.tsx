/** @author masterzee001 */
/**
 * "Or continue with" on the sign-in screen.
 *
 * DRAWS NOTHING unless the account service says a provider is switched on
 * AND this build can actually use it. Both switches ship off, so for most of
 * this feature's life the correct render is nothing -- and a button that
 * cannot work is worse on a phone than anywhere else: a tap that does
 * nothing has no error to read, so the person taps it again.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  NO_PROVIDERS,
  googleConfigured,
  type AvailableProviders,
  type ProviderSignInFailure,
} from '../auth/providerSignIn';

export interface ProviderButtonsProps {
  readonly accountBaseUrl: string;
  /** Asks the service; injected so a test can decide the answer. */
  readonly loadProviders: (accountBaseUrl: string) => Promise<AvailableProviders>;
  readonly onGoogle: () => void | Promise<void>;
  readonly onKingsChat: () => void | Promise<void>;
  /** True while a provider sign-in is in flight, including after this screen. */
  readonly busy?: boolean;
  /** Test seam: render these instead of asking. */
  readonly providers?: AvailableProviders;
  /** Test seam: whether a Google client id is compiled into this build. */
  readonly hasGoogleClientId?: boolean;
}

/**
 * What to draw, decided separately from drawing it.
 *
 * Exported and tested on its own because the behaviour that matters is the
 * negative one, and a decision buried in a component is a decision nothing
 * checks.
 */
export function providerButtonPlan(
  providers: AvailableProviders | null,
  hasGoogleClientId: boolean,
): { readonly showRow: boolean; readonly google: boolean; readonly kingschat: boolean } {
  // Null is "not asked yet". A row that appears a moment after the screen
  // settles moves the Sign in button out from under somebody's thumb.
  if (providers === null) return { showRow: false, google: false, kingschat: false };
  /*
   * Google needs a client id compiled into THIS build as well as a switch on
   * the server. Without one the request fails at Google with an error the
   * person cannot act on.
   */
  const google = providers.google && hasGoogleClientId;
  const kingschat = providers.kingschat;
  return { showRow: google || kingschat, google, kingschat };
}

export function ProviderButtons({
  accountBaseUrl,
  loadProviders,
  onGoogle,
  onKingsChat,
  busy = false,
  providers: given,
  hasGoogleClientId,
}: ProviderButtonsProps): JSX.Element | null {
  const [providers, setProviders] = useState<AvailableProviders | null>(given ?? null);

  useEffect(() => {
    if (given) return;
    let live = true;
    void loadProviders(accountBaseUrl)
      .then((result) => {
        if (live) setProviders(result);
      })
      .catch(() => {
        // Never throw out of here: the password form is the way in that
        // always works, and it must not go down with a failed lookup.
        if (live) setProviders(NO_PROVIDERS);
      });
    return () => {
      live = false;
    };
  }, [accountBaseUrl, loadProviders, given]);

  const plan = providerButtonPlan(providers, hasGoogleClientId ?? googleConfigured());
  if (!plan.showRow) return null;

  return (
    <View style={styles.row}>
      <View style={styles.dividerLine}>
        <View style={styles.rule} />
        <Text style={styles.dividerText}>or continue with</Text>
        <View style={styles.rule} />
      </View>

      {plan.google && (
        <Pressable
          style={({ pressed }) => [
            styles.provider,
            busy && styles.providerDisabled,
            pressed && !busy && styles.providerPressed,
          ]}
          onPress={() => void onGoogle()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Continue with Google"
        >
          {busy ? (
            <ActivityIndicator color="#e4ebf1" />
          ) : (
            <Text style={styles.providerLabel}>Continue with Google</Text>
          )}
        </Pressable>
      )}

      {plan.kingschat && (
        <Pressable
          style={({ pressed }) => [
            styles.provider,
            busy && styles.providerDisabled,
            pressed && !busy && styles.providerPressed,
          ]}
          onPress={() => void onKingsChat()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Continue with KingsChat"
        >
          {busy ? (
            <ActivityIndicator color="#e4ebf1" />
          ) : (
            <Text style={styles.providerLabel}>Continue with KingsChat</Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

/** Wording for a provider failure, or null when there is nothing to say. */
export function providerFailureMessage(reason: ProviderSignInFailure): string | null {
  return reason === 'cancelled'
    ? null
    : reason === 'unavailable'
      ? 'That way of signing in is not available right now.'
      : 'That sign-in could not be completed. Please try again.';
}

const styles = StyleSheet.create({
  row: { marginTop: 20, gap: 10 },
  dividerLine: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  rule: { flex: 1, height: 1, backgroundColor: '#273039' },
  dividerText: { color: '#8d99a6', fontSize: 12 },
  provider: {
    backgroundColor: '#141a21',
    borderWidth: 1,
    borderColor: '#273039',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  providerPressed: { backgroundColor: '#1b232c' },
  providerDisabled: { opacity: 0.6 },
  providerLabel: { color: '#e4ebf1', fontSize: 15, fontWeight: '600' },
});
