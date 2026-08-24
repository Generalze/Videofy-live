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
| **`OrganizationStore` has no persistence at all** — three in-memory `Map`s | Every organization, membership and invitation is destroyed on restart or deploy |
| **No database anywhere in the repo** | Accounts persist to a JSON file; nothing else persists |
| **Operator console is anonymous** | Programme control has no authentication; blocked from production only by a boot guard |
| **Six security modules are wired into nothing** | Consent, recovery, MFA, step-up, rate limits, security events, identity change exist with tests and protect nothing |
| **Identity verification is synthetic** | Refused in production by design. No KYC/KYB vendor chosen |
| **No legal content** | No terms, privacy policy, DPA, acceptable use or eligibility policy |
| **No billing of any kind** | No pricing, no payment rail, no subscription, no invoicing |
| **Single instance only** | In-memory rate limits and media state; no horizontal scale path |
| **No backup or restore** | Never demonstrated, for either store |
| **No production domain** | staging only |
| **Language claims exceed reality** | French/Portuguese/Yoruba/Igbo/Hausa not actually selectable in the apps |
| **No native mobile** | Browser only |

---

## The critical path to a first paying customer

Phases 1–4 in order. Nothing in 5–7 is on the critical path, however attractive.

```
1. Durability  ->  2. Security close-out  ->  3. Legal & trust  ->  4. Commercial mechanics
   (data survives)   (nothing anonymous)      (a lawyer can say yes)  (money can change hands)
```

Everything else is growth, and growth before this line is building on sand.

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

## Phase 3 — Legal and trust

**Why third.** A business buyer's legal review will stop the sale, and several items have
long external lead times — start them early even though they gate later.

| Work | Notes |
|---|---|
| Terms of Service, Privacy Policy, Acceptable Use, DPA | Real content, professionally reviewed. The consent module is ready to version them |
| Eligibility / age / minor-consent policy | Required before general launch. Do not invent a minimum age in code |
| Choose and integrate a **real KYC/KYB provider** | Identity is synthetic and refused in production. Provider-neutral boundary already exists |
| Domain verification (distinct from KYB) | DNS challenge or approved business-email proof. A claimed domain is not an owned domain |
| Data residency decision | EU-hosted VPS with Nigerian users: GDPR **and** NDPR both apply. Decide and document where data lives |
| Subprocessor disclosure | Deepgram, ElevenLabs, Cloudflare, Contabo, plus the payment and KYC vendors |
| Data export, deletion, retention | §117 seam. Deletion must not break audit integrity or legal hold |
| Recording and transcript policy | Consent to record varies by jurisdiction and is a product decision with legal teeth |

**Exit criteria**
- A prospective customer's legal review can be answered from documents that exist.
- Production KYC is unblocked because policy content exists and a vendor is live.

---

## Phase 4 — Commercial mechanics

**Why fourth.** Everything above must be true before money changes hands. Pricing is the
owner's decision and is deliberately not proposed here.

| Work | Notes |
|---|---|
| **Pricing and packaging** | Owner's call. `corporate` / `enterprise` exist as identifiers with no prices attached, deliberately |
| Payment rail | Card/international plus a Nigerian rail (Paystack or Flutterwave). Likely both |
| Subscription and entitlement binding | Contracted seats must follow billing truth; the over-capacity state already exists to absorb downgrades without ejecting members |
| Invoicing, tax/VAT, receipts | Jurisdiction-dependent |
| Dunning and failed payment | What happens to a live call when a card fails? Decide deliberately |
| Trial policy | Length, limits, and what happens at expiry |
| Self-serve signup to paid | The conversion path end to end |

**Exit criteria**
- A customer signs up, pays, and their entitlement changes automatically.
- A downgrade, a failed payment and a cancellation each behave as specified.

---

## Phase 5 — Reliability and scale

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

## Phase 6 — Product completion

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

---

## Phase 7 — Go to market

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
| Single VPS is a single point of failure | Medium | Phase 5 |

---

## What to do next

1. **Phase 1, item 2** — persist organizations. It is the single highest-severity item in
   this document and the cheapest to fix now rather than after there is customer data.
2. **In parallel, start the long poles**: KYC vendor selection and legal drafting both
   have external lead times and gate Phase 3.
3. **Measure cost per translated minute** before any pricing conversation. Unit economics
   decided after pricing is a decision made twice.

Phase 2 wiring is already scoped: branch `c7/security-lifecycle-addendum` holds the
modules, and the four prerequisites are established — widen `createCallerResolver`, use a
server-side step-up grant, add a per-account lock, and copy the existing fail-closed
secret pattern.
