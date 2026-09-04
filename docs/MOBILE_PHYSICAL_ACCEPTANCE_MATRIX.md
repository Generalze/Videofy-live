# Mobile physical acceptance — the matrix that decides the release

**What this document is for.** The server-side contract suite
(`scripts/mobile-contract-acceptance.mjs`, `docs/MOBILE_CONTRACT_ACCEPTANCE.md`)
can establish *server contract ready for mobile*. It cannot establish
*Android client accepted* — founder ruling, 30 Aug 2026. Only this matrix,
run on real handsets with a real build, can.

**When.** The Expo Android build quota resets 1 Sep 2026. The founder ruled
against buying an upgrade to gain two days, so the sequence is:

```
build the exact production-candidate SHA
  → install on two real Android devices
  → execute this matrix
  → correct defects
  → rebuild
  → accept
```

**Build command** (from `apps/mobile`, after the production cutover):

```
npx eas-cli build --profile production-apk --platform android --non-interactive --no-wait
```

`production-apk` points every `EXPO_PUBLIC_*` at `https://consummate7.com`
(see `apps/mobile/eas.json`). `preview` points at staging. A build made with
the wrong profile is a failed run of this matrix, not a passing one:
**step 0 is to prove which origin the installed app is talking to.**

**Devices.** Two real Android handsets, different manufacturers where
possible (OEM behaviour differs most in exactly the places this matrix
probes: full-screen intents, battery optimisation, Telecom, audio focus).
Record for each: manufacturer, model, Android version, and whether the app
was granted notifications, microphone, camera and full-screen intent.

**How to record a result.** Every row is PASS, FAIL or BLOCKED, with what
was observed — a time, a screenshot, or the sentence on screen. "Looks
right" is not a result. A row that cannot be run (no second person, no SIM)
is BLOCKED and stays visible; it is never quietly a PASS.

---

## 0 · Provenance

| # | Check | Pass criterion |
| --- | --- | --- |
| 0.1 | Installed build's origin | The app reaches `consummate7.com`, not staging. Sign in fails against a staging-only account, or Profile → diagnostics names the production host. |
| 0.2 | Build SHA | The APK was built from the production-candidate SHA recorded in the cutover report. |

## 1 · First run and identity

| # | Check | Pass criterion |
| --- | --- | --- |
| 1.1 | Startup brand screen | On a cold launch the C7 mark, "Videofy Live" and "Speak naturally. Be understood everywhere." appear immediately. **No white frame at any point** — watch the first 300 ms, on a cold start after a reboot. |
| 1.2 | Splash → app hand-off | The brand screen fades into the app; no flash, no second loading screen. |
| 1.3 | Sign up | A new production account can be created; the verification email arrives (production Resend). |
| 1.4 | Sign in | An existing account signs in; the tab bar appears. |
| 1.5 | Session survives | Force-stop the app, relaunch: still signed in. Reboot the phone, relaunch: still signed in. |
| 1.6 | Session ends only on sign-out | After 24 h of ordinary use the session is still valid (device class, 180 days, renewed in use). |
| 1.7 | App lock | Leave the app for one hour (or set the clock forward), return: the lock screen appears. |
| 1.8 | Biometric unlock | Fingerprint/face unlocks in one touch. Cancel → the password path unlocks. Wrong password → "That password is not right." |
| 1.9 | Lock never blocks a call | While a call is ringing or connected, the lock does not appear; it waits until the call ends. |
| 1.10 | Sign out | Sign out clears the session; the next launch shows sign-in; a call to this account no longer rings this phone. |

## 2 · The defects reported on 30 Aug (regression gate)

| # | Check | Pass criterion |
| --- | --- | --- |
| 2.1 | No call count on Profile | The counts row reads Connections · Following · Saved. No "Calls". |
| 2.2 | Back button | Back steps out of a programme, a profile, a chat, the add-contact card, and from another tab returns to Chats. |
| 2.3 | Back at the root | One press shows "Press back again to exit"; a second within two seconds exits; a later single press does not. |
| 2.4 | Back during a call | Back does nothing while ringing or connected. |
| 2.5 | Voice note plays | Record and send a voice note; it plays on both handsets. **No "Playback failed on this device."** |
| 2.6 | Translated voice note plays | The translated rendition plays, and the Original/Translated toggle switches between them. |
| 2.7 | Playback speed | 1× → 1.5× → 2× cycles and audibly changes speed. |
| 2.8 | Profile picture shows | Upload a picture on device A; it appears on device A's Profile and on device B's view of that person. **No "Image failed … 401".** |
| 2.9 | Avatar everywhere | The picture appears in Chats rows, People rows, the chat header and the call screen. |

## 3 · Calling — the telephone

| # | Check | Pass criterion |
| --- | --- | --- |
| 3.1 | Ring, app open | B's phone rings within **3 s** of A tapping call. Record the time. |
| 3.2 | Ring, app backgrounded | Same, with B's app swiped away. |
| 3.3 | Ring, screen locked | The call takes the full screen over the lock screen, with Answer and Decline. |
| 3.4 | Ring, phone rebooted, never opened | The push still rings the phone (cold start). |
| 3.5 | Answer → audio | Two-way audio within **2 s** of answering. Record the time. |
| 3.6 | Telecom ownership | While connected, Android treats it as a call: the speaker control works, and another incoming phone call is handled sanely. |
| 3.7 | Decline | Declining ends the call on both sides at once; A sees the call end, not a hang. |
| 3.8 | No answer | An unanswered call ends by itself; both sides show a missed call in history. |
| 3.9 | Hang up | Either side ending ends it for both. |
| 3.10 | Video | Camera on: the other side sees video within a few seconds. Camera off: the tile falls back to the avatar. |
| 3.11 | Video across networks | One device on Wi-Fi, one on mobile data — video still connects (this is the TURN path; if it fails, TURN is misconfigured, see the runbook). |
| 3.12 | Translated call | A translated call carries translated speech; the original-audio level control changes what is heard. |
| 3.13 | Call history | Every call above appears in the conversation with the right words (outgoing/incoming/missed, duration). |
| 3.14 | Sign-out kills the ring | After sign-out, a call to that account does not ring the phone. |

## 4 · Messaging

| # | Check | Pass criterion |
| --- | --- | --- |
| 4.1 | Send and receive text | Both directions, promptly, with the sending → sent transition visible. |
| 4.2 | Failed send | With the network off, a send shows "Not sent · tap to retry"; retry after reconnect delivers it. |
| 4.3 | Translated chat | In translated mode a message arrives in the reader's language, with the original one tap away. |
| 4.4 | Message actions | Reply, copy, forward, edit (within 15 min), unsend, delete-for-me with undo, pin, react — each does what it says. |
| 4.5 | Search in chat | The search icon in the chat header finds a message; tapping the result jumps to it and highlights it. |
| 4.6 | Pinned | Pinned messages list and jump. |
| 4.7 | Mute / archive | A muted conversation does not push; an archived one leaves the main list and comes back. |
| 4.8 | Report | Report a message: reasons list, send, "Thank you". |
| 4.9 | Push on message | A message pushes to a backgrounded phone and opens that chat when tapped. |
| 4.10 | Notifications off | With notifications off in Profile, messages arrive silently but calls still ring. |

## 5 · People and presence

| # | Check | Pass criterion |
| --- | --- | --- |
| 5.1 | Add by username | A can add B; B sees the request and accepts. |
| 5.2 | Suggested connections | The section lists real suggestions (mutual contacts or new on C7); Add sends a request and the row leaves. |
| 5.3 | Presence | With B's app open, A sees B active; after B backgrounds it for two minutes, away; during a call, busy. |
| 5.4 | Speaks chip | A contact's spoken language shows; the listening language is never shown. |
| 5.5 | Share contact | Share opens the OS sheet with a working link. |
| 5.6 | Person profile | Bio, presence, "Speaks", and the actions (message, call, remove, block, report). |

## 6 · Profile

| # | Check | Pass criterion |
| --- | --- | --- |
| 6.1 | Counts | Connections / Following / Saved match reality. |
| 6.2 | About me | A bio saves and appears on the other phone's view of the profile. |
| 6.3 | Availability | Auto / Busy / Away change what a contact sees. |
| 6.4 | Privacy | The discoverable switch removes the account from another person's suggestions. |
| 6.5 | Biometrics switch | Turning it off makes the lock ask for the password only. |
| 6.6 | My C7 Voice | Record 20–30 s; it uploads and the row reports enrolment; on relaunch the row still says enrolled. |
| 6.7 | Upgrade hidden | With no billing page configured, no "Upgrade" or "Plans" row appears. |
| 6.8 | Languages | Changing the spoken and listening languages changes what calls and translated messages do. |

## 7 · Conference

| # | Check | Pass criterion |
| --- | --- | --- |
| 7.1 | Start | Start opens a conference immediately with a fresh code (it does not merely generate a code). |
| 7.2 | Title | A title given at start shows in the call header. |
| 7.3 | Private | A private conference is joinable only with the code. |
| 7.4 | Public | A public conference appears in the Public conferences list on the other phone and can be joined from it. |
| 7.5 | Restricted | The host sees "<name> wants to join" with Admit / Refuse; admitting seats them; refusing shows "The host did not let you in". |
| 7.6 | Knocking releases the mic | While waiting, the phone's microphone indicator is off. |
| 7.7 | Knock timeout | An unanswered knock ends with "Nobody answered" within about a minute. |
| 7.8 | Translation inactive is honest | The line "Translation is not active on mobile conferences yet." is shown; no language picker. |
| 7.9 | Recent | Recent conferences list; an ended one shows **Ended** with Join greyed; "Start similar" opens a **new** code with the title copied. |

## 8 · Programmes (C7 Streams)

| # | Check | Pass criterion |
| --- | --- | --- |
| 8.1 | Directory | Channels list with avatar, name, @handle, category and live state — never "Channel abc123". |
| 8.2 | Watch in-app | Tapping a channel opens the player inside the app; the programme plays. |
| 8.3 | Language | Choosing a target language changes the audio heard. |
| 8.4 | Interested | The bell follows the channel; the row shows Following. |
| 8.5 | Live push | With Interested set, starting that programme from the operator console pushes "<name> is live on C7" to the phone, and tapping it opens the programme. |
| 8.6 | Share | Share from the viewer copies `https://consummate7.com/streams/<handle>`, and that link opens the channel in a browser. |
| 8.7 | Filters and categories | Live / Following / Public filter honestly; a category row appears only when channels carry one. |

## 9 · Endurance and edges

| # | Check | Pass criterion |
| --- | --- | --- |
| 9.1 | Battery optimisation on | With the app not exempted from battery optimisation, a call still rings after two hours idle. |
| 9.2 | Poor network | On a weak connection a call reconnects rather than dying silently. |
| 9.3 | Airplane mode | Toggling airplane mode mid-call ends it honestly on both sides. |
| 9.4 | Long call | A 30-minute call holds audio without drift or memory growth that ends it. |
| 9.5 | Storage | After a dozen voice notes the cache does not grow without bound. |
| 9.6 | Two accounts, one phone | Sign out and in as another account: no data, avatar, chat or channel from the first account is visible. |

---

## Result

The mobile release is accepted only when every row is PASS or an explicitly
ruled BLOCKED. A single FAIL in section 2 or 3 sends it back to a fix and a
rebuild: those are the paths a person notices in the first minute, and the
ones the founder reported by hand.

Record the run as `docs/MOBILE_PHYSICAL_ACCEPTANCE_<date>.md` with the SHA,
the build id, both devices, and every observation.
