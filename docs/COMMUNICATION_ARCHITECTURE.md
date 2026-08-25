# C7 communication architecture — calls, conferences and messaging

Owner: Zoe (masterzee001). Drafted 2026-08-25.

**What this settles.** Four communication products, one identity, one translation
idea: *write or speak in your language, it arrives in theirs*. This document
draws the lines between them so they stop overlapping, and states the two
constraints that cannot be designed away.

---

## 0. The two constraints, stated first

Everything below is shaped by these. Neither is negotiable, and both are easier
to accept now than to discover after the UI is built.

### 0.1 Translation and end-to-end encryption are mutually exclusive

A message that C7 translates is a message C7 can read. There is no arrangement
in which a server converts Yoruba to French without seeing the Yoruba.

This matters because **the interface is going to look like WhatsApp**, and
WhatsApp has trained roughly three billion people to assume end-to-end
encryption. Borrowing the visual language borrows the expectation.

So:

- C7 messaging is **encrypted in transit and at rest**, and **readable by the
  service in order to translate**. That is the honest description.
- The product must never display a padlock, the words "end-to-end", or any
  WhatsApp-style security banner. Copying that specific reassurance would be a
  lie told in an idiom people already trust.
- A future **"private mode"** — no translation, end-to-end encrypted — is
  coherent and can be added later, precisely because translation is the thing
  that would have to be given up. Do not promise it yet.

### 0.2 Messaging cannot ship before the database

`OrganizationStore` keeps everything in memory today and `AccountStore` writes to
a JSON file. A chat product whose history disappears on restart is not a
degraded chat product; it is a broken one, and the first restart destroys the
customer relationship along with the messages.

**Messaging is blocked on Phase 1 of the commercial road map.** Calls are not —
a call is ephemeral by nature and loses nothing on restart.

---

## 1. The four products

They share identity, translation and transport. They differ in *who may reach
whom*, which is the only distinction that matters for abuse.

| Product | Who can initiate | How the other side is reached | State |
|---|---|---|---|
| **Personal call** | A saved contact, both ways | Direct dial — it rings | Built (`callType: 'personal'`) |
| **Conference** | Anyone with the room link | Invite link | Built (`callType: 'conference'`) |
| **Messaging** | A saved contact | Delivered to the conversation | **Not built** |
| **Programme** | Operator | Public or channel link | Built |

`CallType = 'personal' | 'conference'` already exists in
`services/call-session/src/call-session-store.ts`, defaulting to conference.
The split is real at the session layer; what is missing above it is the contact
graph that makes "personal" mean something.

### Why this split is the anti-fraud control

A fraudster's problem is reach. Today every call is a link, so reach is
unlimited: generate a link, send it to a stranger, speak their language.

Under this design:

- **Personal calls require a mutual contact.** A stranger cannot ring you.
- **Conference links remain open by necessity** — that is what a conference is —
  so they carry their own controls (§3.2). Without those, conference becomes the
  door beside the locked gate and the contact rule achieves nothing.

This is stronger than identity verification, because it does not depend on
knowing who the stranger is. It removes the ability to reach a stranger at all.

---

## 2. Contacts — the identity graph

### 2.1 The handle

**Connect by verified email address.** Not by phone: phone verification is
deferred on sender-id registration, and a handle nobody can verify is a handle
anybody can claim.

- You add someone by the address they verified.
- They appear under their **display name**, never under a name they typed about
  themselves without proof.
- A future phone or username handle slots in beside it. The graph is between
  **accounts**, not between addresses, so changing your email does not break
  your contacts.

### 2.2 The handshake

```
A requests  ->  B accepts  ->  mutual contact
                B ignores   ->  nothing, silently
                B blocks    ->  A cannot request again
```

Rules, each of which exists because of a specific abuse:

- **A request carries no free text.** Not one word. A message attached to a
  contact request is a channel that reaches a stranger's screen without consent,
  which is the exact thing the contact gate exists to prevent. Fraud and spam
  would migrate into it within a week.
- A request shows only: display name, verified-since, and mutual contacts.
- **Requests are rate limited** — `rate-limit.ts` already models this; add a
  `contact.request` surface.
- **Declining is silent.** The sender learns nothing, so the graph cannot be
  probed for who exists.
- **Blocking is permanent** until reversed by the blocker, and blocks both calls
  and messages.

### 2.3 Discovery — who can find you at all

Two modes. **Discoverable** is not the same as listed, and neither mode ever
produces a browsable directory.

| Mode | Found by | Notes |
|---|---|---|
| **Discoverable** | Exact verified address only | The default |
| **Private** | Nobody. Not by address, not by name | Reachable only by invite link |

Rules that hold in **both** modes, because a directory is a harvesting target
whatever the individual settings say:

- **Search is exact-match only.** You must already know the whole address.
  There is no partial match, no name lookup, no "people you may know", and no
  endpoint that returns more than one result. Anything that lets an address be
  *discovered* rather than *confirmed* is a directory with extra steps.
- **A private account returns the same answer as an address that does not
  exist.** Not "this person is private" — that confirms they exist, which is
  the fact private mode is protecting. Identical response, identical timing.
- **Search is rate limited** on the `contact.search` surface. Exact-match
  lookup is still enumerable given a list of plausible addresses and enough
  attempts, and a corporate address list is easy to guess.

### 2.4 Private contact invite links

The only route to a private account, and a legitimate route to any account.

- **Single use.** Consumed on acceptance, and never valid again. This is what
  stops a link becoming a broadcast handle: a link that works twice works a
  thousand times once somebody forwards it.
- **Expiring**, with a short default.
- **Revocable** before use, without affecting contacts already made.
- **Bound to the issuer.** It adds *that* person and nobody else.
- **Rate limited** to issue, so a compromised account cannot mint thousands.

The landing page shows the issuer's display name before acceptance, because
somebody must know who they are adding. That is a deliberate trade: whoever
holds the link learns who issued it. Acceptable, since the issuer chose to send
it — but it means a leaked link discloses its issuer, and the honest mitigation
is that it expires and dies on first use rather than any pretence of secrecy.

**Accepting an invite creates the contact directly.** No pending request: the
issuer already expressed consent by minting the link, and the accepter expresses
it by using it. Both sides agreed, so there is nothing left to approve.

Mechanically this is the same shape as an email verification challenge —
high-entropy token, hashed at rest, expiring, single-use, attempt-capped — and
it reuses `verification-token.ts` rather than growing a second implementation of
properties that are easy to get subtly wrong once.

### 2.5 What a contact grants

Being a contact grants exactly two things: they may ring you, and they may
message you. It grants no access to your organizations, your presence history,
your other contacts, or anything else.

**Contacts are never transitive.** There is no mutual-contacts list, no "friends
of friends", and no path by which being in someone's contacts exposes you to
anybody in theirs.

---

## 3. Calls

### 3.1 Personal call — direct dial

The WhatsApp interaction: open a contact, press call, it rings.

What this needs that does not exist:

- **Presence** — is this person reachable right now? A ring into the void with
  no answer is the single worst first impression a communication product can
  make.
- **Ringing transport** — a signal that arrives when the app is not open. In a
  browser this is a service worker plus Web Push; on native, the platform push
  services. This is the genuinely hard part and should be scoped honestly.
- **Missed-call state** — a call that was not answered has to become something
  visible, or people will not trust the product to have tried.

**No link is generated.** A personal call is addressed to an account.

### 3.2 Conference — rooms and invite links

Create a room, share the link, anyone with it can join. The controls that make
this safe are what stop it becoming the fraud bypass:

- **Links expire**, and the default is short.
- **The host can require a lobby** — arrivals wait until admitted. Default on
  for rooms opened to people outside your contacts.
- **Links are revocable** without destroying the room.
- **The translation disclosure applies** — already shipped.

### 3.3 A conference is not a directory

The hole this closes: a conference link is open by design, so if the room
exposes who is in it, anyone can join, read the roster, and contact everybody —
the contact gate bypassed without ever being broken. Harvesting would be easier
than attending.

So identity in a room is **session-scoped**:

- Participants see a **display name only**. No address, no handle, no profile,
  no organization, no "member since". The name is what a call needs to work and
  is the whole of what is shown.
- **There is no add-contact affordance in a room.** Not greyed out — absent.
  A roster with an add button beside every row *is* the directory this section
  exists to prevent.
- **The roster is not exportable**, and no API returns a room's membership to a
  participant in a form worth scraping.
- **The host may hide the roster entirely.** Attendees then see only whoever is
  currently speaking, which is the right default for a room opened to the
  public. The host always sees everyone — somebody has to be accountable for
  who is in the room.
- **Hidden is never invisible.** A hidden roster conceals attendees *from each
  other*; it never allows a participant nobody can see. The host's view is
  complete, and being in a room is always disclosed to the host.

**Meeting someone legitimately** — the case this must not destroy — is handled
by mutual opt-in: both people tap connect, and only when both have done so does
either learn the other's handle. One-sided interest reveals nothing to anybody,
so the room can never be mined by a participant who taps every row.

---

## 4. Messaging — write in your language, read in theirs

### 4.1 The model

Every message stores the **original** and a **rendering per recipient language**.

```
Adaeze writes (Igbo)  ->  stored as original
                      ->  rendered to French for Marc
                      ->  rendered to English for Sam
```

Design rules:

- **The original is never discarded.** For a business conversation the original
  is the record; the translation is an interpretation of it. Keeping only the
  translation destroys the only authoritative version.
- **Any recipient can reveal the original** on a message, always, one tap.
- **Translations are marked as translations.** Same principle as the call
  disclosure: never present machine output as if the person wrote it.
- **Edits re-translate; the history is kept.**
- **Failed translation delivers the original** with a clear notice, rather than
  silently dropping the message or, far worse, delivering a low-confidence
  guess. This mirrors the confidence floor already used for spoken translation.

### 4.2 Why messaging is cheap and calls are not

Text translation needs no speech recognition and no synthesis — the two
expensive, latency-bound, per-minute-billed stages. It is `opus-mt` alone, which
already runs locally on the box.

**Messaging may well be the better commercial product**: near-zero marginal
cost, no realtime constraint, asynchronous across time zones, and it produces a
durable searchable record that businesses actually want. It deserves weighing on
its own merits rather than being treated as a feature of the call product.

### 4.3 What it needs

- Durable storage (§0.2), with per-conversation ordering
- Delivery and read state
- Attachments — decide deliberately; images and documents are a separate
  moderation and storage problem, and "just add files" is how that arrives
  unexamined
- Push, shared with call ringing
- Retention policy, which is a legal question before it is a technical one

---

## 5. Interface

### 5.1 The shape

Personal communication adopts the familiar messaging layout, because fighting a
convention three billion people already know costs usability for no gain:

```
┌──────────────────────────────┐
│  Chats    Calls    Rooms     │   three tabs
├──────────────────────────────┤
│  ● Adaeze        12:04       │   conversation list
│    Ndewo, kedu...       (2)  │   preview in YOUR language
│  ● Marc          11:20       │
│    Bonjour, je...            │
└──────────────────────────────┘
```

- **Chats** — conversations with contacts
- **Calls** — history, and the button to ring a contact
- **Rooms** — conferences: create one, share a link, join by link

Conference deliberately lives in its **own tab**, not mixed into the contact
list. They are different acts with different reach, and collapsing them into one
screen is how a person opens a door believing they made a phone call.

### 5.2 What must NOT be copied

- No padlock, no "end-to-end encrypted" (§0.1)
- No read receipts by default — decide deliberately, they are a privacy choice
- No "last seen" without a setting, for the same reason
- No status/stories. It is scope with its own moderation burden and no relation
  to the translation idea

### 5.3 What must be added that WhatsApp has no equivalent for

- A **language indicator** per conversation: what you write in, what they read in
- The **translation marker** on every rendered message
- **Reveal original**, on any message
- The **call disclosure**, already shipped

---

## 6. Sequence

Ordered by dependency, not by appeal.

| Step | Work | Depends on |
|---|---|---|
| 1 | **Contacts**: handle, request/accept, block, rate limits, discovery modes, single-use invite links | Database |
| 2 | **Personal call gating**: `personal` requires a mutual contact | Contacts |
| 3 | **Conference controls**: link expiry, lobby, revocation, session-scoped identity, hideable roster | — |
| 4 | **Presence and push**: ringing when the app is closed | Contacts |
| 5 | **Messaging**: conversations, text translation, originals | Database, contacts |
| 6 | **Interface**: three-tab shape | 1–5 |

Steps 1, 2 and 5 all sit behind the database. **Step 3 does not** — conference
link controls can be built now, and they are what currently keeps the contact
gate from being trivially bypassed.

---

## 7. Open decisions

These are the owner's, and each changes the build:

1. **Does messaging get equal billing with calling, or is it a feature of it?**
   §4.2 argues it may be the stronger product.
2. **Attachments in v1?** Recommend no.
3. **Read receipts and last-seen** — default on, off, or per-user?
4. **Group messaging**, or one-to-one first? Recommend one-to-one; groups
   multiply the translation matrix and every moderation question.
5. **Is private mode the default?** Private by default is the stronger privacy
   position and makes the product harder to start using, because nobody can be
   found without an exchange of links. Discoverable by default is the
   conventional choice and quietly opts people into being findable.
6. **Retention** — how long is a conversation kept, and who can delete it?
   Legal input required before the schema is written.
