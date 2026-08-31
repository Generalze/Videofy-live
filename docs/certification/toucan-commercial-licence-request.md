# Toucan — commercial licence request (DRAFT, not sent)

**Status: awaiting founder authorisation. Nothing has been sent to anyone.**

## Why we are asking

Toucan (UBC-NLP) is the closest technical fit to C7's exact language set of
anything surveyed. It is purpose-built for African MT, covers 156 African
directions, and — uniquely among the candidates — includes **Nigerian Pidgin**,
which neither of C7's commercially-cleared options (OPUS-MT, M2M100) supports at
all. Its authors report Toucan-1.2B ahead of NLLB-200-1.3B by ~6.96 spBLEU on
their AfroLingu-MT benchmark.

The gated Cheetah/Toucan materials require agreeing to **non-commercial use
only**, so it cannot be a production candidate as published. Asking costs a
letter; the alternative is shipping Pidgin support that does not exist.

## Recipient

The Toucan / Cheetah authors at UBC-NLP (Deep Learning & NLP Group, University
of British Columbia), via the contact on the Toucan repository or the paper's
corresponding author. **Founder to confirm the address before sending** — this
draft deliberately does not guess an individual's email.

## Draft

> **Subject:** Commercial licence enquiry — Toucan for Nigerian-language
> translation
>
> Dear UBC-NLP team,
>
> I am writing on behalf of Consummate 7, the company behind Videofy Live, a
> commercial communications platform for calling, messaging and broadcasting in
> African languages. We would like to ask whether a commercial licence for
> Toucan is available.
>
> **What we would use it for.** Machine translation of user messages and
> broadcast captions, in these directions:
>
> - English ↔ Hausa
> - English ↔ Igbo
> - English ↔ Yoruba
> - English ↔ Nigerian Pidgin
>
> **How it would be deployed.** Self-hosted, server-side, on infrastructure we
> operate. The model weights would run only on our servers and **would not be
> redistributed to end users** or shipped in any client application. Users would
> reach the model over our API and never receive the weights.
>
> **Commercial model.** Translation is our billable unit. Users receive a free
> allowance and may then pay via platform credits. We are asking about a
> commercial licence precisely because that makes the current non-commercial
> terms inapplicable to us, and we would rather ask than assume.
>
> **Why Toucan specifically.** We evaluated OPUS-MT, M2M100, MADLAD-400 and
> NLLB-200 against our own Nigerian-language test set. Toucan is the only model
> we found that covers Nigerian Pidgin alongside Hausa, Igbo and Yoruba, and
> your reported results against NLLB-200 on AfroLingu-MT are the strongest we
> have seen for these languages. NLLB itself is unavailable to us for the same
> non-commercial reason.
>
> **What we would like to know.**
>
> 1. Whether a commercial licence for Toucan is available at all.
> 2. Terms and any fees, including whether they scale with usage.
> 3. Attribution or citation obligations you would want us to carry.
> 4. Whether a commercially licensed version may be fine-tuned on our own data,
>    and what obligations would attach to the resulting model.
> 5. Any restrictions on the languages or directions we have listed.
>
> We are happy to discuss evaluation results, attribution, or a research
> collaboration if that is of interest — our test set for these four languages
> is something we would be glad to share.
>
> Thank you for the work; it is the closest thing we have found to what these
> languages actually need.
>
> Kind regards,
>
> Zoe M. Akpan
> Founder & CTO, Consummate 7
> consummate7.com

## Notes for the founder before sending

- **Nothing here commits C7 to anything.** It asks whether terms exist and what
  they are.
- The draft states our deployment shape honestly — server-side, no weight
  redistribution, paid after a free allowance. That is the part a licensor cares
  about, and understating it would poison any agreement that followed.
- The offer to share our test set is genuine and cheap: it is 34 cases of
  ordinary Nigerian messaging content, and a research group building African MT
  may find the money/OTP/negation cases useful. Remove it if you would rather
  not.
- If UBC-NLP says no, Pidgin stays unsupported by every cleared candidate and
  the honest product answer is that C7 does not translate Pidgin yet — not that
  it routes Pidgin through something that answers in a different language.
