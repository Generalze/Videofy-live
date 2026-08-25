# C7 data protection — drafted positions for legal review

Owner: Zoe (masterzee001). Drafted 2026-08-25.

> **Status: DRAFT FOR REVIEW. This is not legal advice.** It is an engineering
> position paper — what the system actually does, what basis each processing
> activity would most defensibly rest on, and how long each record should live.
> It exists so that a qualified lawyer reviews *decisions already reasoned
> through* rather than starting from a blank page, which is faster and cheaper
> for everyone. Every figure here is a **starting position**, not a conclusion.
>
> Two reviews are needed, not one: a **Nigerian** practitioner (NDPA 2023) and
> an **EU/UK** practitioner (GDPR). The service is hosted in the EU and aimed at
> Nigerian users, so both regimes apply simultaneously and neither review
> substitutes for the other.

---

## 1. Where the data actually is

Established from the deployment, not assumed:

| Fact | Value |
|---|---|
| Hosting | Contabo VPS, `c7-eu-01` — **EU** |
| Edge / DNS | Cloudflare — US company, global edge |
| Speech recognition | **Deepgram** — US |
| Speech synthesis | **ElevenLabs** — US |
| Text translation | `opus-mt`, **running locally on the EU box** |
| Email delivery | **Resend** (Amazon SES, `eu-west-1` Ireland) |
| Expected user base | Nigeria primarily, plus EU/international |

**This creates a two-way transfer problem that needs a mechanism, not a
mention.** Nigerian personal data flows to the EU for hosting, and call audio
flows onward to the United States for recognition and synthesis. NDPA 2023
restricts transfers out of Nigeria; GDPR Chapter V restricts transfers out of
the EEA. Both directions need a lawful transfer route — adequacy, Standard
Contractual Clauses, or the EU–US Data Privacy Framework where the vendor is
certified.

**Voice content leaving the EU for the US is the single largest exposure in this
list**, because it is the most sensitive category being moved the furthest, and
it happens on every translated call.

---

## 2. Lawful basis — and why consent is mostly the wrong one

The common and expensive mistake is to put everything under consent. Consent can
be withdrawn at any moment, and when it is, processing must stop — which means
building a service whose core function a user can switch off while still holding
an account. Consent is right for a narrow set of things and wrong for most.

| Processing | Recommended basis | Reasoning |
|---|---|---|
| Account creation, sign-in, session tokens | **Contract** — GDPR 6(1)(b) | Cannot deliver the service without it |
| Email verification | **Contract** | The address *is* the account handle |
| Phone verification (when live) | **Contract** if required to use the product; **consent** if genuinely optional | Depends on the product decision, so decide it first |
| Speech recognition, translation, synthesis during a call | **Contract** | This is the service itself, not an add-on to it |
| Message delivery and translation | **Contract** | Same |
| Contact graph, invites | **Contract** | Core function |
| Rate limiting, abuse and fraud prevention | **Legitimate interests** — 6(1)(f) | Recital 47 names fraud prevention explicitly |
| Abuse-report evidence snapshots | **Legitimate interests**, and safety | Balancing test must be documented |
| Security logging, audit events | **Legitimate interests** + **legal obligation** 6(1)(c) | Art 32 requires security measures |
| Billing, invoices, tax records | **Legal obligation** | Retention is statutory, and survives a deletion request |
| Marketing email | **Consent** — 6(1)(a) | The place consent genuinely belongs |
| Non-essential analytics / cookies | **Consent** | ePrivacy, separate from GDPR basis |
| KYC / KYB, if ever live | **Legal obligation** if C7 becomes a regulated entity; otherwise **legitimate interests** | Established elsewhere that C7 is probably *not* an obliged entity, so this basis is weaker than it looks |

**Legitimate interests requires a written balancing test** (LIA) for each item
that relies on it. It is not a fallback to be asserted; it is a basis to be
shown. Three are needed: abuse prevention, evidence retention, security logging.

### 2.1 Special category data — and the one that is already live

**Speech recognition is not biometric processing.** Converting speech to text
does not identify a person from their voice. It is ordinary personal data, not
Article 9 special category data, and conflating the two would impose conditions
the product does not need.

**Voice cloning is a different matter, and it is already built.** This was
checked in the code rather than assumed:

- `voice-clone` is a first-class provider capability in the AI registry
  (`services/ai-registry/src/registry.ts`).
- `personalVoice` with a `voiceId` flows through the language router
  (`services/language-router/src/recipient-output-policy.ts`).
- An enrollment flow exists in the call app, with capture, preview and upload.

A voice model that reproduces a specific identifiable person is **biometric
data processed for the purpose of uniquely identifying a natural person** —
Article 9 territory, and NDPA sensitive personal data. This is the single most
legally significant processing activity in the product, and it is live rather
than planned.

**What is already right, and is better than most products manage.** Consent is
captured *before any audio exists* — the flow creates the profile and records
consent first, so somebody who merely opens the screen cannot manufacture a
consent record. The consent text is **versioned**
(`VOICE_CONSENT_TEXT_VERSION`), so a stored profile records which wording it was
granted under. That is exactly the shape Article 9 explicit consent requires,
and it aligns with the consent-versioning module already built.

**What still needs to be established:**

1. **A DPIA is almost certainly mandatory** for this specific feature —
   large-scale processing of biometric data. Not optional, and it should be
   done before further voice work rather than after.
2. **Explicit consent must be separable.** Article 9 consent cannot be bundled
   into general terms acceptance. It has to be its own affirmative act, refusable
   without losing the rest of the product. Confirm the enrollment flow works
   that way and that declining still permits calling.
3. **Where does the voice model physically live?** If it is held at ElevenLabs,
   biometric data is being stored by a US processor and needs a transfer
   mechanism of its own — see §5.
4. **Deletion must propagate to the provider.** This is the concrete engineering
   risk: if closing a C7 account removes the local record but leaves the cloned
   voice at the provider, biometric data is retained after erasure. That is a
   serious and very findable failure. **Verify it, do not assume it.**
5. **Retention period for the voice model** — see §3.
6. **Withdrawal of consent must delete the model**, not merely stop using it.

**Message and call content will incidentally contain special category data** —
somebody will discuss their health, their religion, their politics. The standard
and defensible position is that C7 does not *intentionally* process Article 9
data and does not derive it; Article 9 conditions attach to deliberate
processing, not to unavoidable incidental content. This position should be
stated in the privacy policy rather than left implicit.

## 3. Retention schedule — recommended starting positions

| Data | Recommended period | Reasoning |
|---|---|---|
| Account record, active | Life of account | Contract |
| Account after closure | **30 days**, then delete or anonymise | Recovery from mistake and account takeover, without indefinite storage |
| Verification challenges (email/phone tokens) | **Already 10–30 minutes** | Implemented; nothing to change |
| Password reset tokens | **15 minutes** | Implemented |
| Contact invite tokens | **72 hours** | Implemented |
| **Call audio** | **Not retained.** Transient only | The rolling buffer is memory-resident and overwritten |
| Abuse-report snapshot | **12 months**, or case close + appeal window, whichever is longer | Must outlive the 7-day appeal plus any review; 12 months covers a repeat-offender pattern |
| Security and audit events | **12 months** | Long enough to investigate an incident discovered late; most breaches are found months after the fact |
| Request logs with correlation IDs | **90 days** | Operational debugging, not a permanent record |
| Messages — individual, "keep" | Until the user deletes them or closes the account | Their data, their choice |
| Messages — individual, auto-delete | User selects: 24h / 7d / 30d / 90d / 1 year | |
| Messages — organization | **Always retained** until an owner deletion act | Per the architecture decision |
| Consent records | **Life of account + 6 years** | The record proves the consent; it must outlive any dispute about it |
| Billing, invoices, tax | **6–7 years** — confirm per jurisdiction | Statutory. **Survives an erasure request** |
| **Personal voice model (clone)** | **Life of the profile.** Deleted on withdrawal of consent or account closure, **at the provider as well as locally** | Biometric data. Retaining it after erasure is the failure mode to design against |
| Voice consent record | **Life of account + 6 years** | Proves which consent version the model was made under |
| KYC records, if live | **5 years after the relationship ends**, if regulated | Only if C7 is an obliged entity |
| Backups | Deletion propagates within **35 days** | See below |

### 3.1 Two things that are usually got wrong

**Backups.** You cannot surgically delete one person's data from a backup
archive, and pretending otherwise in a privacy policy creates a promise that
will be broken. The defensible position: deletion is applied to live systems
immediately, backups are not re-written, and the deleted data ages out as
backups rotate — with a **stated maximum window** (35 days for a 30-day
retention cycle). Say this plainly rather than implying instant global erasure.

**Erasure requests do not override statutory retention.** A request to delete
everything does not delete tax records. The policy must say which categories
survive an erasure request and why, or every such request becomes an argument.

---

## 4. Recording and consent — apply the strictest standard everywhere

### 4.1 Why geo-detection is not the answer

The instinct is to detect the user's jurisdiction and apply local rules. It does
not survive contact with this product:

- Consent rules for recording differ fundamentally. **All-party** jurisdictions
  require everyone's consent — California, Florida, Illinois, Pennsylvania and
  Washington among US states; Germany, where §201 StGB makes recording the
  confidential spoken word a criminal offence; France. **One-party**
  jurisdictions require only one participant — most other US states, and the UK
  for personal use.
- **A translated call is very often cross-border by definition.** That is the
  entire product. A Lagos–Munich call involves a one-party jurisdiction and a
  criminal-offence jurisdiction *at the same time*. There is no single local rule
  to apply.
- Geo-detection is unreliable anyway — VPNs, roaming, travel, corporate egress.
- The consequence of being wrong is not a fine in one case. It is potential
  criminal liability in Germany.

### 4.2 The recommendation

**Apply the strictest standard globally: treat every call as requiring
all-party awareness.** Concretely:

1. **No call is recorded by default.** This is already true and should be stated
   as a product commitment, not left as an implementation detail.
2. **Recording, if ever built, requires an affirmative act** and cannot be
   silent, background or default-on.
3. **Every participant is told, in their own language**, audibly and visibly,
   at the moment it starts. The translation-disclosure mechanism already shipped
   is exactly the right vehicle — it already speaks in the listener's language.
4. **The indicator persists** for the duration. Not a toast that fades.
5. **Any participant can leave**, and leaving is not penalised.
6. **Nobody can be recorded without an indicator they can see or hear**, in any
   jurisdiction, regardless of local minimums.

This is stricter than most jurisdictions require. That is the point: it is one
rule, it is defensible everywhere, and it cannot be got wrong by a geo lookup
failing.

### 4.3 The rolling buffer is not a recording, and must still be disclosed

The abuse-report buffer holds recent audio in memory and writes nothing unless
somebody files a report. It is **not** a recording in the consent sense — nothing
is stored, nobody can retrieve it, and it is continuously overwritten.

It is still **processing of call content**, so it belongs in the privacy policy,
described plainly: how long the window is, that it is memory-only, that it is
destroyed when the call ends, and that filing a report is the only thing that
persists any of it. Leaving it undisclosed because "nothing is stored" is the
kind of technically-true silence that reads very badly when discovered.

### 4.4 Translation itself must be disclosed

Machine translation of a call means the content is processed by C7 and, today,
by US vendors. The shipped in-call disclosure covers the *deception* risk; the
privacy policy must separately cover the *processing* fact. They are different
disclosures serving different purposes and neither substitutes for the other.

---

## 5. Cross-border transfers — the item needing action first

| Flow | Mechanism required |
|---|---|
| Nigeria → EU (hosting) | NDPA 2023 transfer route: adequacy or contractual safeguards |
| EU → US (Deepgram, ElevenLabs) | **SCCs, or the vendor's DPF certification** |
| EU → US (Cloudflare) | Same |
| **EU → US (voice models at ElevenLabs)** | **SCCs, plus an Article 9 assessment.** Biometric data, so the highest-risk transfer in this table |
| EU → EU (Resend/SES, `eu-west-1`) | Intra-EEA, no transfer mechanism needed |

Actions, in order:

1. **Sign a Data Processing Agreement with every processor.** Deepgram,
   ElevenLabs, Cloudflare, Contabo, Resend. Most publish a standard DPA; it
   generally has to be actively accepted rather than being automatic.
2. **Check whether Deepgram and ElevenLabs offer EU processing regions.** If
   they do, using them removes the largest transfer question entirely and is
   worth real money and effort. Ask before assuming they do not.
3. **Confirm each vendor does not train on your data by default**, and turn it
   off where it is a setting. Voice content used to train a third-party model is
   a disclosure your customers will ask about, and a business customer will ask
   in writing.
4. **Publish the subprocessor list**, with notice of changes. Business customers
   require this contractually.

---

## 6. What to take to the lawyers

Specific questions, so the engagement is efficient:

**Nigerian counsel (NDPA 2023)**
1. Does hosting Nigerian personal data in the EU require a specific transfer
   mechanism, and what form does the NDPC accept?
2. Is C7 required to appoint a Data Protection Officer or register with the NDPC
   at its expected scale?
3. Does real-time translation of a call constitute processing requiring
   notification, or is contract sufficient?
4. What are Nigeria's rules on recording a conversation, and what changes when
   one party is abroad?
5. Confirm statutory retention for tax and company records.

**EU/UK counsel (GDPR)**
1. Confirm contract as the basis for the translation pipeline, rather than
   consent.
2. Review the three legitimate-interests balancing tests.
3. Is a DPIA required? Assume **yes** — large-scale processing of communications
   content, plus abuse-evidence retention, plus vulnerable-user risk.
4. Confirm the Article 9 position on incidental special category content.
5. Review the recording position in §4 against German §201 StGB specifically,
   since that is the strictest exposure.
5b. **Voice cloning**: confirm the Article 9 basis, whether the existing
   versioned consent flow satisfies "explicit consent", and whether a DPIA is
   mandatory. Assume yes to the DPIA.
6. Confirm the backup-deletion window language.

**Both**
- Review the retention schedule in §3 line by line.
- Confirm which categories survive an erasure request.
- Confirm whether the abuse-evidence snapshot can be retained for 12 months on
  legitimate interests, or needs a different basis.

---

## 7. What engineering should do before any of this is answered

None of these depend on the legal outcome, and all of them get harder later:

- **Keep the retention period configurable per category.** A hard-coded 90 days
  becomes a migration when counsel says 12 months.
- **Make deletion a real operation with an audit trail**, not a row removal.
- **Never log message or call content.** Already the position; keep it.
- **Record the lawful basis per processing activity in code comments or a
  register**, so the Article 30 record of processing activities can be produced
  from what is true rather than reconstructed from memory.
- **Verify that deleting an account deletes the cloned voice AT THE PROVIDER**,
  not only locally. This is the highest-value check in this document: it is
  concrete, testable today, and getting it wrong means retaining biometric data
  after an erasure request. Test it end to end rather than reading the code.
- **Confirm voice-enrollment consent is refusable** without losing the ability
  to make calls. Article 9 consent bundled into general terms is not consent.
