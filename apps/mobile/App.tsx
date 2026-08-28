/** @author masterzee001 */
/**
 * The app: chats, contacts, calls and a profile, behind one session.
 *
 * ONE SOURCE OF TRUTH ABOUT WHO IS SIGNED IN. Routing derives from
 * `AuthSessionManager` state; tabs, the open chat and the active call are view
 * state layered on top, and none of them can influence whether somebody is
 * signed in. Overlays win over tabs: an active call covers everything, an open
 * chat covers the tab bar, because a phone screen is one thing at a time.
 *
 * NOTIFICATIONS ARE ROUTES. A ring notification carries a callId and lands in
 * the call screen; a message notification carries the sender and lands in that
 * chat. Both are handled for the three lives of a notification: foreground
 * (listener), background tap (response listener), and cold start (the initial
 * response, read once). The payload is DATA -- the discreet message push
 * carries no words, so there is nothing to display until the app fetches.
 *
 * THE DEVICE REGISTERS ITSELF. Binding this phone to the account is not a
 * feature somebody should have to find a button for; it happens on every
 * signed-in start, the outcome is reported on the profile screen, and the
 * rotation listener keeps the token current for as long as the session lives.
 */
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
/*
 * React 19 removed the GLOBAL JSX namespace, so `JSX.Element` no longer
 * resolves without an import. It is exported from 'react' instead.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { AuthSessionManager, type AuthState } from './src/auth/authSessionManager';
import { createSecureSessionStore } from './src/auth/secureSessionStore';
import { createDeviceIdentity } from './src/push/deviceIdentity';
import { createPushTokenService } from './src/push/pushTokenService';
import {
  DeviceRegistrationService,
  type RegistrationOutcome,
} from './src/push/deviceRegistrationService';
import { randomId } from './src/push/randomId';
import { createApi } from './src/api/client';
import { configureAvatars } from './src/media/AvatarView';
import type { ContactPerson } from './src/api/client';
import { InsetsProvider, useBottomInset } from './src/ui/insets';
import { SignInScreen } from './src/screens/SignInScreen';
import { SignUpScreen } from './src/screens/SignUpScreen';
import { CallScreen } from './src/screens/CallScreen';
import { CallHomeScreen } from './src/screens/CallHomeScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { ContactsScreen } from './src/screens/ContactsScreen';
import { ConversationsScreen } from './src/screens/ConversationsScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';

/** Not a secret: `EXPO_PUBLIC_` values are compiled into the bundle. */
const ACCOUNT_BASE_URL =
  process.env['EXPO_PUBLIC_ACCOUNT_URL'] ?? 'https://staging.consummate7.com/auth';

const auth = new AuthSessionManager({
  accountBaseUrl: ACCOUNT_BASE_URL,
  store: createSecureSessionStore(),
});

const authorizedFetch = (path: string, init?: RequestInit) => auth.authorizedFetch(path, init);

/*
 * Avatars render through RN's Image, which sends the headers it is given; the
 * provider closure keeps token ownership inside AuthSessionManager, and
 * sign-out starves it immediately.
 */
configureAvatars({
  baseUrl: ACCOUNT_BASE_URL,
  headers: () => {
    const token = auth.callSessionToken();
    return token === null ? null : { authorization: `Bearer ${token}` };
  },
});
const api = createApi(authorizedFetch);

const devices = new DeviceRegistrationService({
  authorizedFetch,
  identity: createDeviceIdentity(),
  pushTokens: createPushTokenService(),
  platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
  label: Platform.OS === 'ios' ? 'iPhone' : 'Android phone',
});

/*
 * Foreground notifications still show. Without a handler Android suppresses
 * them while the app is open, and a ring that arrives mid-scroll would be a
 * ring nobody saw.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const NOTICE: Partial<Record<string, string>> = {
  expired: 'Your session expired. Sign in again to continue.',
  revoked: 'You were signed out. Sign in again to continue.',
};

type Tab = 'chats' | 'contacts' | 'call' | 'profile';

interface ActiveCall {
  readonly callId: string;
  /** Present when this call should ring a contact once joined. */
  readonly ring?: ContactPerson;
}

export default function App(): JSX.Element {
  return (
    <InsetsProvider>
      <AppInner />
    </InsetsProvider>
  );
}

function AppInner(): JSX.Element {
  const [state, setState] = useState<AuthState>(auth.current());
  const [wantsAccount, setWantsAccount] = useState(false);
  const [tab, setTab] = useState<Tab>('chats');
  const [chatWith, setChatWith] = useState<ContactPerson | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [deviceOutcome, setDeviceOutcome] = useState<RegistrationOutcome | null>(null);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  /*
   * The name other people see in a call. The join used to send the ACCOUNT ID
   * as the display name, so the other side's tile read `acct_1d12f6...` -- an
   * identifier where a person was promised.
   */
  const [callName, setCallName] = useState<string | null>(null);
  /** The account's default language; the language their calls enter with. */
  const [callLanguages, setCallLanguages] = useState<{
    speak?: 'en' | 'es' | 'fr';
    hear?: 'en' | 'es' | 'fr';
  }>({});
  const handledColdStart = useRef(false);
  /*
   * ABOVE EVERY EARLY RETURN. This hook once sat just before the tab-bar
   * JSX -- below the signed-out, call and chat returns -- so signing in
   * changed the number of hooks between renders and React refused the
   * tree on a real phone. Rules of Hooks: unconditional, top of the
   * component, always.
   */
  const bottomInset = useBottomInset();

  useEffect(() => {
    const manager = auth as unknown as { onState?: ((s: AuthState) => void) | undefined };
    manager.onState = setState;
    void auth.restore();
    return () => {
      manager.onState = undefined;
    };
  }, []);

  /** Open the chat with an account id, resolving the person when possible. */
  const openChatWithAccount = useCallback(async (accountId: string) => {
    const contacts = await api.contacts();
    const person = contacts.ok
      ? (contacts.value.contacts.find((c) => c.accountId === accountId) ?? null)
      : null;
    setChatWith(person ?? { accountId, username: null, displayName: null });
    setTab('chats');
  }, []);

  const routeNotification = useCallback(
    (data: Record<string, unknown>) => {
      const kind = String(data['kind'] ?? '');
      if (kind === 'call' && typeof data['callId'] === 'string') {
        setActiveCall({ callId: data['callId'] });
      } else if (kind === 'message' && typeof data['fromAccountId'] === 'string') {
        void openChatWithAccount(data['fromAccountId']);
      }
    },
    [openChatWithAccount],
  );

  /* Taps on notifications: background, and -- exactly once -- cold start. */
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      routeNotification(
        (response.notification.request.content.data ?? {}) as Record<string, unknown>,
      );
    });
    if (!handledColdStart.current) {
      handledColdStart.current = true;
      void Notifications.getLastNotificationResponseAsync().then((response) => {
        if (response !== null) {
          routeNotification(
            (response.notification.request.content.data ?? {}) as Record<string, unknown>,
          );
        }
      });
    }
    return () => subscription.remove();
  }, [routeNotification]);

  /* The session drives registration, rotation, and the verification banner. */
  useEffect(() => {
    if (state.status !== 'signed-in') {
      devices.stopWatchingForRotation();
      setDeviceOutcome(null);
      setEmailVerified(null);
      return;
    }
    void devices.register().then(setDeviceOutcome);
    devices.startWatchingForRotation();
    void api.verification().then((result) => {
      if (result.ok) setEmailVerified(result.value.email === 'verified');
    });
    void api.me().then((result) => {
      if (result.ok) {
        setCallName(result.value.displayName ?? result.value.username);
        const speak = result.value.spokenLanguage ?? result.value.defaultLanguage;
        const hear = result.value.listeningLanguage ?? result.value.defaultLanguage;
        setCallLanguages({
          ...(speak == null ? {} : { speak }),
          ...(hear == null ? {} : { hear }),
        });
      }
    });
    return () => devices.stopWatchingForRotation();
  }, [state.status]);

  const signIn = useCallback((email: string, password: string) => auth.signIn(email, password), []);
  const signUp = useCallback(
    (email: string, password: string, username: string) => auth.signUp(email, password, username),
    [],
  );
  const signOut = useCallback(async () => {
    devices.stopWatchingForRotation();
    setChatWith(null);
    setActiveCall(null);
    await auth.signOut();
  }, []);

  const callContact = useCallback((person: ContactPerson) => {
    setActiveCall({ callId: `ring-${randomId('').slice(0, 8)}`, ring: person });
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

  if (state.status !== 'signed-in') {
    return wantsAccount ? (
      <>
        <StatusBar style="light" />
        <SignUpScreen onSignUp={signUp} onBackToSignIn={() => setWantsAccount(false)} />
      </>
    ) : (
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

  if (activeCall !== null) {
    const ringPerson = activeCall.ring;
    return (
      <>
        <StatusBar style="light" />
        <CallScreen
          callId={activeCall.callId}
          displayName={callName ?? state.accountId}
          {...(callLanguages.speak === undefined ? {} : { speakLanguage: callLanguages.speak })}
          {...(callLanguages.hear === undefined ? {} : { hearLanguage: callLanguages.hear })}
          sessionToken={auth.callSessionToken()}
          ringName={
            ringPerson === undefined
              ? undefined
              : (ringPerson.displayName ?? ringPerson.username ?? ringPerson.accountId)
          }
          onRing={
            ringPerson === undefined
              ? undefined
              : async (callId) => {
                  const result = await api.ring(ringPerson.accountId, callId);
                  return result.ok ? result.value.reachedDevices : null;
                }
          }
          onLeave={() => setActiveCall(null)}
        />
      </>
    );
  }

  if (chatWith !== null) {
    return (
      <>
        <StatusBar style="light" />
        <ChatScreen
          api={api}
          authorizedFetch={authorizedFetch}
          selfId={state.accountId}
          partner={chatWith}
          onBack={() => setChatWith(null)}
          onCall={callContact}
        />
      </>
    );
  }

  return (
    <View style={styles.shell}>
      <StatusBar style="light" />
      <View style={styles.tabContent}>
        {tab === 'chats' && (
          <ConversationsScreen
            api={api}
            selfId={state.accountId}
            onOpen={setChatWith}
            onFindContacts={() => setTab('contacts')}
          />
        )}
        {tab === 'contacts' && (
          <ContactsScreen api={api} onMessage={setChatWith} onCall={callContact} />
        )}
        {tab === 'call' && (
          <CallHomeScreen
            emailVerified={emailVerified}
            onJoin={(callId) => setActiveCall({ callId })}
          />
        )}
        {tab === 'profile' && (
          <ProfileScreen
            api={api}
            deviceOutcome={deviceOutcome}
            onRetryDevice={async () => {
              setDeviceOutcome(await devices.register());
            }}
            onSignOut={signOut}
          />
        )}
      </View>
      <View style={[styles.tabBar, { paddingBottom: bottomInset + 8 }]}>
        {(
          [
            ['chats', 'Chats'],
            ['contacts', 'Contacts'],
            ['call', 'Call'],
            ['profile', 'Profile'],
          ] as const
        ).map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            accessibilityRole="button"
            style={styles.tabButton}
          >
            <Text style={[styles.tabLabel, tab === key && styles.tabActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
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
  shell: { flex: 1, backgroundColor: '#0b0f14', paddingTop: 40 },
  tabContent: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#161d25',
    // Bottom padding is measured at render: the phone's own bar plus 8.
    paddingTop: 10,
    backgroundColor: '#0b0f14',
  },
  tabButton: { flex: 1, alignItems: 'center', paddingVertical: 6 },
  tabLabel: { color: '#5d6874', fontSize: 13, fontWeight: '600' },
  tabActive: { color: '#3ec9c0' },
});
