# @videofy-live/translation-routes

The **directional translation route registry**. It answers one question:

```ts
registry.mayTranslate('en', 'yo', 'call-live');
```

— may production translate **this source** into **this target** for **this
service**, and if not, **why not**.

## What is a route

One source language, one target language, one model. `en->yo` and `yo->en` are
**two records**. A model that renders English into Yoruba has demonstrated
nothing about rendering Yoruba into English: different training data, different
failure modes, and different people qualified to say it is wrong. Approving one
never approves the other, and no test in this package passes if that changes.

## What it decides, and what it does not

| Decides | Does not decide |
| --- | --- |
| Whether a route may run at all | Whether the user can afford it |
| Whether it may run for `messaging`, `programme-live`, `call-live` — separately | What a second of translation costs |
| Why it may not, in words that name who can fix it | Anybody's balance |

Allowance is the credit system's business (`@videofy-live/billing-tariff`).
`no-billing.test.ts` fails the build if a price, credit, tariff or currency
field appears — on the type, in a JSON document, or as a dependency.

## Refusals

| Reason | What it means | Who clears it |
| --- | --- | --- |
| `unknown-direction` | Nobody has written this pair down | whoever wants the language |
| `no-approved-route` | A record exists and is not production-approved (or has no model behind it at all) | measurement, then approval |
| `licence-unresolved` | Commercial use is `restricted` or `unknown` | legal |
| `human-review-outstanding` | Review failed, or is outstanding for a review-required language | a speaker of the language |
| `not-approved-for-scope` | Approved, but not for the service that asked | whoever owns that service |

An **unknown direction is refused, never defaulted**. There is no fallback
route, no nearest approved pair, no widening from one language to a neighbour.

## There is no global switch

Nothing here turns OPUS-MT, or any provider, "on". Approval is per record, per
direction, per scope. An engine-wide flag is exactly the mechanism that would
carry `en->es` evidence into `en->yo` production, which is the defect this
package exists to make impossible.

## Promoting evidence

Records live in a JSON document, so a measured, licensed, reviewed route is
promoted by **editing one file** — no code change, no release. Every rule still
applies to that file:

- `productionApproved` with `technicalEvidence: null` → **document refused**
- a scope `approved` while human review is outstanding for `yo`, `ha`, `ig` or
  `pcm` → **document refused**
- `productionApproved` without established commercial use → **document refused**
- a scope `approved` on a route that is not `productionApproved` → **document
  refused** (scopes *narrow* production approval; they never grant it)
- the same direction twice, an unknown field, a missing scope → **document
  refused**

A document that breaks one rule loads **nothing**. There is no partial load.

```ts
import { loadTranslationRouteRegistry } from '@videofy-live/translation-routes/document-file';

const loaded = loadTranslationRouteRegistry();
if (!loaded.ok) { /* refuse to translate; the problems name the field */ }
```

`TRANSLATION_ROUTES_DOCUMENT` (a variable **name**; its value is never printed)
points at the document in force. With nothing set, the shipped seed is used.

## The seed

`routes/translation-routes.seed.json` holds **twelve directions, every one
unapproved**: `en<->yo`, `en<->ha`, `en<->ig`, `en<->pcm`, `en<->es`, `en<->fr`.
It grants nothing. It exists so promoting a route means editing a record that
already names the direction, and so that `en<->pcm` — which **no model in this
deployment covers** — is a declared gap (`provider: "unassigned"`, which
validation refuses to approve) rather than an absence nobody noticed.
