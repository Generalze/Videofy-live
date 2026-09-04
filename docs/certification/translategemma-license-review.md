# TranslateGemma 4B — licence review

Prepared 31 Aug 2026 per CTO directive Lane 2, **before** asking the founder to
accept anything. Sources are Google's own documents: the Gemma Terms of Use at
`ai.google.dev/gemma/terms` and the Gemma Prohibited Use Policy at
`ai.google.dev/gemma/prohibited_use_policy`, which the Terms incorporate by
reference.

> **This is not legal advice and states nothing beyond what the licence text
> establishes.** Where the text is silent, this document says it is silent
> rather than filling the gap. Anything that turns on C7's specific deployment
> is flagged for the founder, not resolved here.

## Identification

| field | value |
|---|---|
| model id | `google/translategemma-4b-it` |
| revision | `10042cb0e6e7fdce748996a71dc3dc432a4e0c89` (returned in the 401 response) |
| publisher | Google |
| licence identifier | `gemma` — the **Gemma Terms of Use**, not Apache-2.0 or MIT |
| access | **gated**; `GatedRepoError` 401 until terms are accepted on Hugging Face |
| staged | no |

## What the Terms permit

**Use, including commercial.** The grant is "use, reproduce, modify,
Distribute, perform or display any of the Gemma Services" subject to the terms.
Nothing in the text restricts commercial use.

**Hosted services are explicitly contemplated.** "Hosted Service" — access by
API, web, or other remote electronic means — falls inside the definition of
permitted Distribution. This is the provision that matters most for C7, because
C7's intended shape is exactly that: the weights run server-side and users reach
them over the network.

**Charging money is not restricted.** The Terms contain no provision limiting
monetisation of a service built on Gemma or of its outputs. C7's model — free
allowance then paid credits — is not addressed and therefore not prohibited.

**Outputs are yours.** "Google claims no rights in Outputs you generate using
Gemma. You and your users are solely responsible for Outputs and their
subsequent uses." Outputs are expressly excluded from the definition of Model
Derivatives. So a translated message is not encumbered by these terms.

This is a materially different position from NLLB-200's CC-BY-NC-4.0, which
prohibits commercial use outright. **TranslateGemma is not licence-blocked in
the way NLLB is.**

## What the Terms require

| obligation | applies to C7? |
|---|---|
| Comply with the Prohibited Use Policy (incorporated by reference) | **yes, always** |
| Pass the use restrictions downstream as an enforceable provision in any agreement with recipients | **yes if C7 distributes weights**; C7's plan is server-side only |
| Include the notice "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms" with distributed copies | **exempt for Hosted Services** per the Terms; applies if weights are ever shipped |
| Mark modified files with prominent notices stating they were modified | yes, if C7 fine-tunes and distributes |
| Model Derivatives remain subject to the whole agreement | **yes** — a C7 fine-tune of TranslateGemma inherits these terms |
| No terms imposed that conflict with the base agreement | yes |

**Termination.** "Google may terminate this Agreement if you are in breach of
any term," and on termination C7 "must delete and cease use and Distribution of
all copies." There is no cure period stated in what was reviewed.

## Prohibited Use Policy — read against a messaging product

Most prohibitions are about *generating* harmful content and do not describe
what a translation engine does. Three are worth the founder's attention because
C7 processes other people's private messages:

1. **"Generating, gathering, processing, or inferring sensitive personal or
   private information about individuals without obtaining all rights."**
   C7 translates private messages, which are by nature personal information.
   The relevant question is whether C7 has the rights to process them — a
   consent and privacy-policy matter, not a model matter, but it is the clause
   that touches C7 most directly.
2. **Content that infringes any individual's or entity's rights** — a platform
   translating user-generated content carries the usual intermediary exposure.
3. **Circumventing safety filters** is prohibited, which implies the deployment
   should not strip or defeat model safeguards.

**The Policy imposes no explicit obligation to monitor end users** or to
restrict what they send. That is worth stating plainly, because the opposite
assumption would change C7's product design.

## Assessment against the directive's question

> "whether C7's self-hosted paid translation model is permitted"

On the text reviewed: **yes, the Terms contemplate it** — self-hosted,
server-side, offered as a hosted service, monetised, with outputs unencumbered.
The obligations that bite are the Prohibited Use Policy and, only if C7 ever
distributes weights or a fine-tune, the notice and downstream-terms conditions.

**What this review cannot settle** and the founder must decide:

- Whether to accept a licence that Google may terminate for breach, on a
  component that would sit in the message path. Unlike Apache-2.0 or MIT, this
  is a *revocable* permission from a single vendor. That is a business-risk
  judgement, not a technical one.
- Whether C7's privacy posture and user consent cover processing private
  messages through it.
- Whether a future C7 fine-tune — which inherits every one of these obligations
  permanently — is an acceptable foundation compared with an MIT base such as
  M2M100.

## Language coverage — still unresolved, and it gates everything

**None of the above matters if the model does not serve C7's languages**, and
that cannot be established from outside the gate. The authoritative list is in
the repository's `chat_template.jinja`, which returns 401.

From secondary sources only: Yoruba and Hausa are reported among the 55
benchmarked languages, Nigerian Pidgin is reported in the technical report's
tables 5–6, and **Igbo is unconfirmed**. Google's own model discussion notes the
55 are the *rigorously benchmarked* set and that further languages exist in the
weights but are **experimental, with higher hallucination rates**.

Per directive, none of that counts. A language is usable only after actual
translation evidence, which requires staging, which requires the gate.

## Recommended sequence

1. **Founder reads the Prohibited Use Policy clauses above** and decides on the
   revocability question. That is the only genuinely discretionary call.
2. If accepted: accept the gate on a Hugging Face account **C7 controls**, not a
   personal one — access follows the account, and so does termination.
3. Provide a read token via `deploy/Set-EnvKey.ps1`. **Never in chat, never
   committed, never printed.**
4. Stage into the **benchmark venv only** (`/var/lib/videofy/bench/`), never
   `/opt/videofy-ai`.
5. Establish yo / ha / ig / pcm support **experimentally**, then run the same
   Phase-1 screen.

If Igbo turns out unsupported or experimental-tier, TranslateGemma cannot be a
universal answer for C7 regardless of its licence — but under the directive's
route-level decision model it could still win Hausa or Yoruba on its own merits.
