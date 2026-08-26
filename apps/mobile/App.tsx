/** @author masterzee001 */
/**
 * The app, and the single place that knows who is signed in.
 *
 * ONE SOURCE OF TRUTH. Routing is derived from `AuthSessionManager`'s state and
 * from nothing else -- no screen navigates on success, no component keeps its
 * own idea of whether somebody is signed in. Two answers to that question is how
 * a signed-out app keeps showing signed-in content.
 *
 * THE SERVICES ARE BUILT ONCE, at module scope, because they own things that
 * must not be duplicated: a device id minted on first use, a rotation
 * subscription, an in-flight sign-in guard. Rebuilding them on a re-render would
 * quietly produce two of each.
 *
 * ROTATION IS TIED TO THE SESSION, started when signed in and stopped when
 * signed out. A listener outliving the account it was started for would
 * re-register this phone against a session that no longer exists.
 *
 * WHAT REPLACED THE PRE-AUTH DIAGNOSTIC. This screen used to run three
 * unauthenticated probes -- reachable, permitted, token issued -- because there
 * was no sign-in and the honest thing was to prove what could be proven. That
 * checkpoint passed on a real device and is frozen at 395d379. Those three
 * conditions are now preconditions of registering, and each still surfaces by
 * name when registration fails, so nothing was lost by removing the screen that
 * checked them separately.
 */
import { StatusBar } from 'expo-status-bar';
/*
 * React 19 removed the GLOBAL JSX namespace, so `JSX.Element` no longer
 * resolves without an import. It is exported from 'react' instead.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { AuthSessionManager, type AuthState } from './src/auth/authSessionManager';
import { createSecureSessionStore } from './src/auth/secureSessionStore';
import { createDeviceIdentity } from './src/push/deviceIdentity';
import { createPushTokenService } from './src/push/pushTokenService';
import { DeviceRegistrationService } from './src/push/deviceRegistrationService';
import { SignInScreen } from './src/screens/SignInScreen';
import { SignUpScreen } from './src/screens/SignUpScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { CallScreen } from './src/screens/CallScreen';

/** Not a secret: `EXPO_PUBLIC_` values are compiled into the bundle. */
const ACCOUNT_BASE_URL =
  process.env['EXPO_PUBLIC_ACCOUNT_URL'] ?? 'https://staging.consummate7.com/auth';

const auth = new AuthSessionManager({
  accountBaseUrl: ACCOUNT_BASE_URL,
  store: createSecureSessionStore(),
});

const devices = new DeviceRegistrationService({
  // The narrow capability, bound once. This is the only route from push code to
  // an authenticated request, and it cannot reach the credential behind it.
  authorizedFetch: (path, init) => auth.authorizedFetch(path, init),
  identity: createDeviceIdentity(),
  pushTokens: createPushTokenService(),
  platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
  label: Platform.OS === 'ios' ? 'iPhone' : 'Android phone',
});

/** Why somebody is at the sign-in screen, when it was not their choice. */
const NOTICE: Partial<Record<string, string>> = {
  expired: 'Your session expired. Sign in again to continue.',
  revoked: 'You were signed out. Sign in again to continue.',
};

export default function App(): JSX.Element {
  const [state, setState] = useState<AuthState>(auth.current());
  /*
   * Which signed-out screen to show. Deliberately NOT part of `AuthState`: the
   * session manager answers "is somebody signed in", and whether a person is
   * currently looking at sign-in or sign-up is a view concern that must not be
   * able to influence that answer.
   */
  const [wantsAccount, setWantsAccount] = useState(false);
  /*
   * The call in progress, if any. A view concern like `wantsAccount`, and
   * deliberately not part of `AuthState`: being in a call must not be able to
   * influence whether somebody is signed in.
   */
  const [activeCall, setActiveCall] = useState<string | null>(null);

  useEffect(() => {
    /*
     * Subscribed BEFORE restoring, or the state change restore produces lands
     * before anything is listening and the first render never updates.
     */
    const manager = auth as unknown as { onState?: ((s: AuthState) => void) | undefined };
    manager.onState = setState;
    void auth.restore();
    return () => {
      manager.onState = undefined;
    };
  }, []);

  /*
   * Rotation follows the SESSION, not the component. Stopped on unmount too, so
   * a backgrounded app does not leave a listener behind.
   */
  useEffect(() => {
    if (state.status !== 'signed-in') {
      devices.stopWatchingForRotation();
      return;
    }
    devices.startWatchingForRotation();
    return () => devices.stopWatchingForRotation();
  }, [state.status]);

  const signIn = useCallback((email: string, password: string) => auth.signIn(email, password), []);
  const signUp = useCallback(
    (email: string, password: string, username: string) => auth.signUp(email, password, username),
    [],
  );
  const register = useCallback(() => devices.register(), []);
  const signOut = useCallback(async () => {
    // Stopped FIRST: a rotation arriving during sign-out must not race the
    // clearing of the session it would otherwise register against.
    devices.stopWatchingForRotation();
    await auth.signOut();
  }, []);

  if (state.status === 'starting' || state.status === 'validating') {
    return (
      <View style={styles.centre}>
        <StatusBar style="light" />
        <ActivityIndicator color="#3ec9c0" size="large" />
        <Text style={styles.waiting}>Checking your session</Text>
      </View>
    );
  }

  if (state.status === 'signed-in') {
    if (activeCall !== null) {
      return (
        <>
          <StatusBar style="light" />
          <CallScreen
            callId={activeCall}
            /*
             * The account id doubles as the participant id. It is already
             * unique, already known to the gateway, and inventing a second
             * identity for the same person in the same call is how two views of
             * who is present come to disagree.
             */
            participantId={state.accountId}
            displayName={state.accountId}
            onLeave={() => setActiveCall(null)}
          />
        </>
      );
    }
    return (
      <>
        <StatusBar style="light" />
        <HomeScreen
          accountId={state.accountId}
          onRegister={register}
          onSignOut={signOut}
          onCall={setActiveCall}
        />
      </>
    );
  }

  if (wantsAccount) {
    return (
      <>
        <StatusBar style="light" />
        <SignUpScreen onSignUp={signUp} onBackToSignIn={() => setWantsAccount(false)} />
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SignInScreen
        onSignIn={signIn}
        onCreateAccount={() => setWantsAccount(true)}
        notice={NOTICE[state.reason ?? '']}
      />
    </>
  );
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    backgroundColor: '#0b0f14',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  waiting: { color: '#5d6874', fontSize: 14 },
});
