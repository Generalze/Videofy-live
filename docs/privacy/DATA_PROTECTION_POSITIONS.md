# Videofy-Live — Data Protection Positions

**Document:** `docs/privacy/DATA_PROTECTION_POSITIONS.md`
**Status:** CANONICAL — Privacy / Legal Engineering Baseline
**Version:** 1.1
**Position date:** 25 August 2026
**Applies to:** Videofy-Live web, mobile, realtime gateway, messaging, conferencing, translation/transcription, generated audio, storage, analytics, support tooling, and all subprocessors.
**Jurisdictions considered:** Nigeria (Nigeria Data Protection Act 2023 and NDPC GAID 2025), European Union / EEA (GDPR), United Kingdom (UK GDPR, Data Protection Act 2018 as amended, including Data (Use and Access) Act 2025 changes in force by 19 June 2026).

> **Engineering effect:** This document is a product and engineering control baseline. A feature that conflicts with a **LOCKED**, **PROHIBITED**, or **BLOCK RELEASE** position below must not ship until this document is formally amended after a documented privacy/legal review.

### Amendment record

| Version | Date | Change |
|---|---|---|
| 1.0 | 25 Aug 2026 | Counsel-approved engineering baseline. |
| 1.1 | 25 Aug 2026 | Additive only. Adds DP-055 (personal voice synthesis, which v1.0 neither authorised nor prohibited while it was already built), DP-051A (abuse-evidence snapshot, to stop DP-051 being read as prohibiting a victim-protection control), DP-071A (the individual/organization retention split already decided), and §29 (implementation status, recording facts verified in code so they are not re-litigated or rebuilt). **No obligation in v1.0 has been removed, narrowed or weakened.** |

---

## 1. Purpose

Videofy-Live is a communications platform. Its privacy architecture must therefore assume that ordinary user communications may contain highly personal information even when Videofy did not request it.

The platform SHALL be designed around:

1. lawfulness, fairness and transparency;
2. purpose limitation;
3. data minimisation;
4. accuracy;
5. storage limitation;
6. integrity and confidentiality;
7. accountability;
8. privacy by design and by default;
9. separation of communications content from operational metadata;
10. strict control of secondary uses.

The objective is not to claim that legal risk can be reduced to zero. The objective is to prevent avoidable compliance traps from being embedded in the product architecture.

---

## 2. Primary authorities

### Nigeria

- Nigeria Data Protection Act 2023 (NDP Act) — https://www.ndpc.gov.ng/ndp-act-2023/
- Act PDF — https://ndpc.gov.ng/wp-content/uploads/2024/03/Nigeria_Data_Protection_Act_2023.pdf
- GAID 2025 — https://ndpc.gov.ng/wp-content/uploads/2025/07/NDP-ACT-GAID-2025-MARCH-20TH.pdf
- NDPC FAQs — https://ndpc.gov.ng/faqs/

### European Union / EEA

- Regulation (EU) 2016/679 (GDPR) — https://eur-lex.europa.eu/eli/reg/2016/679/oj
- Adequacy decisions — https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en

### United Kingdom

- UK GDPR / DPA 2018 guidance — https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/
- Data (Use and Access) Act 2025 — https://ico.org.uk/about-the-ico/what-we-do/legislation-we-cover/data-use-and-access-act-2025/the-data-use-and-access-act-2025-what-does-it-mean-for-organisations/
- ICO biometric recognition guidance — https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/biometric-data-guidance-biometric-recognition/
- ICO international transfer guidance — https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/international-transfers/

---

## 3. Jurisdiction and launch posture

### DP-001 — Nigeria is the home compliance baseline — LOCKED

Videofy-Live SHALL comply with the NDP Act and applicable NDPC guidance for Nigerian processing.

### DP-002 — EU/EEA targeting activates EU GDPR obligations — LOCKED

Mere technical accessibility from the EEA is not treated as the sole trigger. If Videofy intentionally offers goods/services to people in the EEA or monitors their behaviour in the EEA, EU GDPR territorial-scope requirements must be assessed and, where Article 3(2) applies, Article 27 representative requirements must be implemented unless a valid exemption applies.

### DP-003 — UK targeting activates UK GDPR obligations — LOCKED

If Videofy intentionally offers goods/services to people in the UK or monitors their behaviour there without a UK establishment, UK GDPR extraterritorial and representative requirements must be assessed and implemented where applicable.

### DP-004 — Market activation register — REQUIRED

Production configuration SHALL maintain an explicit launch-market register. Legal obligations must not be inferred from language selection alone.

Minimum fields: market/jurisdiction; targeted yes/no; launch date; controller entity; representative requirement and status; transfer mechanism; privacy notice version; cookie/tracking regime; age policy; approved subprocessors.

---

## 4. Nigeria DPIA

### DP-010 — Nigerian DPIA is mandatory before deployment — BLOCK RELEASE

GAID 2025 expressly lists **development of software for the purposes of enabling communication with data subjects** among circumstances in which a DPIA is mandatory and must be filed with the Nigeria Data Protection Commission.

Videofy-Live SHALL therefore have a completed Nigerian DPIA covering the production service before Nigerian production deployment of the relevant processing.

> **Scope note (1.1, clarifying only).** This gate is on **production deployment with real users**. A closed staging environment processing only the team's own test data is development, not deployment of the service to data subjects. This note does not narrow the obligation: the DPIA must be complete and filed before any launch, and staging must not be used to process real users' data ahead of it.

The DPIA SHALL cover at least: account and identity processing; contact data; messaging; attachments; call setup/signalling; live audio/video; conference participant identity; IP/device/security metadata; transcription/STT; translation; text-to-speech / generated translated audio; **personal voice synthesis (DP-055)**; recording, if ever enabled; **abuse-evidence snapshots (DP-051A)**; moderation and abuse handling; observability and debugging; analytics and cookies; support/admin access; subprocessors; international transfers; retention/deletion; data-subject rights; children/vulnerable users; breach response; AI/model data-use restrictions.

A DPIA SHALL be revisited before any material change likely to alter privacy risk, including biometric speaker recognition, emotion inference, default call recording, new model training use, or materially expanded behavioural profiling.

---

## 5. Controller / processor roles

### DP-020 — Videofy can be controller and processor for different purposes — LOCKED

Videofy SHALL NOT describe itself globally as "only a processor."

For direct consumer/service accounts, Videofy is expected to determine purposes and essential means for at least some processing such as: account administration; authentication; service security; fraud/abuse prevention; billing/subscription administration; platform telemetry required to operate the service; legal/compliance handling.

For enterprise/customer-controlled communications, the enterprise customer may act as controller and Videofy may act as processor for customer-directed communication content or other processing performed only on the customer's instructions.

The actual role SHALL be documented per processing activity in the Record of Processing Activities (ROPA).

### DP-021 — Processor contracts — REQUIRED

Where Videofy acts as processor, the contract/DPA SHALL define: subject matter and duration; nature and purpose; categories of personal data; categories of data subjects; documented instructions; confidentiality; security measures; subprocessor controls; assistance with rights requests; DPIA/regulatory assistance where applicable; breach notification; deletion/return at termination; audit/assurance provisions; transfer arrangements.

---

## 6. Lawful-basis positions

Videofy SHALL maintain a versioned lawful-basis matrix. A single bundled "consent to everything" is prohibited.

| Processing | Baseline position | Notes |
|---|---|---|
| Account registration | Contract / steps requested by user | Collect only required account fields. |
| Authentication/session management | Contract + security necessity | Security logs may additionally rely on legitimate interests where applicable. |
| Connecting a requested call | Contract | Core service. |
| Transporting ordinary call content | Contract / requested communications service | Do not repurpose content. |
| Necessary call/session metadata | Contract / legitimate interests as appropriate | Minimise and retain for bounded periods. |
| Security/fraud/abuse controls | Legitimate interests or applicable legal basis | Document balancing/legitimate-interest assessment where relied upon. |
| Billing | Contract + legal obligations | Keep financial records separate from communications content. |
| Optional transcription | User-requested feature; additional consent/transparency where required | No silent activation. |
| Optional translation | User-requested feature; additional consent/transparency where required | No silent provider expansion. |
| **Personal voice synthesis (DP-055)** | **Explicit, separable consent** | Never bundled into terms acceptance. See DP-055. |
| Recording | Separate affirmative activation and participant notice/consent analysis | Default OFF. |
| **Abuse-evidence snapshot (DP-051A)** | **Legitimate interests, with a written LIA** | Narrower than recording; conditions in DP-051A. |
| Marketing email/SMS | Separate marketing basis | Do not bundle with service acceptance. |
| Non-essential tracking/cookies | Consent where required | Reject must be as usable as accept where law requires. |
| AI training on private communications | **Not authorised** | Requires future legal-policy amendment. |

### DP-030 — Legitimate interests require written assessment — REQUIRED

Where legitimate interests is used for risk-bearing processing, Videofy SHALL keep a documented legitimate-interest assessment recording: interest pursued; necessity; less intrusive alternatives; effect on data subjects; safeguards; opt-out/objection implications; review date.

> **1.1 note.** Three LIAs are currently owed: abuse and fraud prevention; abuse-evidence retention (DP-051A); security and authentication logging.

---

## 7. Core communications-content position

### DP-040 — Communications content is high-sensitivity even when not "special category" by default — LOCKED

Messages, call audio/video, attachments, transcripts and translated output may reveal health, religion, politics, sexuality, finances, family matters, location, employment information, trade secrets, or other intimate matters.

Engineering SHALL therefore apply high confidentiality controls to all communications content without first attempting to classify whether it is legally "special category."

### DP-041 — No secondary behavioural profiling from private communications — PROHIBITED

Videofy SHALL NOT derive advertising profiles, political profiles, health profiles, creditworthiness profiles, employment profiles, or general behavioural advertising segments from private call/message/transcript content.

### DP-042 — No sale of private communications data — PROHIBITED

Private message, call, transcript, attachment, voice, video or translation content SHALL NOT be sold.

---

## 8. Live media, conference audio and speaker identity

### DP-050 — Live audio/video transport is transient by default — LOCKED

Raw RTP/media SHOULD NOT be persisted by default.

Prohibited destinations for raw call media unless a separately approved feature requires them: application logs; analytics events; crash reports; observability traces; APM payloads; generic debug dumps; data warehouses.

### DP-051 — Recording is OFF by default — LOCKED

A future recording feature requires: separate feature gate; affirmative activation; conspicuous in-call recording state; participant notice; jurisdiction-aware consent/notice analysis; independent retention policy; access controls; deletion/export handling; DPIA update before production.

Hidden recording is PROHIBITED.

### DP-051A — Abuse-evidence snapshot — CONDITIONALLY APPROVED (added 1.1)

> **Why this exists.** DP-050 and DP-051 read alone would prohibit the safety control that protects the people this platform is most likely to be used against. Real-time translation removes the language barrier that limits who a fraudster can reach; a victim who reports a call must be able to produce something to review. Leaving that unaddressed would either lose the control or ship it against a LOCKED position. Neither is acceptable, so it is authorised here **narrowly and on conditions**.

A rolling audio buffer for abuse reporting is permitted subject to ALL of the following. Any deviation makes it a recording feature under DP-051.

1. **Memory-resident only.** The buffer is never written to disk, a log, a trace, a crash report or any destination listed in DP-050.
2. **Fixed and short.** A bounded window, continuously overwritten, never accumulating.
3. **Destroyed with the session.** A call that ends without a report leaves nothing behind, and that destruction is demonstrable.
4. **Persisted ONLY on a report.** Filing an abuse report is the sole event that converts any of it into stored data.
5. **Snapshot is scoped and time-boxed.** Only the buffered window is retained, under the abuse-evidence retention class (§11), not indefinitely.
6. **Disclosed.** The privacy notice describes the buffer, its length, that it is memory-only, and that only a report persists it. Processing without storage is still processing, and technically-true silence about it reads very badly when discovered.
7. **Not a general recording facility.** It SHALL NOT be readable by staff outside the break-glass workflow (DP-121), exported, or repurposed for quality, training, analytics or product improvement.
8. **DPIA entry required** before production.

This position is deliberately narrower than DP-051. It authorises evidence for a reported incident, and nothing else.

### DP-052 — Session identity may identify speakers; biometric voice recognition may not — LOCKED

Videofy MAY attribute audio to an authenticated session participant using authoritative session/WebRTC signalling metadata.

Videofy SHALL NOT create or use voiceprints, speaker-recognition templates, biometric embeddings or other biometric voice recognition to uniquely identify participants unless a future biometric-specific DPIA and legal amendment explicitly authorise it.

This aligns with the existing P6.4 architecture: participant identity is derived from authoritative signalling, not from transcript text or guessed track order.

### DP-053 — Fail-closed speaker attribution — LOCKED

If speaker identity cannot be established from the approved authoritative mapping: remain unresolved/unbound; do not guess from track arrival order; do not guess from transceiver order; do not guess from slot order; do not guess from participant join order; do not infer identity from transcript content; do not create biometric identification as a fallback.

Privacy and correctness favour missing attribution over false attribution.

### DP-054 — Per-speaker local controls are local data — LOCKED

Local mute/volume preferences SHALL remain local unless a future feature requires synchronisation. They SHALL NOT be sent to the gateway merely for convenience.

### DP-055 — Personal voice synthesis — CONDITIONALLY APPROVED (added 1.1)

> **Why this exists.** v1.0 prohibited voice **recognition** (DP-052) and said nothing about voice **synthesis**, which is already built and shipped: a `voice-clone` provider capability, a `personalVoice` output path, and an enrolment flow that records versioned consent before any audio is captured. Silence is the dangerous state — it invites either shipping something unauthorised, or a later reading of Red Line 3 that removes a working feature. It is therefore addressed explicitly.

**The distinction that matters.** A voiceprint used to decide *who is speaking* is biometric processing for unique identification and remains PROHIBITED under DP-052. A voice model used to *speak a translation in the speaker's own voice* is synthesis: it is not compared against anybody, it identifies no one, and it answers no question about identity. Only the second is authorised here.

Permitted subject to ALL of the following:

1. **Explicit, separable consent**, captured BEFORE any audio is recorded, never bundled into terms acceptance, and refusable without losing the ability to use calls. Consent to have a voice modelled is not consent to use the product.
2. **Versioned consent text**, so a stored profile records which wording it was granted under.
3. **Never used for identification.** No matching, no comparison, no verification, no attribution. DP-052 continues to govern.
4. **Withdrawal deletes the model**, not merely its use.
5. **Deletion propagates to the provider.** Closing an account or withdrawing consent SHALL delete the voice model at the synthesis provider as well as locally. Retaining a voice model after erasure is the specific failure this clause exists to prevent, and it must be TESTED end to end rather than assumed from reading code.
6. **Not training data.** DP-061 and DP-160 apply without exception: no provider may use enrolment audio or the derived model for training, tuning or product improvement.
7. **Disclosed to the other party.** Anyone hearing a synthesised voice is told it is machine-generated, in their own language (see §29, already implemented).
8. **DPIA entry required** before production, and a **Class C** review before any use beyond speaking that person's own translated words.

**Still PROHIBITED**, for the avoidance of doubt: modelling a voice from audio captured without that person's own explicit consent; synthesising a voice to impersonate anyone other than the enrolled speaker; retaining a model after withdrawal.

---

## 9. Translation, transcription and generated audio

### DP-060 — STT/translation/TTS are distinct processing purposes — LOCKED

Original media transport, transcription, translation and generated audio are not one undifferentiated purpose.

Each external provider path SHALL be individually documented in: data inventory; ROPA; subprocessor register; transfer register; DPIA; privacy notice, where transparency requires it.

### DP-061 — Provider training is prohibited by default — PROHIBITED

No provider may use Videofy private communications, transcripts, prompts, translations, attachments or generated-audio inputs for: general model training; provider product improvement using content; human review unrelated to providing the contracted service; advertising.

Any exception requires a formal amendment of this document before activation.

### DP-062 — Data sent to AI/media providers must be minimised — REQUIRED

Adapters SHALL send only the minimum content and identifiers necessary.

Avoid sending: internal user IDs where a per-request opaque ID will do; email addresses; phone numbers; billing identifiers; unrelated conversation history; full account profiles.

> **1.1 status.** Verified in code on 25 Aug 2026: the Deepgram and ElevenLabs adapters send audio and configuration only. No account identifier, address or participant id reaches either provider. Recorded here so it is not re-derived or accidentally regressed. See §29.

### DP-063 — No transcript content in logs — PROHIBITED

Application and provider logs SHALL NOT contain transcript text or translation text except in a specifically approved, access-controlled diagnostic incident workflow with an explicit temporary retention period.

---

## 10. Messaging architecture

### DP-070 — Content and metadata separation — LOCKED

Message architecture SHALL distinguish: content; attachments/objects; routing/delivery metadata; security/audit data; search indexes; moderation/abuse evidence; legal holds.

They SHALL NOT share an inseparable retention lifecycle.

### DP-071 — Policy-driven retention — LOCKED

Retention periods SHALL NOT be embedded as schema assumptions such as "all messages = 90 days."

A versioned retention policy determines expiry.

```text
RetentionPolicy
  id
  dataClass
  jurisdiction
  purpose
  defaultTtl
  policyVersion
  effectiveFrom
  effectiveTo

RetainableResource
  createdAt
  expiresAt
  retentionPolicyId
  deletedAt

LegalHold
  resourceType
  resourceId / scope
  reason
  imposedAt
  releasedAt
  authorityReference
```

### DP-071A — Who controls the retention policy — LOCKED (added 1.1)

A decided product position, recorded so the schema is built once:

- **Individual / personal accounts** may choose a retention setting for their own one-to-one conversations: keep, auto-delete after a chosen period, or minimal.
- **Organizations do NOT get a retention setting.** Their conversations are always retained until an explicit deletion act. A retention policy on a company is a standing instruction that destroys records quietly and on a schedule, which on a business conversation is indistinguishable from spoliation — and "our system was configured to delete it" is an admission that the configuration was chosen.
- **Organization deletion is an ACT, by the governing account only** — the organization Owner, not an administrator, not a member — requiring step-up authentication and producing an audit record that is not itself deletable.
- A member SHALL NOT be able to remove organization records by leaving, by deleting their own copy, or by any personal setting.

This does not override §11 or DP-072: statutory retention, legal hold and abuse evidence survive both the setting and the act.

### DP-072 — Deletion means derivative deletion — LOCKED

Deletion orchestration SHALL account for every derivative the system controls, including: primary database rows/content blobs; attachments/object storage; caches; search indexes; thumbnails/previews; generated transcripts; generated translations; generated audio artifacts; **personal voice models, including at the provider (DP-055.5)**; vector/embedding stores if ever introduced; analytics copies; moderation copies unless separately justified; provider-side copies under the processor contract; backups according to the backup expiry schedule.

A UI-only soft delete is not sufficient.

---

## 11. Interim Videofy retention schedule

These are **conservative engineering defaults**, not periods prescribed by the NDP Act, EU GDPR or UK GDPR. They must be reviewed against actual product needs and may be adjusted through a documented privacy review.

| Data class | Interim default | Rule |
|---|---:|---|
| Raw live RTP/media | **Not persisted** | Transport only. |
| Media processing buffers | Session lifetime / shortest technically feasible | Memory/temp storage only where feasible. |
| **Abuse-evidence rolling buffer** | **Session lifetime, memory only** | Destroyed at session end unless a report persists it (DP-051A). |
| STT/translation transient working payload | ≤ 1 hour after session completion | Shorter where provider allows. |
| Unsaved transcript | ≤ 24 hours | Only if transient persistence is technically required; otherwise delete at session end. |
| Generated translated-audio transient artifact | ≤ 24 hours | Unless user explicitly saves an approved artifact. |
| **Personal voice model** | **Life of the consent** | Deleted locally AND at the provider on withdrawal or account closure (DP-055.5). |
| Call signalling / routine diagnostics | 30 days | No communications content. |
| Security/authentication logs | 180 days | Restrict access; extend only for documented security need. |
| Consumer message content | 365-day default auto-expiry **unless product/tenant setting lawfully selects another period** | User deletion may shorten. Organization accounts: see DP-071A. |
| Attachments | No longer than parent message | Earlier deletion allowed. |
| User-deleted production content | purge from active systems within 30 days | Legal hold / abuse evidence exception must be explicit. |
| Backups containing deleted content | expire through normal backup lifecycle, target ≤ 35 days | Deleted content must not be restored to ordinary active use without reapplying deletions. |
| Privacy/support complaint record | 3 years after closure | Keep communications content only if necessary to resolve/defend the complaint. |
| Abuse/safety evidence | Case-specific, default review at 12 months | Retention beyond review requires documented reason. Survives the reported party's deletion, or deletion becomes the move every abuser makes on being reported. |
| Billing/tax/accounting records | Separate statutory/business schedule | Never retain call/message bodies merely because finance records must be kept. |
| Legal hold | Until formally released | Scope must be narrow and auditable. |

### DP-073 — Retention changes are policy changes — REQUIRED

Any change to retention defaults requires: reason; affected data class; lawful basis/purpose check; DPIA impact check where material; version; effective date; migration/backfill plan; audit record.

---

## 12. Data subject rights

Videofy SHALL provide operational processes for applicable rights including: access; correction; deletion/erasure; restriction; objection; portability where applicable; withdrawal of consent where consent is the basis; complaint; rights related to automated decision-making where applicable.

### DP-080 — Rights requests require identity verification proportional to risk — LOCKED

Do not expose account data because someone merely knows an email address. Verification SHALL be proportionate and SHALL NOT collect excessive new identity data.

### DP-081 — Rights orchestration must include derivatives — REQUIRED

A deletion or export job SHALL traverse the authoritative data inventory, not only the main user table.

### DP-082 — UK complaint process — REQUIRED BEFORE UK TARGETING

As of 19 June 2026, UK organisations/controllers within scope must support a clear data-protection complaint process. Videofy's UK-targeted service SHALL provide an electronic mechanism, acknowledge a complaint within 30 days, investigate appropriately, and communicate the outcome without undue delay.

---

## 13. Children and vulnerable users

### DP-090 — v1 launch posture is 18+ — LOCKED

Until a dedicated child-data review is approved: account creation is 18+; terms/privacy notices state the age requirement; marketing SHALL NOT target schools/children; product SHALL use reasonable age assurance appropriate to risk; known child accounts SHALL be handled under an escalation procedure rather than silently ignored.

A future child-access programme requires a separate DPIA/legal work package.

---

## 14. Analytics, cookies, SDKs and advertising

### DP-100 — No third-party tracking SDK may enter call/message surfaces without privacy review — BLOCK MERGE

Particularly sensitive examples: session replay; advertising pixels; cross-site behavioural trackers; fingerprinting; DOM capture tools.

### DP-101 — Communications content must not enter analytics — PROHIBITED

Analytics events SHALL use opaque identifiers and product-state metadata, never private message/audio/transcript/attachment content.

### DP-102 — Non-essential storage/access technologies require jurisdiction-aware consent — REQUIRED

Cookie/SDK consent SHALL distinguish necessary functionality from non-essential analytics/marketing. Dark patterns are prohibited.

---

## 15. Encryption and claims

### DP-110 — Encryption in transit is mandatory — LOCKED

External and internal sensitive paths SHALL use modern authenticated encryption appropriate to the transport.

### DP-111 — At-rest protection is mandatory for persisted communications content — LOCKED

Sensitive data SHALL be encrypted at rest using managed key controls appropriate to the deployment.

### DP-112 — "End-to-end encrypted" is a controlled claim — LOCKED

Videofy SHALL NOT describe a communication path as end-to-end encrypted if Videofy or a cloud STT/translation/TTS service can access intelligible content in that path.

If genuine E2EE is later offered and enabling a cloud feature changes the trust boundary, the UI and privacy notice SHALL say so clearly before activation.

> **1.1 note.** `docs/COMMUNICATION_ARCHITECTURE.md` §0.1 implements this: translation and E2EE are recorded as mutually exclusive, and the product is forbidden from displaying a padlock, the words "end-to-end", or any borrowed security idiom — specifically because the interface deliberately resembles one that has trained billions of people to assume E2EE.

---

## 16. Access control and support access

### DP-120 — Least privilege — LOCKED

Staff do not receive general access to customer communications merely because they are administrators.

### DP-121 — Break-glass support access — REQUIRED

Where support access to private content is genuinely necessary: user/customer request or documented security/legal reason; least-privilege temporary access; reason code; time-bound grant; auditable access; optional dual approval for highly sensitive operations; automatic expiry.

Casual browsing is PROHIBITED.

---

## 17. Subprocessors and international transfers

### DP-130 — No unknown subprocessor — BLOCK RELEASE

Every production vendor that receives personal data must be listed in a Subprocessor Register.

Minimum fields: provider; service; data categories; purpose; processing locations; subprocessors used by provider where material; retention; content training allowed yes/no; DPA status; security review; breach notification SLA; Nigerian transfer basis; EU transfer basis; UK transfer basis; approval date; owner.

### DP-131 — Nigeria outbound transfer control — LOCKED

Transfers from Nigeria must comply with NDP Act cross-border requirements, including adequate protection or another lawful statutory route.

### DP-132 — EU restricted transfers — LOCKED

Where EU GDPR applies and data is transferred to a third country without an applicable adequacy decision, an appropriate Chapter V mechanism and any required transfer assessment/supplementary measures SHALL be in place before the transfer.

Nigeria is not listed on the European Commission's current adequacy-decision list as of this position date.

### DP-133 — UK restricted transfers — LOCKED

Where UK GDPR restricted-transfer rules apply, an appropriate UK transfer mechanism and required risk/data-protection assessment SHALL be completed before the transfer.

---

## 18. Breach response

### DP-140 — Breach clock starts when awareness threshold is reached — LOCKED

Incident response SHALL preserve: detected time; awareness time; affected systems; data categories; approximate records/data subjects; jurisdictions; risk assessment; containment; notification decisions; regulator/user notifications; remediation.

### DP-141 — Nigeria regulatory deadline — REQUIRED

Where a Nigerian breach meets the statutory risk threshold, the NDP Act requires controller notification to the Commission within 72 hours of awareness.

### DP-142 — Processor SLA must leave Videofy time to comply — REQUIRED

Subprocessor contracts should require breach notification to Videofy **without undue delay and, as an internal contracting target, no later than 24 hours after provider awareness**, unless a stronger contractual term is available.

The 24-hour term is a Videofy contracting control, not a statutory Nigerian/EU/UK deadline.

### DP-143 — Breach register — REQUIRED

Maintain a record of all personal-data breaches, including breaches not ultimately reported.

---

## 19. Privacy notices and consent receipts

### DP-150 — Versioned privacy notice — REQUIRED

Record: notice version; effective date; languages; jurisdictions; material changes.

### DP-151 — Consent receipts — REQUIRED where consent is used

Minimum: data subject/account; purpose; notice/version shown; choice; timestamp; source/UI context; withdrawal timestamp; proof without unnecessary device fingerprinting.

Consent for service access, marketing, recording, **personal voice synthesis**, and non-essential tracking SHALL NOT be collapsed into one control.

---

## 20. AI-data-use prohibition

### DP-160 — Private content is not training data — PROHIBITED

Unless this document is amended after a dedicated legal/privacy review, Videofy and its providers SHALL NOT use private communications to train, fine-tune, evaluate general-purpose models, or create unrelated datasets.

Synthetic test data or data collected under an explicit separate research programme may be used only under its own documented lawful basis, notice and controls.

### DP-161 — No emotion/health/political inference from communications — PROHIBITED

Do not infer sensitive traits from voice, video, message or transcript content as a product feature without a dedicated legal work package.

---

## 21. Privacy/security logging rules

### DP-170 — Sensitive payload logging deny-list — LOCKED

The logging layer SHALL reject or redact: message bodies; transcript/translation text; call audio/video bytes; attachment contents; auth tokens; passwords; provider API secrets; payment credentials; raw cookie/session secrets.

> **1.1 status.** Implemented in `packages/account-trust/src/security-events.ts`. The security event type has no free-form payload field, so content has nowhere to go by construction; `FORBIDDEN_EVENT_FIELDS` is the executable form of this list; and the sink DROPS an event carrying a forbidden field rather than writing it. See §29.

### DP-171 — Prefer stable opaque IDs — REQUIRED

Logs should identify operational objects through opaque identifiers, not email/phone/display name where avoidable.

---

## 22. Data inventory / ROPA

### DP-180 — No undocumented personal-data path — BLOCK RELEASE

Each production processing path must have an entry covering: feature/system; controller/processor role; purpose; lawful basis; data subjects; data fields/categories; source; recipients; subprocessors; locations; retention class; security classification; rights/deletion route; transfer mechanism; DPIA relevance; owner.

The ROPA/data inventory is the source of truth for deletion/export coverage.

---

## 23. Product red lines

The following are prohibited unless this document is formally amended:

1. hidden/default-on call recording;
2. provider training on private communications;
3. voiceprint/speaker biometric **identification** (synthesis of an enrolled speaker's own voice is governed by DP-055, not by this line);
4. sale of private communications content;
5. behavioural advertising derived from private communications;
6. raw audio/video in generic logs;
7. transcript/message bodies in analytics;
8. indefinite storage without documented purpose/review;
9. "delete" that leaves uncontrolled active copies in indexes/object stores/derivatives;
10. unreviewed foreign AI/cloud subprocessors;
11. unsupported E2EE marketing claims;
12. bundled marketing/tracking consent;
13. unrestricted staff access to private conversations;
14. production launch without required Nigerian DPIA;
15. EU/UK targeting without applicable representative/transfer analysis;
16. introduction of tracking/session-replay SDKs on private communication surfaces without approval;
17. silently using communications content to infer special-category traits.

---

## 24. Release gates

### BLOCK RELEASE

Production release is blocked when any applicable item below is unresolved:

- Nigerian DPIA not complete/filed where required;
- data inventory/ROPA materially incomplete;
- unknown production subprocessor;
- transfer basis absent for a restricted transfer;
- no privacy notice covering deployed processing;
- retention/deletion worker absent for newly persisted communications data;
- content may leak into logs/analytics;
- recording enabled without required controls;
- **abuse-evidence buffer deployed without the DP-051A conditions met**;
- **personal voice synthesis deployed without the DP-055 conditions met, including proven deletion at the provider**;
- provider contract permits private-content training;
- data-subject deletion cannot propagate to controlled derivatives;
- security incident/breach process absent;
- **any unauthenticated privileged operational surface**;
- UK-targeted launch without complaint mechanism;
- EU/UK-targeted launch without representative analysis where applicable.

---

## 25. Governance

### Privacy change classes

**Class A — ordinary implementation**: implements an already approved control; no new data category/purpose/provider.

**Class B — privacy review required**: new subprocessor; materially longer retention; new analytics/tracking; new use of content; new country/region; recording; new persistent transcript/translation; new staff-access capability.

**Class C — DPIA/legal amendment required before production**: biometric recognition; emotion/sensitive-trait inference; large-scale monitoring/profiling; child-focused service; model training on user content; significant automated decisions; materially new high-risk communication surveillance; **any use of a personal voice model beyond speaking that person's own translated words**.

Every Class B/C change must identify the exact data-flow change before code is approved.

---

## 26. Canonical implementation rule

**Retention periods do not need to be hard-coded before tables are written.
The tables and services must, however, be capable of enforcing purpose-bound, versioned retention, deletion, legal hold and jurisdictional policy before production data is entrusted to them.**

This is the controlling interpretation for Videofy-Live messaging schema design.

---

## 27. Required companion documents

```text
docs/privacy/
├── DATA_PROTECTION_POSITIONS.md
├── PRIVACY_ENGINEERING_REQUIREMENTS.md
├── DATA_INVENTORY.md
├── RECORD_OF_PROCESSING_ACTIVITIES.md
├── DPIA_VIDEOFY_LIVE.md
├── RETENTION_SCHEDULE.md
├── DELETION_AND_LEGAL_HOLD.md
├── LAWFUL_BASIS_MATRIX.md
├── SUBPROCESSOR_REGISTER.md
├── INTERNATIONAL_TRANSFERS.md
├── CONSENT_AND_NOTICE_REQUIREMENTS.md
├── CHILDREN_AND_AGE_POLICY.md
├── AI_DATA_USE_POLICY.md
├── DATA_SUBJECT_RIGHTS_RUNBOOK.md
└── DATA_BREACH_RUNBOOK.md
```

No blank template should be represented as completed compliance evidence.

---

## 28. Counsel status

**Position:** APPROVED AS ENGINEERING BASELINE
**Open formalities:** Nigerian DPIA drafting/filing; ROPA completion against actual production data flows; provider-specific DPA/transfer review; representative appointments if/when EU/UK targeting triggers them; final public notices generated from deployed facts.

**Change authority:** Product/technical lead plus documented privacy/legal review for Class B/C changes.

**1.1 amendments** are additive engineering clarifications recording facts already true of the built system and closing two silences (DP-055, DP-051A) that would otherwise have forced either an unauthorised feature or the removal of a working one. They remove no obligation and require counsel ratification at the next review.

---

## 29. Implementation status — as at 25 August 2026 (added 1.1)

> **Why this section exists.** A baseline that only states obligations invites two expensive mistakes: rebuilding a control that already exists, and ripping out a correct one because nothing recorded that it was deliberate. Everything below was **verified in code or on the deployed host**, not inferred.

### Verified satisfied

| Position | Evidence |
|---|---|
| DP-062 | Deepgram and ElevenLabs adapters send audio and configuration only. No account id, address, phone or participant id. |
| DP-170 | `security-events.ts`: no free-form payload field exists on the event type; `FORBIDDEN_EVENT_FIELDS` enumerates the deny-list; the sink drops rather than writes a violating event. |
| DP-171 | Security events carry opaque account ids; addresses appear only as a salted digest, and are OMITTED entirely when no salt is configured rather than falling back to plaintext. |
| DP-110 | TLS terminated at the edge; database reached over loopback only. |
| DP-112 | Implemented as a product rule in `docs/COMMUNICATION_ARCHITECTURE.md` §0.1. |
| DP-053 | Speaker attribution derives from authoritative signalling (P6.4); no ordering heuristics. |

### Deployed facts

- **Hosting:** single VPS, `c7-eu-01`, EU. PostgreSQL 16 on the same host, bound to localhost, scram-sha-256.
- **Subprocessors in use:** Deepgram (US, STT), ElevenLabs (US, TTS and voice synthesis), Cloudflare (US/global, edge and DNS), Contabo (EU, hosting), Resend via Amazon SES `eu-west-1` (EU, transactional email).
- **Backups:** nightly `pg_dump`, local only, restore proven into a scratch database. **No off-box copy** — a lost machine is currently a lost database.
- **Secrets:** database password, MFA keyring and recovery pepper generated on the host and never transported through a chat, a repository or a command argument.

### Known gaps, tracked

| Gap | Position | Status |
|---|---|---|
| Nigerian DPIA not started | DP-010 | **BLOCK RELEASE** for production |
| Subprocessor Register not written | DP-130 | **BLOCK RELEASE** |
| Provider training settings unverified per vendor | DP-061 | **BLOCK RELEASE** — needs dashboard checks |
| Operator console is unauthenticated | DP-120/121 | **BLOCK RELEASE**; held off production by a boot guard |
| Voice-model deletion at the provider unproven | DP-055.5 | Must be tested end to end |
| Retention/legal-hold model not built | DP-071, §26 | Blocks the messaging schema |
| No LIAs written | DP-030 | Three owed |
| Off-box backups unconfigured | §11 | Destination decision outstanding |
| Age assurance not implemented | DP-090 | 18+ is locked; enforcement not built |
