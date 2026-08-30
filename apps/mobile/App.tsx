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
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
/*
 * React 19 removed the GLOBAL JSX namespace, so `JSX.Element` no longer
 * resolves without an import. It is exported from 'react' instead.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { AppState, BackHandler, Platform, Pressable, StyleSheet, Text, ToastAndroid, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
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
import type { ContactPerson, Profile } from './src/api/client';
import type { ChannelSummary } from './src/api/channelDirectory';
import type { ConferenceSetup } from './src/conference/conferenceSetup';
import { rememberConference } from './src/conference/recentConferences';
import { InsetsProvider, useBottomInset } from './src/ui/insets';
import { AppHeader } from './src/ui/AppHeader';
import { C7, C7Ground } from './src/ui/c7';
import { Icon, type IconName } from './src/ui/icons';
import { ProgrammesScreen } from './src/screens/ProgrammesScreen';
import { SignInScreen } from './src/screens/SignInScreen';
import { SignUpScreen } from './src/screens/SignUpScreen';
import { CallScreen } from './src/screens/CallScreen';
import { CallHomeScreen } from './src/screens/CallHomeScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { ContactsScreen } from './src/screens/ContactsScreen';
import { ConversationsScreen } from './src/screens/ConversationsScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { IncomingCallScreen } from './src/screens/IncomingCallScreen';
import { PersonProfileScreen } from './src/screens/PersonProfileScreen';
import { ProgrammeViewerScreen } from './src/screens/ProgrammeViewerScreen';
import { BootScreen } from './src/screens/BootScreen';
import { createDirectCallApi } from './src/call/directCallApi';
import { foregroundPresentationFor } from './src/push/callNotificationPresentation';
import { videofyCall } from './src/native/videofyCall';
import { createAppLock } from './src/auth/appLock';
import { LockScreen } from './src/screens/LockScreen';

/** Not a secret: `EXPO_PUBLIC_` values are compiled into the bundle. */
const GATEWAY_BASE_URL =
  process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://staging.consummate7.com';

/** Not a secret: `EXPO_PUBLIC_` values are compiled into the bundle. */
const ACCOUNT_BASE_URL =
  process.env['EXPO_PUBLIC_ACCOUNT_URL'] ?? 'https://staging.consummate7.com/auth';

/*
 * THE BRAND SCREEN, NOT A WHITE FRAME (founder ruling 29 Aug 2026). The OS
 * splash (same ground, same mark) is held until BootScreen has painted its
 * identical first frame; global scope, not awaited, or it runs too late.
 */
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ duration: 250 });

const auth = new AuthSessionManager({
  accountBaseUrl: ACCOUNT_BASE_URL,
  store: createSecureSessionStore(),
});

const authorizedFetch = (path: string, init?: RequestInit) => auth.authorizedFetch(path, init);

/** The one-hour lock in front of the until-sign-out session; its stamps live in the secure store. */
const appLock = createAppLock({
  read: (key) => SecureStore.getItemAsync(key),
  write: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
});

/**
 * Prove the password without touching the session: a sign-in whose result
 * is discarded. 200 = right, 401 = wrong, anything else = could not check.
 */
async function unlockWithPassword(password: string): Promise<'ok' | 'wrong' | 'network'> {
  try {
    const current = await auth.authorizedFetch('/sessions/current');
    if (current === null || !current.ok) return 'network';
    const { email } = (await current.json()) as { email?: string };
    if (typeof email !== 'string') return 'network';
    const response = await fetch(`${ACCOUNT_BASE_URL}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client: 'device' }),
    });
    if (response.ok) return 'ok';
    return response.status === 401 ? 'wrong' : 'network';
  } catch {
    return 'network';
  }
}

/*
 * Avatars render through RN's Image, which sends the headers it is given; the
 * provider closure keeps token ownership inside AuthSessionManager, and
 * sign-out starves it immediately.
 */
// Pictures travel through the authorised fetch, never through Image headers (see AvatarView).
configureAvatars({ fetch: (path) => auth.authorizedFetch(path) });
const api = createApi(authorizedFetch);
const directCalls = createDirectCallApi({
  gatewayUrl: GATEWAY_BASE_URL,
  sessionToken: () => auth.callSessionToken(),
});

/*
 * THE CALLS CHANNEL. Android decides ringtone, vibration and heads-up
 * behaviour per channel; a call push routed to the default channel is a
 * quiet banner. This channel rings.
 */
void Notifications.setNotificationChannelAsync('calls', {
  name: 'Calls',
  importance: Notifications.AndroidImportance.MAX,
  // No `sound`: on Android that field names a BUNDLED file, and naming one
  // that is not in the APK logs an error at every launch. Left unset, the
  // channel uses the system's default notification sound at MAX importance.
  // A real ringtone asset rides the native Telecom wave.
  enableVibrate: true,
  vibrationPattern: [0, 400, 200, 400, 200, 400],
  lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  bypassDnd: false,
}).catch(() => undefined);

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
  // A call in the FOREGROUND is presented by the incoming-call screen (which
  // sends the ringing acknowledgement), not by a banner; the OS keeps the
  // sound. See callNotificationPresentation.ts.
  handleNotification: async (notification) =>
    foregroundPresentationFor(
      (notification.request.content.data ?? null) as Record<string, unknown> | null,
    ),
});

const NOTICE: Partial<Record<string, string>> = {
  expired: 'Your session expired. Sign in again to continue.',
  revoked: 'You were signed out. Sign in again to continue.',
};

type Tab = 'chats' | 'people' | 'programmes' | 'conf' | 'profile';

/** What the masthead calls each tab. */
const TAB_TITLES: Record<Tab, string> = {
  chats: 'Chats',
  people: 'People',
  programmes: 'C7 Streams',
  conf: 'Conference',
  profile: 'Profile',
};

const TABS: readonly { key: Tab; label: string; icon: IconName }[] = [
  { key: 'chats', label: 'Chats', icon: 'chat' },
  { key: 'people', label: 'People', icon: 'people' },
  { key: 'programmes', label: 'Programmes', icon: 'programmes' },
  { key: 'conf', label: 'Conference', icon: 'conference' },
  { key: 'profile', label: 'Profile', icon: 'profile' },
];

/**
 * A call is DIRECT (person-to-person, internal session id, no visible code)
 * or a CONFERENCE (the only kind with a shareable code). Founder ruling
 * 2026-08-28. `ring` is set only on the CALLER's side of a direct call: the
 * callee answers an existing session and rings nobody.
 */
type ActiveCall =
  | {
      readonly kind: 'direct';
      readonly callId: string;
      readonly peer: { readonly accountId: string; readonly name: string };
      readonly ring: boolean;
    }
  | { readonly kind: 'conference'; readonly callId: string; readonly setup?: ConferenceSetup };

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
  /** The header's add-person control opens the add card on People. */
  const [addingContact, setAddingContact] = useState(false);
  const [chatWith, setChatWith] = useState<ContactPerson | null>(null);
  /** Somebody's profile, opened from their picture or name anywhere. */
  const [viewingPerson, setViewingPerson] = useState<ContactPerson | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  /** An incoming direct call the server confirmed is live. */
  const [incomingCall, setIncomingCall] = useState<{
    callId: string;
    caller: { accountId: string; name: string };
    mode: 'normal' | 'translated';
  } | null>(null);
  const [deviceOutcome, setDeviceOutcome] = useState<RegistrationOutcome | null>(null);
  /** A channel a live-reminder push asked us to open; consumed by the Programmes tab. */
  const [openChannelId, setOpenChannelId] = useState<string | null>(null);
  /** The programme being watched, inside the app. */
  const [viewingChannel, setViewingChannel] = useState<ChannelSummary | null>(null);
  /** The signed-in person's own profile, for "Share my contact". */
  const [me, setMe] = useState<Profile | null>(null);
  /** Stays false until BootScreen has finished its exit fade; the session status alone would cut it off mid-frame. */
  const [booted, setBooted] = useState(false);
  const hideSplash = useCallback(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);
  const onBooted = useCallback(() => setBooted(true), []);
  /** The app lock: one hour away, then biometrics or the password. Never in front of a call. */
  const [locked, setLocked] = useState(false);
  const [lockEmail, setLockEmail] = useState<string | null>(null);
  const [biometricsPreferred, setBiometricsPreferred] = useState(true);
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

  const routedCalls = useRef(new Set<string>());
  const routeNotification = useCallback(
    (data: Record<string, unknown>) => {
      const kind = String(data['kind'] ?? '');
      if (kind === 'call' && typeof data['callId'] === 'string') {
        if (routedCalls.current.has(data['callId'])) return;
        routedCalls.current.add(data['callId']);
        /*
         * A PUSH IS ONLY A WAKE-UP. The device asks the server whether the
         * call is still live; a stale push (after no answer, decline or hang
         * up) is answered 'expired' and stays silent. Only a live call shows
         * the incoming screen -- and showing it is what the ringing
         * acknowledgement reports, so the caller's "Ringing…" is true.
         */
        const callId = data['callId'];
        const fromAccountId = typeof data['fromAccountId'] === 'string' ? data['fromAccountId'] : '';
        const fromName =
          typeof data['fromName'] === 'string' && data['fromName'].length > 0
            ? data['fromName']
            : 'Caller';
        void directCalls.check(callId).then((check) => {
          if (check === null || !check.ring) return;
          setIncomingCall({
            callId,
            caller: { accountId: check.callerAccountId || fromAccountId, name: check.callerName || fromName },
            mode: check.mode,
          });
          void directCalls.ackRinging(callId);
        });
      } else if (kind === 'message' && typeof data['fromAccountId'] === 'string') {
        void openChatWithAccount(data['fromAccountId']);
      } else if (kind === 'channel-live' && typeof data['channelId'] === 'string') {
        // "Interested" delivered: straight to the programme that just went live.
        setChatWith(null);
        setViewingPerson(null);
        setTab('programmes');
        setOpenChannelId(data['channelId']);
      }
    },
    [openChatWithAccount],
  );

  /*
   * THE THREE LIVES OF A NOTIFICATION, honestly stated (P8 review finding):
   *
   *   FOREGROUND  `addNotificationReceivedListener` fires the moment the push
   *               arrives, so a call is checked with the server, presented
   *               by the incoming-call screen and ACKNOWLEDGED as ringing
   *               without anybody tapping anything. This is the only state
   *               in which JavaScript can prove "device is presenting the
   *               call" promptly.
   *   BACKGROUND  Android renders and rings the OS notification itself; no
   *   / LOCKED    JavaScript runs until the person TAPS it. Only then does
   *               the response listener route the call, check it with the
   *               server and acknowledge ringing -- so the caller may read
   *               "Calling…" while the callee's phone is audibly ringing.
   *               That gap is real and is NOT papered over here: closing it
   *               is the native Android call receiver / Telecom wave.
   *   COLD START  the last response is read exactly once.
   *
   * A call id is routed once per life: receipt and tap both fire in the
   * foreground.
   */
  /*
   * THE NATIVE LAYER OWNS INCOMING CALLS (coherent wave, 29 Aug). With the
   * module present, a call push is data-only and never reaches
   * expo-notifications: the native service validates it, ACKS ringing and
   * rings the phone in every app state. JS hears 'incoming' (show our own
   * surface, do NOT ack again), 'answer' (take the seat), 'decline' and
   * 'timeout' (drop the surface). An Answer tapped while the app was cold
   * is consumed once on start. Without the module the old path stands.
   */
  useEffect(() => {
    if (!videofyCall.available || state.status !== 'signed-in') return undefined;
    const pending = videofyCall.consumePendingAnswer(state.accountId);
    if (pending !== null) {
      setIncomingCall(null);
      setActiveCall({ kind: 'direct', callId: pending.callId, peer: { accountId: pending.callerAccountId, name: pending.callerName }, ring: false });
    }
    const incoming = videofyCall.onIncoming((call) => {
      setIncomingCall({ callId: call.callId, caller: { accountId: call.callerAccountId, name: call.callerName }, mode: call.mode });
    });
    const answer = videofyCall.onAnswer((call) => {
      setIncomingCall(null);
      setActiveCall({ kind: 'direct', callId: call.callId, peer: { accountId: call.callerAccountId, name: call.callerName }, ring: false });
    });
    const decline = videofyCall.onDecline(() => setIncomingCall(null));
    const timeout = videofyCall.onTimeout(() => setIncomingCall(null));
    return () => {
      incoming?.remove();
      answer?.remove();
      decline?.remove();
      timeout?.remove();
    };
  }, [state.status]);

  /* The ring credential: the native receiver's key to the gateway, bound to this account and the session's expiry. */
  useEffect(() => {
    if (!videofyCall.available) return;
    const token = state.status === 'signed-in' ? auth.callSessionToken() : null;
    const expiresAt = auth.sessionExpiresAtMs();
    if (token === null || state.status !== 'signed-in' || expiresAt === null) videofyCall.clearRingCredential();
    else videofyCall.setRingCredential(GATEWAY_BASE_URL, token, state.accountId, expiresAt);
  }, [state]);

  useEffect(() => {
    const received = Notifications.addNotificationReceivedListener((notification) => {
      routeNotification((notification.request.content.data ?? {}) as Record<string, unknown>);
    });
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
    return () => {
      received.remove();
      subscription.remove();
    };
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
      if (result.ok) setMe(result.value);
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

  /*
   * THE PHONE'S BACK BUTTON (founder 30 Aug: "nav back button exits the app,
   * no warning"). Back means "one step back": close the programme, the
   * profile, the chat, the add card; return to Chats from another tab. At
   * the root, one press says "Press back again to exit" and a second press
   * within two seconds leaves. During a ring or a call, back does nothing --
   * leaving a call is the red button, never an accidental swipe.
   */
  const lastBackAt = useRef(0);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (activeCall !== null || incomingCall !== null || locked) return true;
      if (viewingChannel !== null) {
        setViewingChannel(null);
        setOpenChannelId(null);
        return true;
      }
      if (viewingPerson !== null) {
        setViewingPerson(null);
        return true;
      }
      if (chatWith !== null) {
        setChatWith(null);
        return true;
      }
      if (addingContact) {
        setAddingContact(false);
        return true;
      }
      if (tab !== 'chats') {
        setTab('chats');
        return true;
      }
      const now = Date.now();
      if (now - lastBackAt.current < 2_000) return false;
      lastBackAt.current = now;
      if (Platform.OS === 'android') ToastAndroid.show('Press back again to exit', ToastAndroid.SHORT);
      return true;
    });
    return () => subscription.remove();
  }, [activeCall, incomingCall, locked, viewingChannel, viewingPerson, chatWith, addingContact, tab]);

  /*
   * PRESENCE. A heartbeat a minute while the app is on screen -- 'busy' in a
   * call -- and nothing at all in the background, so 120 s of silence reads
   * as away, which is what it is. Only accepted contacts ever see it.
   */
  useEffect(() => {
    if (state.status !== 'signed-in' || locked) return undefined;
    let foreground = AppState.currentState === 'active' || AppState.currentState === 'unknown';
    const beat = (): void => {
      if (!foreground) return;
      void api.heartbeat(inCallRef.current ? 'busy' : 'active');
    };
    beat();
    const timer = setInterval(beat, 60_000);
    const subscription = AppState.addEventListener('change', (next) => {
      foreground = next === 'active';
      if (foreground) beat();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [state.status, locked]);

  /*
   * THE LOCK CLOCK. Leaving the foreground stamps the time; returning judges
   * it (an hour or more away locks, unless a call is up), renews the device
   * session while it is used, and a cold start is judged by the stamp the
   * last background left behind.
   */
  const inCallRef = useRef(false);
  inCallRef.current = activeCall !== null || incomingCall !== null;
  useEffect(() => {
    if (state.status !== 'signed-in') {
      setLocked(false);
      return undefined;
    }
    let live = true;
    const judge = async (): Promise<void> => {
      const [shouldLock, preferred] = await Promise.all([
        appLock.returnedToForeground(Date.now(), inCallRef.current),
        appLock.biometricsPreferred(),
      ]);
      if (!live) return;
      setBiometricsPreferred(preferred);
      if (shouldLock) setLocked(true);
      void auth.renewIfNeeded();
    };
    void judge();
    void auth.authorizedFetch('/sessions/current').then(async (response) => {
      if (response === null || !response.ok || !live) return;
      const body = (await response.json()) as { email?: string };
      if (live && typeof body.email === 'string') setLockEmail(body.email);
    }).catch(() => undefined);
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void judge();
      else void appLock.leftForeground(Date.now());
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, [state.status]);
  const signUp = useCallback(
    (email: string, password: string, username: string) => auth.signUp(email, password, username),
    [],
  );
  /*
   * SIGN-OUT IS ONE TRANSITION, IN ORDER: forget this phone on the account
   * while the session is still valid (no push can reach a phone nobody is
   * signed in to), clear everything the native layer holds (credential,
   * parked Answer, ring), drop the screens, then end the session.
   */
  const signOut = useCallback(async () => {
    setIncomingCall(null);
    setChatWith(null);
    setActiveCall(null);
    setViewingChannel(null);
    setMe(null);
    await devices.unregister();
    videofyCall.clearRingCredential();
    await appLock.clear();
    setLocked(false);
    await auth.signOut();
  }, []);

  const callContact = useCallback((person: ContactPerson) => {
    setActiveCall({
      kind: 'direct',
      callId: `ring-${randomId('').slice(0, 8)}`,
      peer: {
        accountId: person.accountId,
        name: person.displayName ?? person.username ?? person.accountId,
      },
      ring: true,
    });
  }, []);

  // `validating` only ever happens at launch (AuthSessionManager.restore), so !booted covers the old condition plus the exit fade.
  if (!booted) {
    return <BootScreen status={state.status} onFirstFrame={hideSplash} onReady={onBooted} />;
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
          notice={NOTICE[state.status === 'signed-out' ? (state.reason ?? '') : '']}
        />
      </>
    );
  }

  if (activeCall === null && incomingCall !== null) {
    const ringing = incomingCall;
    return (
      <>
        <StatusBar style="light" />
        <IncomingCallScreen
          caller={ringing.caller}
          mode={ringing.mode}
          onAnswer={() => {
            setIncomingCall(null);
            videofyCall.reportAnswered(ringing.callId);
            setActiveCall({
              kind: 'direct',
              callId: ringing.callId,
              peer: ringing.caller,
              ring: false,
            });
          }}
          onDecline={() => {
            setIncomingCall(null);
            videofyCall.reportCallEnded(ringing.callId);
            void directCalls.decline(ringing.callId);
          }}
        />
      </>
    );
  }

  if (activeCall !== null) {
    const ringPeer = activeCall.kind === 'direct' && activeCall.ring ? activeCall.peer : null;
    return (
      <>
        <StatusBar style="light" />
        <CallScreen
          call={
            activeCall.kind === 'direct'
              ? { kind: 'direct', callId: activeCall.callId, peer: activeCall.peer }
              : { kind: 'conference', callId: activeCall.callId, ...(activeCall.setup === undefined ? {} : { setup: activeCall.setup }) }
          }
          displayName={callName ?? state.accountId}
          {...(callLanguages.speak === undefined ? {} : { speakLanguage: callLanguages.speak })}
          {...(callLanguages.hear === undefined ? {} : { hearLanguage: callLanguages.hear })}
          sessionToken={auth.callSessionToken()}
          onRing={
            ringPeer === null
              ? undefined
              : async (callId) => {
                  const result = await api.ring(ringPeer.accountId, callId);
                  return result.ok ? result.value.reachedDevices : null;
                }
          }
          onLeave={() => {
            videofyCall.reportCallEnded(activeCall.callId);
            setActiveCall(null);
          }}
        />
      </>
    );
  }

  // The lock stands behind the call screens above and in front of everything below.
  if (locked) {
    return (
      <>
        <StatusBar style="light" />
        <LockScreen
          email={lockEmail}
          biometricsPreferred={biometricsPreferred}
          onUnlockWithPassword={unlockWithPassword}
          onUnlocked={() => {
            setLocked(false);
            void appLock.unlocked();
          }}
          onSignOut={() => void signOut()}
        />
      </>
    );
  }

  if (viewingChannel !== null) {
    return (
      <>
        <StatusBar style="light" />
        <ProgrammeViewerScreen
          channel={viewingChannel}
          api={api}
          onBack={() => {
            setViewingChannel(null);
            setOpenChannelId(null);
          }}
        />
      </>
    );
  }

  if (viewingPerson !== null) {
    const person = viewingPerson;
    return (
      <>
        <StatusBar style="light" />
        <PersonProfileScreen
          api={api}
          accountId={person.accountId}
          fallback={person}
          onBack={() => setViewingPerson(null)}
          onMessage={(target) => {
            setViewingPerson(null);
            setChatWith(target);
          }}
          onCall={(target) => {
            setViewingPerson(null);
            callContact(target);
          }}
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
          onOpenPerson={setViewingPerson}
        />
      </>
    );
  }

  return (
    <View style={styles.shell}>
      <C7Ground />
      <StatusBar style="light" />
      <AppHeader
        title={TAB_TITLES[tab]}
        streamsActive={tab === 'programmes'}
        onStreams={() => setTab('programmes')}
        right={
          tab === 'people' ? (
            <Pressable
              onPress={() => setAddingContact(true)}
              accessibilityRole="button"
              accessibilityLabel="Add a contact"
              hitSlop={8}
              style={styles.headerControl}
            >
              <Icon name="add-person" size={20} color={C7.teal} />
            </Pressable>
          ) : undefined
        }
      />
      <View style={styles.tabContent}>
        {tab === 'chats' && (
          <ConversationsScreen
            api={api}
            selfId={state.accountId}
            onOpen={setChatWith}
            onOpenPerson={setViewingPerson}
            onFindContacts={() => setTab('people')}
          />
        )}
        {tab === 'people' && (
          <ContactsScreen
            api={api}
            onMessage={setChatWith}
            onCall={callContact}
            onOpenPerson={setViewingPerson}
            adding={addingContact}
            onAddingChange={setAddingContact}
            self={me === null ? null : { username: me.username, displayName: me.displayName }}
          />
        )}
        {tab === 'programmes' && <ProgrammesScreen api={api} onOpen={setViewingChannel} openChannelId={openChannelId} />}
        {tab === 'conf' && (
          <CallHomeScreen
            emailVerified={emailVerified}
            onJoin={(callId, setup) => {
              void rememberConference({
                callId,
                role: setup === undefined ? 'joined' : 'started',
                title: setup?.title ?? null,
                ...(setup === undefined ? {} : { setup }),
              });
              setActiveCall({ kind: 'conference', callId, ...(setup === undefined ? {} : { setup }) });
            }}
          />
        )}
        {tab === 'profile' && (
          <ProfileScreen
            api={api}
            biometricsPreferred={biometricsPreferred}
            onBiometricsPreferred={(on) => {
              setBiometricsPreferred(on);
              void appLock.setBiometricsPreferred(on);
            }}
            sessionToken={() => auth.callSessionToken()}
            probeAvatar={async (accountId) => {
              try {
                const response = await authorizedFetch(`/avatars/${encodeURIComponent(accountId)}`);
                if (response === null) return null;
                const blob = await response.blob().catch(() => null);
                return {
                  status: response.status,
                  contentType: response.headers.get('content-type') ?? 'unknown',
                  bytes: blob?.size ?? Number(response.headers.get('content-length') ?? 0),
                };
              } catch {
                return null;
              }
            }}
            deviceOutcome={deviceOutcome}
            onRetryDevice={async () => {
              setDeviceOutcome(await devices.register());
            }}
            onSignOut={signOut}
          />
        )}
      </View>
      <View style={[styles.tabBar, { paddingBottom: bottomInset + 8 }]}>
        {TABS.map(({ key, label, icon }) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            accessibilityRole="button"
            accessibilityState={{ selected: tab === key }}
            style={styles.tabButton}
          >
            <Icon name={icon} size={24} color={tab === key ? C7.teal : C7.muted} />
            <Text style={[styles.tabLabel, tab === key && styles.tabActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The masthead carries the top inset now; the shell starts at the edge.
  // The C7 ground paints behind everything; content stays transparent.
  shell: { flex: 1, backgroundColor: '#070b12' },
  tabContent: { flex: 1 },
  headerControl: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: 'rgba(62,201,192,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: 'rgba(120,200,200,0.12)',
    // Bottom padding is measured at render: the phone's own bar plus 8.
    paddingTop: 10,
    backgroundColor: 'rgba(7,11,18,0.92)',
  },
  tabButton: { flex: 1, alignItems: 'center', paddingVertical: 4, gap: 5 },
  tabLabel: { color: '#8d99a6', fontSize: 12, fontWeight: '500' },
  tabActive: { color: '#3ec9c0' },
});
