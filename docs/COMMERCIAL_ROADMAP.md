# Videofy Live — road to a commercial product

Owner: Zoe (masterzee001). Drafted 2026-08-24.

**What this document is for.** Everything below the baseline is work that has not been
done. The purpose is to make the distance to a *sellable* product explicit and ordered,
so that effort goes to what blocks revenue rather than to what is interesting.

**The rule that governs it.** Nothing here may be called certified, production-ready or
validated on the strength of our own tests. Where an external party has to confirm
something — a security reviewer, a payment processor, a KYC vendor, a customer's legal
team — that confirmation is the exit criterion, not our belief that it would pass.

---

## 0. Honest baseline — what actually exists today

Stated plainly, because every plan built on a flattering baseline fails at the same point.

### Works, and is tested

- **Real-time multilingual calls.** Browser-to-browser, audio server-mediated, video P2P
  mesh with TURN relay. Verified working across Windows and mobile.
- **Live translation pipeline**, end to end, with real commercial providers on staging:
  Deepgram (`nova`) speech recognition, ElevenLabs speech synthesis, local `opus-mt`
  translation. 0 unavailable language pairs at last check.
- **The invention defence.** Silero VAD + autocorrelation voicing + a confidence floor
  that captions but refuses to *speak* low-confidence output. This was the top business
  risk and it is addressed.
- **Programme path** — operator, viewer, per-language selection — sharing one pipeline
  with calls.
- **Account trust model**: derived components (email/phone/identity + risk + restriction),
  never a `verified` boolean.
- **Organizations**: seats, invitations with email binding, roles, last-owner protection,
  atomic ownership transfer, over-capacity on downgrade.
- **Public site**: C7 ecosystem → Videofy family → Videofy Live, with disclosure tests
  that fail the build if unshipped capability is described as working.
- **Deployed**: Contabo VPS `c7-eu-01`, staging.consummate7.com, Caddy + Cloudflare,
  coturn relay.

### Does not work, or does not exist

| Gap | Consequence |
|---|---|
| ~~`OrganizationStore` has no persistence~~ | **FIXED 2026-08-25.** PostgreSQL 16 on staging; organizations, memberships and invitations survive a restart |
| ~~No database anywhere in the repo~~ | **FIXED.** Plain `pg`, forward-only migrations, row-oriented ports. Staging runs `C7_ACCOUNT_STORE=postgres` |
| **Operator console is anonymous** | Programme control has no authentication; blocked from production only by a boot guard |
| **Six security modules are wired into nothing** | Consent, recovery, MFA, step-up, rate limits, security events, identity change exist with tests and protect nothing |
| **Identity verification is synthetic** | Refused in production by design. No KYC/KYB vendor chosen |
| **No legal content** | No terms, privacy policy, DPA, acceptable use or eligibility policy |
| **No billing of any kind** | No pricing, no payment rail, no subscription, no invoicing |
| **Single instance only** | In-memory rate limits and media state; no horizontal scale path |
| **Backups are local-only** | Nightly `pg_dump` + a **proven** restore (verified into a scratch database on 2026-08-25). No off-box copy yet, so a lost machine is still a lost database |
| **No production domain** | staging only |
| **Language claims exceed reality** | French/Portuguese/Yoruba/Igbo/Hausa not actually selectable in the apps |
| **No native mobile** | Browser only |
| **No abuse reporting, and no trust & safety controls at all** | Nothing tells a listener the voice is machine-translated; there is no way to report a call and nothing to review it with |

---

## The critical path to a first paying customer

Phases 1–5 in order. Nothing in 6–8 is on the critical path, however attractive.

```
1. Durability  ->  2. Security close-out  ->  3. Trust & Safety  ->  4. Legal & trust  ->  5. Commercial
   (data survives)   (nothing anonymous)      (not a fraud tool)     (a lawyer says yes)   (money moves)
```

Everything else is growth, and growth before this line is building on sand.

**Why Trust & Safety is on this path and not in a later phase.** The platform removes the
language barrier that currently limits who a fraudster can target. That is the product
working as designed, and it is also the abuse case. It is the first question a journalist
or a regulator will ask, and the answer has to already exist.

---

## Phase 1 — Durability

**Why first.** A product that forgets your organization when the service restarts cannot
be sold at any price, and no later phase is worth building on top of it. This is also the
cheapest phase to get wrong quietly, because in-memory state looks perfect in every test
that does not restart the process.

| Work | Notes |
|---|---|
| Choose a database | PostgreSQL is the default answer. Decide once, in writing |
| Persist organizations, memberships, invitations | Currently pure in-memory. Highest-severity item in this document |
| Migrate accounts off the JSON file | `createFileAccountRecords` is a staging device |
| Migration tooling | Schema changes must be repeatable and reversible |
| Transactions | Seat reservation and ownership transfer are already lock-based; they need real transactional guarantees, not a per-process mutex |
| Backup, and a **proven** restore | A backup nobody has restored is a belief, not a backup |
| Retention and encryption of backups | Backups must never hold secrets or KYC data in the clear |

**Exit criteria**
- Restart the service; every account, organization, membership and invitation survives.
- A restore is performed from backup into a clean environment and demonstrated working.
- Concurrent seat reservation proven correct against the database, not the in-process lock.

---

## Phase 2 — Security close-out

**Why second.** These are the controls a customer's security questionnaire asks about, and
two of them are open holes rather than missing features.

| Work | Notes |
|---|---|
| **Authenticate the operator console** | Programme control is anonymous today. This is a hole, not a gap |
| Widen `createCallerResolver` to a `Caller` object | The bottleneck: step-up evidence, correlation ids and consent status have nowhere to ride. Do this **first and once** |
| Wire MFA + step-up | Module complete and unused. Step-up must be a revocable server-side grant, **not** a session-token claim — the token is `{sub,iat,exp,ver}` and every service verifies it locally |
| Encrypt the TOTP secret at rest | AES-256-GCM with a deployment key; envelope carries key id, iv, tag; boot refuses on a missing or short key |
| Wire password reset | Enumeration-safe by type; revokes sessions on completion |
| Wire consent capture | Versioned; required versions come from deployment configuration |
| Wire abuse limits | Move off the in-memory limiter to a shared store; derive the trusted client IP correctly behind Caddy — a forgeable `X-Forwarded-For` both bypasses the limit and lets an attacker lock somebody else out |
| Wire security events + correlation ids | Structured JSON to stdout matches the existing log shape |
| Per-account lock | For flows that span awaits (MFA enrolment, email change) |
| Secrets handling | Three new deployment secrets, each fail-closed at boot like `requireSessionSecret` |
| **Independent security review / penetration test** | External. Our own tests do not close this |

**Exit criteria**
- No anonymous privileged surface anywhere.
- Step-up enforced on every operation that declares it.
- An external reviewer's findings are resolved or accepted in writing.

---

## Phase 3 — Trust and safety

**Why third, and on the critical path.** Real-time translation removes the barrier that
limits a fraudster's target pool: it lets somebody run a romance or business-payment scam
in a language they do not speak. This is the owner's stated top risk, and it is correct.

**Why KYC is the wrong instrument for it.** Organised fraudsters buy identity documents,
so document verification filters out casual abuse and lets through precisely the people it
was bought to stop. It also verifies who *signed up*, not what they *do* — a verified
account defrauds just as effectively, now carrying a trust signal the platform granted it.
The useful signal is behavioural.

### 3.1 Disclosure — the strongest control, and the cheapest

A persistent, unmissable indicator, rendered **in the listener's own language**, that the
voice they are hearing is an automated translation and that the speaker is not speaking
their language. Spoken once at call start and visible for the duration.

This attacks the mechanism of harm rather than the identity of the actor. A scam depends on
the victim believing the voice is a person speaking to them; a victim who has been told
otherwise has largely been inoculated. It requires no vendor, carries no legal exposure,
and it is the answer to "did you warn people?".

Not a settings toggle. Not dismissible.

### 3.2 Reporting, evidence and review

The agreed design, stated precisely so it is not re-litigated later:

| Rule | Detail |
|---|---|
| Reporting | One tap, from inside the call |
| Audio retention trigger | **A report, and nothing else.** No call is retained by default |
| How retroactive capture works | A fixed-length **memory-only rolling buffer**, continuously overwritten and never written to disk. A report is what persists it |
| Why a buffer is required | By the time somebody taps report, the harmful audio has already happened. Recording *from* the tap captures the fraudster going quiet |
| Review | Every report is reviewed by a person. No report is closed automatically |
| Suspension during review | **Permitted, but gated on credibility** — reporter history, corroboration, account age. See the risk below |
| Appeal | The reported account is notified and may appeal within a defined window (default 7 days, configurable) |
| No appeal within the window | The complainant's account is taken to stand |
| What that unappealed outcome may do | Move the account to a **reversible** state — restricted or suspended. Never an irreversible deletion or permanent ban |
| Appeal after the window | Still openable. The window sets the default, not the ceiling |

**The weaponisation risk, and why suspension is gated.** If a single report suspends an
account, reporting becomes a denial-of-service tool — against honest users, against
competitors, and against victims whom a fraudster wants silenced. Credibility weighting is
what stops the safety system from becoming the attack.

**Why the default outcome stays reversible.** A notice that lands in a spam folder must not
end an account permanently. Under GDPR Article 22 an automated decision with significant
effect carries a right to human review, and a permanent ban by default judgement is exactly
the decision that right exists for.

**Buffer privacy obligations.** A rolling buffer is still processing, even though nothing is
stored. It must be disclosed in the privacy policy, fixed in length, memory-resident, and
provably destroyed when a call ends without a report.

### 3.3 Behavioural controls

Mostly already built and wired into nothing — see branch `c7/security-lifecycle-addendum`.

| Control | Where it already lives |
|---|---|
| Call, signup and invite velocity | `security-events.ts`, `rate-limit.ts` |
| Escalation without ejecting anybody | `trust-model.ts` — `risk: step_up_required / restricted / suspended` |
| Human review and appeal | §115 review/appeal seam |
| Shared IP / device / payment-instrument clustering | To build |

Plus three product-level rules:

- **New-account reach limits.** A day-old account may not call many strangers. Reach is
  earned over time, which costs a fraudster the one thing they cannot buy cheaply.
- **Payment instrument as a reach gate.** A verified card is a stronger identity signal
  than a document: it is traceable, chargeback-able, and fraudsters burn them. Requiring one
  for outbound reach to strangers filters more real fraud than document KYC.
- **Victim-side provenance.** Show the callee what is known: account age, whether it is
  verified, whether they have spoken before.

**Exit criteria**
- Translation disclosure present in every call, in the listener's language, undismissable.
- A report can be filed in one tap and reaches a human, with a stated response time.
- Retention demonstrably occurs only on report, and the buffer is destroyed otherwise.
- A weaponised-report scenario is tested: mass false reports do not suspend a good account.

---

## Phase 4 — Legal and trust

**Rewritten.** Document KYC is **off** the critical path — see Phase 3 for why it is a weak
control against the actual threat. What moves up are the checks that are cheap, lawful to
run in-house, and effective against impersonation.

### What to build, in order

| Work | Who does it | Notes |
|---|---|---|
| **DNS domain verification** | **In-house** | Highest value per unit of effort for B2B. Proving control of `company.com` is what actually stops impersonation. No legal exposure |
| Payment-instrument verification | The PSP, as a side effect | Stronger identity signal than a document |
| Business-registry lookup | In-house where public | CAC in Nigeria, Companies House in the UK |
| Email + phone verification | **Already built** | |
| Document / biometric KYC | Vendor, later | Only when a specific requirement forces it |

### Legal content — still required, still gating

| Work | Notes |
|---|---|
| **Nigerian DPIA, filed with the NDPC** | **BLOCK RELEASE.** GAID 2025 names communications software explicitly, so this is a regulator filing rather than an internal document. The longest-lead item on this page |
| **Subprocessor Register completed** | **BLOCK RELEASE.** Drafted at `docs/privacy/SUBPROCESSOR_REGISTER.md`; only the contractual columns remain, and they need vendor-account access |
| **Provider training turned off, in writing** | **BLOCK RELEASE.** Deepgram and ElevenLabs. "Provider contract permits private-content training" is an explicit blocker |
| Terms, Privacy Policy, Acceptable Use, DPA | Professionally reviewed. The consent module already versions them |
| Age assurance for the locked 18+ posture | DP-090 LOCKS 18+; the enforcement is not built |
| **Privacy policy must cover the rolling audio buffer** | New, from Phase 3. Processing without storage is still processing |
| Eligibility / age / minor-consent policy | Required before general launch. Do not invent a minimum age in code |
| Automated-decision disclosure | GDPR Art 22: suspension and restriction decisions need a stated human-review right |
| Data residency decision | EU-hosted VPS with Nigerian users means GDPR **and** NDPR both apply |
| Subprocessor disclosure | Deepgram, ElevenLabs, Cloudflare, Contabo, plus payment and any KYC vendor |
| Data export, deletion, retention | §117 seam. Deletion must not break audit integrity or legal hold |
| Law-enforcement response process | Once abuse evidence is retained, requests for it will follow. Decide the process before the first one arrives |

> **The privacy baseline is `docs/privacy/DATA_PROTECTION_POSITIONS.md` (v1.1), counsel-approved,
> and it governs this phase.** Its BLOCK RELEASE gates are listed above rather than left implicit.
> Its §29 records what is already verified as satisfied, so this phase does not re-do finished work.

**A Nigeria-specific constraint.** NIN verification runs through NIMC and BVN through
NIBSS, and access to both is **licensed**. Direct querying generally requires being a
licensed agent or going through an approved aggregator. This is a legal constraint rather
than a technical one, and it is the thing most likely to defeat a do-it-yourself document
check in Nigeria. Confirm with a Nigerian lawyer before assuming any route is open.

**Exit criteria**
- A prospective customer's legal review can be answered from documents that exist.
- Domain verification is live and is the basis of any "verified organization" presentation.

---

## Phase 5 — Commercial mechanics

**Why here.** Everything above must be true before money changes hands. Pricing is the
owner's decision and is deliberately not proposed.

**Charging for your own software is ordinary merchant activity.** Custom enterprise
pricing, invoices, bank transfer and annual contracts are all unregulated. The regulatory
line is crossed by *how money moves*, not by how much is charged or how bespoke the deal.

| Stays unregulated | Crosses into regulated territory |
|---|---|
| Self-serve tiers via a PSP (the PSP is the regulated party; you are the merchant) | Holding or transmitting funds for others — money transmission |
| Custom enterprise contracts, invoicing, bank transfer | Processing payments *for* customers so they can bill *their* customers |
| Prepaid credits that are non-transferable, service-only and not cash-refundable | Transferable or cash-refundable credit, which begins to look like e-money |
| Ordinary net-30 invoice terms | Credit arrangements that function as lending |

| Work | Notes |
|---|---|
| **Pricing and packaging** | Owner's call. `corporate` / `enterprise` exist as identifiers with no prices attached, deliberately |
| Payment rail | A card/international rail plus a Nigerian one (Paystack or Flutterwave). Likely both |
| Subscription and entitlement binding | Contracted seats follow billing truth; the over-capacity state already absorbs downgrades without ejecting members |
| Enterprise invoicing | Custom terms, purchase orders, annual commitments |
| Tax and VAT | Jurisdiction-dependent |
| Dunning and failed payment | What happens to a call in progress when a card fails? Decide deliberately |
| Trial policy | Length, limits, and what happens at expiry |

**Exit criteria**
- A customer signs up, pays, and their entitlement changes automatically.
- An enterprise customer can be invoiced on custom terms without bespoke engineering.
- A downgrade, a failed payment and a cancellation each behave as specified.

---

## Phase 6 — Reliability and scale

Not on the critical path to the first customer; squarely on the path to the tenth, and to
any SLA commitment.

| Work | Notes |
|---|---|
| **Measure capacity** | How many concurrent calls and programmes per node? Translation is CPU-only on the current box — this number is probably small and is currently unknown |
| Horizontal scaling | Media state, rate limits and session affinity all assume one instance |
| Load testing with real audio | Synthetic load will not exercise the pipeline honestly |
| Monitoring, alerting, on-call | `ALERTABLE` events exist with nowhere to page |
| Incident process and status page | |
| SLA definition | Only after capacity is measured. An SLA promised before measurement is a guess with penalties attached |

**Exit criteria**
- Documented capacity per node and a tested scale-out path.
- Alerting proven by a deliberately triggered incident.

---

## Phase 7 — Product completion

What customers will ask for once they can buy.

| Work | Notes |
|---|---|
| **Language truth** | Make French and Portuguese genuinely selectable. Yoruba/Igbo/Hausa need a different ASR — Deepgram `nova-3` does not support them. Until then, do not present them |
| Recording, transcripts, exports | The most-requested business feature, and a compliance question |
| Programme channels | Multiple operators, per-channel visibility, device policy. Designed, not built. Operator auth must land with it |
| Native mobile | Currently browser only |
| SIP / PSTN reach | Adapter work exists (P6.8/P6.9); carrier relationships are the long lead |
| Third-party integrations | Zoom and LiveKit/KingsConference adapters are designed with validation externally deferred |
| Accessibility and performance close-out | Partially complete |
| Trust & safety tooling maturity | Reviewer console, case management, bulk actions. Phase 3 ships the controls; this makes them efficient to operate |

---

## Phase 8 — Go to market

| Work | Notes |
|---|---|
| **Production domain** | None yet; staging only |
| Onboarding, product docs, help centre | |
| Support desk and response targets | |
| Pilot customers under written agreement | The first real validation of everything above |
| Case studies and references | |

---

## Risk register

| Risk | Severity | Response |
|---|---|---|
| Organization data loss on restart | **Critical** | Phase 1, first item |
| Anonymous operator console reaches production | **Critical** | Boot guard holds today; Phase 2 removes the hole |
| Security modules stay unwired and are believed to be protecting something | High | Phase 2; recorded in memory so it cannot become an audit surprise |
| Provider cost per minute makes the unit economics negative | High | Measure cost per translated minute **before** pricing |
| Deepgram/ElevenLabs outage or price change | High | Provider-neutral boundary exists; keep a second vendor viable |
| CPU-only translation caps concurrency far below expectation | High | Phase 5 measurement, early |
| KYC vendor lead time blocks launch | Medium | Start Phase 3 vendor selection during Phase 1 |
| GDPR **and** NDPR both apply | Medium | Decide residency early; it constrains hosting |
| Single VPS is a single point of failure | Medium | Phase 6 |
| **Platform used to defraud people in a language the fraudster does not speak** | **Critical** | Phase 3: disclosure, reach limits, report-and-review |
| Reporting weaponised to suspend honest accounts | High | Credibility-gated suspension; reversible outcomes only |
| Unappealed default judgement bans somebody who never saw the notice | High | Reversible states only; appeals remain openable after the window |
| Rolling audio buffer treated as "not processing" because nothing is stored | Medium | Disclose it; fix its length; prove destruction |
| Retained abuse evidence attracts law-enforcement requests | Medium | Define the response process before the first request |

---

## What to do next

1. **Phase 1, item 2** — persist organizations. It is the single highest-severity item in
   this document and the cheapest to fix now rather than after there is customer data.
2. **Ship translation disclosure.** It is small, needs no vendor, and is the single
   strongest control against the abuse case. There is no reason for it to wait for a phase.
3. **In parallel, start the long poles**: legal drafting has an external lead time and
   gates Phase 4. KYC vendor selection no longer does — it is off the critical path.
4. **Measure cost per translated minute** before any pricing conversation. Unit economics
   decided after pricing is a decision made twice.

Phase 2 wiring is already scoped: branch `c7/security-lifecycle-addendum` holds the
modules, and the four prerequisites are established — widen `createCallerResolver`, use a
server-side step-up grant, add a per-account lock, and copy the existing fail-closed
secret pattern.
