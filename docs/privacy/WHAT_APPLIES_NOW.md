# What actually applies now

**Read this before DATA_PROTECTION_POSITIONS.md.** That document is the full
baseline for the finished product. This one says which parts bite *today*, and
which are machinery for a scale that does not exist yet.

Not legal advice. This is scoping: it changes *when* obligations are met, never
*whether*. Nothing here removes a rule.

---

## The one thing worth understanding

**Almost none of it applies today**, because today there are no real users. C7
runs on staging, with test accounts the team created. That is development, and
development is not deployment of a service to data subjects.

The full baseline reads as though everything is due at once. It is not. Almost
all of it attaches at **first real user**, and a large slice only at **EU or UK
targeting** — which is a decision, not an accident.

---

## Three product decisions that delete most of the complexity

The cheapest way to reduce compliance cost is to reduce the **surface**, not to
argue with the rules. These three are worth more than any amount of drafting.

### 1. Launch Nigeria-only, deliberately

Roughly a third of the baseline exists because of EU and UK exposure:
representative appointments, Chapter V transfer mechanisms, the UK complaint
process with its 30-day clock, cookie-consent regimes, adequacy analysis.

**None of it applies if C7 does not offer the service to people in the EEA or
UK.** Targeting is about intent — marketing, currency, language aimed at those
markets — not about a European being able to load the page.

*Caveat that does not go away:* hosting is on a VPS in the EU, so Nigerian
personal data still leaves Nigeria. NDPA cross-border rules apply to that, and
it is one contractual item, not a programme.

**Decision needed:** launch markets. Nigeria-only is dramatically cheaper.

### 2. Turn voice cloning off until it earns its cost

Personal voice synthesis is the most legally expensive thing in the product,
per unit of value delivered:

- it is the only feature where a **third party holds a derived model of a
  person's voice**, rather than transient content;
- it needs its own explicit, separable consent;
- deletion has to be **proven at the provider**, not assumed;
- it is the single largest section of any DPIA;
- any use beyond speaking that person's own words is a **Class C** change.

Nobody is using it. It was built ahead of demand.

**Feature-flag it off and DP-055 stops applying entirely.** The code stays,
the tests stay, and switching it on later is a decision with a review attached
rather than a rewrite.

### 3. Do not build the abuse-recording buffer yet

Contact-gating already removes the fraud vector it was designed for: a stranger
cannot ring you at all. The buffer is a second control for a problem the first
control mostly prevents, and it introduces a recording-adjacent processing path
with its own conditions, disclosure and DPIA section.

**Ship contact gating and the translation disclosure. Add the buffer when there
is real abuse to investigate** — at which point you will also know what
evidence actually helps.

---

## Keep these — they are free

Already built, cost nothing to maintain, and each prevents a real harm:

| Control | Why it stays |
|---|---|
| Log deny-list | Already implemented. Prevents the worst-case disclosure |
| No identifiers to AI providers | Already true. Hardest thing on the list to retrofit |
| No "end-to-end encrypted" claim | A sentence you simply never write |
| Provider training turned off | Two dashboard settings |
| Deletion actually deletes | Cheap now, expensive to add after there is data |
| Translation disclosure in-call | Shipped, and it is the strongest anti-fraud control you have |

---

## Before the first real user — the short list

Not before the next commit. Before a person who is not you has an account.

1. **Nigerian DPIA.** Required, and a filing. **It shrinks a great deal if the
   decisions above are taken** — no voice cloning, no recording, one market.
2. **Privacy notice and terms** that describe what the product actually does.
3. **Subprocessor DPAs** — five vendors, mostly clicking accept.
4. **Provider training off**, in writing.
5. **Operator console authenticated.** Not a compliance item; it is an open door.
6. **Off-box backups.** Not a compliance item either; it is your business.

That is six things, and three of them are afternoons.

---

## What can wait, and should

Market activation register. Consent-receipt infrastructure. ROPA as a formal
artefact. Break-glass tooling. Fifteen companion documents. Age-assurance
technology beyond asking.

These are real obligations for a company with customers, a support team and a
privacy officer. Building them now produces documents nobody reads and code
nobody runs, and both rot before they are needed.

**Three files are enough for now:** this one, the positions baseline, and the
subprocessor register.

---

## The honest summary

The baseline is not wrong. It is written for the finished product, and C7 is
not there yet.

The expensive parts are **triggered by choices you have not yet made** —
which markets, which features, which providers. Make those choices narrowly
and most of the document simply does not apply. Make them broadly and it all
does, at once, before revenue.

Narrow now. Widen deliberately, one market and one feature at a time.
