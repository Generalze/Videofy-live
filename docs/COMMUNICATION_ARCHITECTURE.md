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
| **Messaging** | A saved contact, or an organization group | Delivered to the conversation | **Not built** |
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
| **Private** | Nobody. Not by address, not by name | **The default** — reachable only by invite link |
| **Discoverable** | Exact verified address only | Opted into, deliberately |

**Private is the default.** Discoverable-by-default is the conventional choice
and quietly opts people into being findable by anybody who can guess their work
address. This costs onboarding convenience — a new account cannot be found until
its owner shares a link — and that cost is paid deliberately.

It is also the value that must win when nothing is stored. Only the exact string
`discoverable` opts an account in; an absent field, a misspelling, a wrong type
or a hand-edited record all resolve to private, because the failure that matters
runs in one direction only. Defaulting the other way would silently expose every
account whose field failed to read.

**The consequence for the product**: the invite link is the PRIMARY way people
connect, not a fallback for the private few. Onboarding must put it in front of
somebody the moment they have an account, because address search will find
almost nobody by design.

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

**Messaging is a first-class product, not a feature of calling.** Near-zero
marginal cost, no realtime constraint, asynchronous across time zones, and it
produces the durable searchable record businesses actually want.

It lives in the **Communication & Connection** domain and is reached through the
same C7 account — one identity, as everywhere else.

**Separable later, which is a constraint on it TODAY.** The decision to keep the
option of splitting messaging into its own product is only real if it is built
behind a clean boundary from the start: its own package and its own service
seam, sharing identity, translation and push through interfaces rather than
through reach-ins. A boundary retrofitted after the fact is a rewrite, and
"we can separate it later" is the sentence that most often turns out to be
false.

### 4.3 What it needs

- Durable storage (§0.2), with per-conversation ordering
- Delivery and read state
- Attachments — decide deliberately; images and documents are a separate
  moderation and storage problem, and "just add files" is how that arrives
  unexamined
- Push, shared with call ringing

### 4.4 One to one, and groups for organizations

**One-to-one first**, between mutual contacts.

**Groups are an organization capability**, not a personal one. This was checked
against the existing model rather than assumed, and it fits without a single new
authority concept:

| A group needs | Already provided by |
|---|---|
| Who is in it | `OrganizationMembership` — organizationId, accountId, active |
| Who may manage it | `OrganizationRole` and the existing role table |
| Not leaking across tenants | The tenant-isolation invariant |
| Who may be added at all | Seat accounting and invitations |

Consequences that follow, and are correct rather than incidental:

- **A group belongs to the organization, not to whoever created it.** When the
  creator leaves, the group survives and the records stay with the company.
- **Leaving an organization removes you from its groups.** Offboarding already
  writes an audit event; group removal rides on the same act rather than being
  a separate thing somebody must remember to do.
- **A personal account has no groups.** One-to-one only. Groups arrive with an
  organization, which is also where the obligation to retain a record arrives.

No new capability is added to the authority model until group messaging is
actually built. Declaring one now would be another entry wired into nothing.

### 4.5 Retention is optional, within limits

The owner chooses the policy. What the choice cannot do is dissolve obligations
that were never the individual's to waive.

| Setting | Behaviour |
|---|---|
| **Keep** | Retained until deleted |
| **Auto-delete after N days** | Rolling window, per conversation |
| **Minimal** | Delivered and rendered, not retained beyond delivery |

Three rules bound it:

1. **An organization owns the policy for its own conversations.** Otherwise a
   departing member could destroy company records by flipping a personal switch,
   and the organization would discover it during the dispute that needed them.
2. **Retention never deletes what retention does not own**: audit events,
   evidence already captured by an abuse report, and anything under legal hold.
   An abuse report takes a SNAPSHOT at the moment it is filed, and that snapshot
   outlives the conversation's retention policy — exactly as the call rolling
   buffer does. Without this, "minimal" would be the setting every abuser picks.
3. **Optional means the policy is chosen, not that the obligation vanishes.**
   The lawful-basis and retention questions in the road map still have to be
   answered before the schema is written; this section decides the product
   behaviour, not the legal position.

### 4.6 Read receipts and last seen

Both are available, and both are **reciprocal**: turn off sending read receipts
and you stop seeing other people's.

The symmetry is the whole point. Without it the setting becomes a way to observe
without being observed, which is the version people rightly resent — and the
asymmetry would be discovered and complained about rather than noticed and
accepted.

Organization conversations may have these fixed by policy, since "was this read"
is an operational fact for a company in a way it is not between two friends.

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
- No status/stories. It is scope with its own moderation burden and no relation
  to the translation idea
- No contact list built from the device address book. It is the single largest
  source of accidental disclosure in messaging apps, and it would contradict
  private-by-default within one screen of onboarding
- Read receipts and last seen ARE adopted, but reciprocally (§4.6), which is
  the part usually copied badly

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
| 5 | **Messaging**: one-to-one conversations, text translation, originals, retention policy, receipts | Database, contacts |
| 5b | **Organization groups**: conversations scoped to a company | Messaging, organizations |
| 6 | **Interface**: three-tab shape | 1–5 |

Steps 1, 2 and 5 all sit behind the database. **Step 3 does not** — conference
link controls can be built now, and they are what currently keeps the contact
gate from being trivially bypassed.

---

## 7. Settled decisions

All resolved by the owner on 2026-08-25.

| # | Question | Decision |
|---|---|---|
| 1 | Messaging: product or feature? | **First-class product**, in Communication, on the C7 account. Separable later, so built behind a clean boundary from the start (§4.2) |
| 2 | Attachments in v1? | **No.** Images and documents carry their own moderation, storage and scanning burden, and "just add files" is how that arrives unexamined |
| 3 | Read receipts and last seen? | **Available, and reciprocal** (§4.6) |
| 4 | Groups or one-to-one? | **One-to-one first. Groups are an organization capability** — verified to need no new authority concept (§4.4) |
| 5 | Private or discoverable by default? | **Private by default** (§2.3) |
| 6 | Retention? | **Optional, within three limits** (§4.5) |

### What still needs an answer from outside this document

- **Lawful basis and retention periods** — a legal question, and it gates the
  messaging schema rather than following it.
- **Recording and transcript consent**, which varies by jurisdiction.
- **Whether "minimal" retention is offered to organizations at all**, or only to
  personal accounts. A company that cannot produce its own records has a
  compliance problem the product should not hand it by default.
