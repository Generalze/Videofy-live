*Consummate 7 · Videofy Live*

# Videofy Blueprint

The flow of the web app and the mobile app, the streaming
logic that gives viewers a coherent programme, and the access model for
channels — what shipped tonight, what I recommend next, and the four rulings
only you can make.

## 1 · Where the platform stands tonight

Everything below the line is **live on staging** as of this
document:

> **Shipped tonight —** translated conversations
(per-chat Translate toggle, renderings marked, original always revealable, real
opus-mt verified end-to-end: “The broadcast starts in ten minutes” →
“La transmisión comienza en diez minutos”); voice notes fixed (two independent
server bugs — a body-size parser that silently capped every upload at 16kb, and
a write-protected media directory); account **default language**
(profile choice, calls enter with it on web and phone); faces and real
names on call tiles; the **official C7 badge** mechanism;
the **operator console gated** to granted accounts; channel tiers
renamed to your model (*public / private / locked*) and the
stale-LIVE bug fixed so ending a broadcast actually turns the channel off.

## 2 · Web app — the hub-and-rooms flow

The rule that keeps the web coherent: marketing pages sell, the
dashboard operates, and nothing operational is reachable without a
session. Signed-out visitors see products and one door (Join C7).
Signed-in people land in *My C7* and never see sign-up surfaces
again.

```
Signed out   /            → product story, samples, Join C7
             /videofy/live → product page, CTA = Join C7 to start calls

Signed in    /app/        → My C7 hub
             ├─ Overview      start/join a call · programme cards · activity
             ├─ Messages      threads · Translate toggle · voice notes
             ├─ Contacts      requests → contacts → sent · Call / Message
             ├─ Profile       picture · name · language · devices
             └─ Verification  trust state, one place only

Products     /call/       joins with your session (name, language, face)
             /listen/     channel directory + invite links
             /operator/   granted accounts only
```

### Recommendations (next passes)

- **The hub earns a live rail.** Overview's “Recent activity” card
should show real rows — missed rings, unread counts, your channel's live state —
before anything else is added to the page.
- **Calls should start from people, not codes.** The Contacts tab
already carries Call; the Overview “Start a call” tile should offer your
contacts first and “conference with a code” second. Codes are for conferences —
your ruling, now the visible hierarchy.
- **One design system.** The dashboard, call page, listener and
operator console share tokens (ink #e4ebf1, ground #0b0f14, teal #3ec9c0,
amber for warnings) but not yet one stylesheet. I recommend a
*packages/c7-style* with the tokens and the five shared shapes (card,
pill, badge, row, bubble) so “neat” stops being a per-app fight.

## 3 · Mobile app — one thing at a time

The phone keeps its rule: **tabs are places, overlays are moments.**
A call covers everything; a chat covers the tab bar; nothing else stacks.

```
Tabs      Chats · Contacts · Call · Profile   (now clear of the system bar)
Overlays  Call  >  Chat  >  tabs
Push      ring → call screen · message → that chat  (cold start included)
```

### Recommendations

- **Incoming call screen.** A ring today lands as a notification;
answering deserves a full-screen accept/decline surface with the caller's face
— the native moment people judge a calls app by.
- **Chats is home.** Empty-state Chats should surface “find your
people” (Contacts) and “start a call” directly, so a fresh install is never a
blank page.
- **Profile is identity.** Picture, name, language and devices are
there now; verification state should join it so the phone can explain why a
call cannot start.

## 4 · Streaming — the coherent-delay programme

Your ruling is the right architecture: **a broadcast is not a call.**
A viewer does not need the last two seconds; they need picture, original
audio, translated voice and captions that *agree with each other*. The
platform buys that with a fixed, disclosed delay.

```
Broadcaster ──► ingest ──► coherence buffer (60–120s, your ruling)
                                    │ transcribe → translate → synthesize
                                    │ align every asset to video timestamps
                                    ▼
Viewer  ◄── one synchronized programme clock at T+delay:
         video + original audio + translated voice + captions
```

- **Why it works:** today translated speech chases the video and
loses (measured: video 7.5s behind audio at the jitter buffer). With a
coherence buffer, translation has tens of seconds of headroom — every segment
arrives *before* its air time, and lip-drift becomes an alignment choice
rather than a race.
- **Delivery:** the buffered programme becomes an HLS ladder
(the segmenter the upload path already has) — real quality levels for viewers,
CPU-friendly for the box, and the per-viewer WebRTC re-encode disappears from
the programme path entirely. WebRTC stays where immediacy matters: calls, and
an operator-only true-live preview.
- **Ordering:** phase 1 aligns translated audio and captions to
the delayed clock (server buffers, single output); phase 2 adds the HLS ladder
and quality selection; phase 3 adds DVR (“from the start”) and the recording
becoming a replayable programme automatically.
- **Estimate:** phase 1 ≈ 1–2 days, phase 2 ≈ 2–3 days, phase 3
≈ 1 day — each independently shippable and each measurable by the programme
probe before you ever have to listen for yourself.

## 5 · Channels — who can watch, in three words


| Tier | Listed? | Who gets in |
|---|---|---|
| Public | In the directory | Anyone who knows the channel |
| Private | No | Anyone holding your invite link |
| Locked | No | Code required — typed, or carried by an access link |

All three are live (codes hashed, compared constant-time). On/off is
the broadcast itself: Start Interpretation turns the channel live,
End turns it off — and since tonight, off actually means off (the directory bug
that kept channels “LIVE” forever is fixed). Every operator account owns one
stable channel; the operator console is now **granted, not
ambient** — accounts on the grant list (you hold it) can operate,
everyone else is refused at the socket.

## 6 · Identity — language, face, badge

- **Default language** is an account fact: chosen once in Profile
(web or phone), and every call enters speaking and hearing it. The join screen
still allows per-call changes — the default is a preload, not a cage.
- **Face and name** now follow you into calls: tiles show the
profile picture (or honest initials) with the name at reading size — the same
prominence as the samples on the description page.
- **The official C7 badge** exists as a mechanism no code path can
grant — an environment list only you control. Contacts, conversations and
/me all carry it; the teal “C7” chip renders wherever the name does.

## 7 · The rulings only you can make

> **Ruling needed** — **The text-translation unit.** Calls bill in seconds; text has no
seconds. Recommendation: 1 unit per 100 characters translated, standard
grade (opus-mt is self-hosted — cost is compute, not vendor fees).
Messaging stays visibly “free during staging” until you rule.

> **Ruling needed** — **Which account is the official C7.** The badge and the master
developer role want a dedicated account (not your personal ones). Create it,
tell me the username, and I add it to the badge and operator grants.

> **Ruling needed** — **The coherence delay.** 60, 90 or 120 seconds as the platform
default (my recommendation: 90 — comfortable headroom for premium voices, still
“tonight” for the audience). Shown to viewers honestly as “≈90s behind live”.

> **Ruling needed** — **Operator grants beyond you.** Today the console grant list is
your two accounts. When outside broadcasters join, the grant should become a
product step (apply → approve) rather than an environment edit — say when.

## 8 · Known refinements, honestly listed

- opus-mt kept only the first sentence of a two-sentence message in one
staging test — the text route should split on sentence boundaries and rejoin.
Small fix, queued.
- Web↔phone A/V sync inside *calls* is good; the programme path's cure
is section 4, not more tuning of the live race.
- Nigerian languages (yo/ha/ig/pcm) remain premium-routed and vendor-blocked
pending a better provider — unchanged from your earlier ruling.
- The next APK (building now) carries: real safe-area insets, the image
picker, the C7 icon, and self-naming audio errors.

*Prepared 27 Aug 2026 · everything in §1 verified by machine
probes on staging before being written here.*
