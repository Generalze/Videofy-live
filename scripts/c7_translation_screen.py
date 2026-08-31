#!/usr/bin/env python3
"""C7 Phase-1 translation screen: integrity first, metrics only as diagnosis.

CTO directive, 31 Aug 2026: "DO NOT USE BLEU/chrF AS THE VERDICT." A
translation that reads beautifully and turns "I received the money" into "I did
not receive the money" is worse than one that reads awkwardly and keeps the
meaning, and every similarity metric ever written prefers the first one.

So this module scores INTEGRITY -- things that are machine-checkable and
categorical -- and reports chrF alongside purely as a diagnostic.

  1. NUMERIC PRESERVATION   45,000 / 08031234567 / 4:30 must survive
  2. ENTITY PRESERVATION    Zoe, Lagos, Abeokuta must not mutate
  3. NEGATION PRESERVATION  polarity must not flip
  4. OMISSION               no sentence silently dropped
  5. HALLUCINATION          no sentence invented
  6. TARGET LANGUAGE        the output is in the language requested
  7. NON-LINGUISTIC INPUT   blank / emoji / code must not become prose

WHY THESE AND NOT OTHERS. Each one is a failure already OBSERVED in this
project, not a hypothetical: OPUS-MT turned "two thousand naira per bag" into
"2,000 tons", emitted the literal string "(Igbo)" inside Hausa output, and
answered a request for an address with a line of Qur'anic narrative. A screen
that would have passed those is not a screen.

DIRECTION MATTERS. en->X and X->en are separate models with separate failure
modes and are scored separately. A candidate that cannot do X->en is not a
messaging engine, because a chat has two ends.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field

# --------------------------------------------------------------------------
# The screening corpus.
#
# Every mandatory category from the directive, kept small on purpose: Phase 1
# eliminates categorically broken candidates, it does not rank good ones. The
# thousand-message benchmark comes after, for the top two only.
#
# `keep` lists the substrings that MUST survive translation. They are written
# out rather than inferred, because inference is how a checker quietly stops
# checking: a regex that finds no numbers in a sentence reports no number
# defects, and looks identical to a pass.
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Case:
    category: str
    text: str
    keep: tuple[str, ...] = ()
    # Strings that mean NOTHING except as an exact digit sequence: phone
    # numbers, account numbers, OTPs. Declared, never inferred -- a length rule
    # counted the QUANTITY 2000 as an identifier in the first run, which is the
    # difference between "wrote the amount in words" and "sent money to the
    # wrong account".
    identifiers: tuple[str, ...] = ()
    negated: bool = False
    sentences: int = 1
    non_linguistic: bool = False


CORPUS: tuple[Case, ...] = (
    # --- money: the failure that started this
    Case("money", "The price is two thousand naira per bag.", ("2000", "naira")),
    Case("money", "Please send 45,000 naira to my account today.", ("45,000", "45000")),
    Case("money", "I have received the money you sent.", ()),
    Case("money", "I have not received the money you sent.", (), negated=True),
    Case("money", "Your balance is 12,500 naira.", ("12,500", "12500")),
    # --- identifiers that must survive verbatim
    Case("phone", "Call me on 08031234567 when you arrive.",
         identifiers=("08031234567",)),
    Case("account", "Transfer to account 0123456789 at First Bank.",
         identifiers=("0123456789",)),
    Case("otp", "Your verification code is 483920. Do not share it.",
         identifiers=("483920",), negated=True, sentences=2),
    Case("url", "Read more at https://consummate7.com/help before you call.",
         ("https://consummate7.com/help",)),
    # --- dates and times: weakest band in every engine measured so far
    Case("datetime", "The event starts at four thirty on the fifteenth of March.", ()),
    Case("datetime", "The meeting has been moved to 15 March at 4:30.",
         ("15", "4:30", "March")),
    # --- names and Nigerian places
    Case("entity", "My name is Zoe and I work in Lagos.", ("Zoe", "Lagos")),
    Case("entity", "Adebayo travelled from Abeokuta to Kano last night.",
         ("Adebayo", "Abeokuta", "Kano")),
    # --- negation and double negation
    Case("negation", "Do not send the payment yet.", (), negated=True),
    Case("negation", "I did not say that I would not come.", (), negated=True),
    Case("negation", "She has not arrived at the office.", (), negated=True),
    # --- instructions, health, agriculture, business
    Case("health", "Take one tablet twice a day after eating.", ()),
    Case("health", "Do not give this medicine to a child under five years old.",
         ("five", "5"), negated=True),
    Case("agriculture", "The rains will start next month, so prepare the land now.", ()),
    Case("business", "We need to sign the agreement before the end of the month.", ()),
    Case("broadcast", "Good morning everyone, and welcome to this broadcast.", ()),
    Case("conversation", "How are you doing this evening?", ()),
    Case("conversation", "Please send me the address before you leave.", ()),
    # --- multi-sentence: where omission hides
    Case("multi", "I am on my way. Please wait for me at the gate. I will be there soon.",
         (), sentences=3),
    Case("multi", "The meeting is cancelled. We will meet tomorrow instead.",
         (), sentences=2),
    # --- long message
    Case("long",
         "Thank you for your message. I have spoken to the supplier and the goods "
         "will arrive on Friday morning. Please make sure somebody is at the shop "
         "to receive them, and call me if there is any problem with the delivery.",
         ("Friday",), sentences=3),
    # --- non-linguistic input: must never become invented prose
    Case("blank", "", (), non_linguistic=True),
    Case("emoji-only", "👍👍", (), non_linguistic=True),
    Case("number-only", "45000", ("45000",), non_linguistic=True),
    Case("code-only", "OTP-483920", identifiers=("483920",), non_linguistic=True),
    Case("punctuation", "???!!!", (), non_linguistic=True),
    # --- mixed language and emoji with text
    Case("mixed", "Abeg send the money before 5pm 🙏", ("5",)),
    Case("emoji-text", "Congratulations on the new baby 🎉 we are very happy for you.", ()),
    Case("hashtag", "Join us tonight #VideofyLive for the broadcast.", ("#VideofyLive",)),
)

# --------------------------------------------------------------------------
# chrF -- diagnostic only, never the verdict.
# --------------------------------------------------------------------------
def _ngrams(text: str, n: int) -> Counter:
    s = re.sub(r"\s+", "", text.lower())
    return Counter(s[i : i + n] for i in range(len(s) - n + 1))


def chrf(hyp: str, ref: str, max_n: int = 6, beta: float = 2.0) -> float:
    ps, rs = [], []
    for n in range(1, max_n + 1):
        h, r = _ngrams(hyp, n), _ngrams(ref, n)
        if not h or not r:
            continue
        ov = sum((h & r).values())
        ps.append(ov / max(1, sum(h.values())))
        rs.append(ov / max(1, sum(r.values())))
    if not ps:
        return 0.0
    p, r = sum(ps) / len(ps), sum(rs) / len(rs)
    if p + r == 0:
        return 0.0
    b2 = beta * beta
    return 100.0 * (1 + b2) * p * r / (b2 * p + r)


# --------------------------------------------------------------------------
# Integrity checks. Each returns a defect string or None.
# --------------------------------------------------------------------------
NEG_MARKERS = {
    "en": (r"\bnot\b", r"\bn't\b", r"\bno\b", r"\bnever\b", r"\bdon'?t\b", r"\bwithout\b"),
    # Written out per language because a negation checker that only knows
    # English cannot see a flipped Yoruba sentence, which is the direction that
    # matters most: nobody in the room can read it either.
    # `ò` and `kò` both negate, and the BARE form is the common one. Missing it
    # made the first run of this screen report a correct Yoruba double negation
    # ("Mi ò sọ pé mi ò ní wá") as a lost one.
    "yo": (r"\bkò\b", r"\bko\b", r"\bò\b", r"\bkì\b", r"\bki\b", r"\bmá\b",
           r"\bma\b", r"\bàì\b", r"\blàì\b", r"\blái\b"),
    "ha": (r"\bba\b", r"\bbabu\b", r"\bkada\b", r"\bkar\b", r"\bbai\b"),
    # IGBO NEGATES BY SUFFIX, which a word-boundary pattern cannot see. The
    # first run of this screen reported five false "negation-lost" against
    # `enweghị`, `bụghị`, `dịghị` and `abụghị` -- all correctly negated -- and
    # would have condemned an engine for working. `\w*gh[iị]` is the fix.
    "ig": (r"\w*gh[iị]\b", r"\badigh\w*", r"\banagh\w*", r"\bọdịgh\w*",
           r"\bekwe\w*na\b", r"\bnata\b"),
}

DIGITS = re.compile(r"\d")


def normalise_number(s: str) -> str:
    return re.sub(r"[^\d]", "", s)


def check(case: Case, output: str, target: str) -> list[str]:
    """Every integrity failure in one translation, named."""
    found: list[str] = []
    out = (output or "").strip()

    # 7. NON-LINGUISTIC INPUT
    if case.non_linguistic:
        # Blank in, blank or near-blank out. Anything with several words is the
        # model inventing content for input that carried none.
        if case.text.strip() == "" and len(out.split()) > 0:
            found.append(f"invented-from-blank({out[:40]!r})")
        elif case.text.strip() and len(out.split()) > max(4, len(case.text.split()) + 3):
            found.append(f"invented-from-non-linguistic({out[:40]!r})")

    if not out:
        if case.text.strip():
            found.append("empty-output")
        return found

    # 1. NUMERIC / verbatim preservation
    #
    # TWO CLASSES, and conflating them was a real error in the first run of this
    # screen. A phone number, OTP or account number is an IDENTIFIER: it means
    # nothing except as an exact digit string, and one wrong digit sends money
    # to a stranger. An amount or a count is a QUANTITY, and rendering "five" as
    # "márùn-ún" or "two thousand" as "ẹgbẹ̀rún méjì" is CORRECT translation --
    # a checker that calls that a defect punishes the model for working.
    #
    # The same mistake applied to place names: Lagos -> Èkó is the right Yoruba
    # exonym, not a lost entity. Only a mutated name is a defect, and this
    # checker cannot tell those apart, so it reports rather than convicts.
    for token in case.keep:
        if token in out:
            continue
        digits = normalise_number(token)
        if digits and digits in normalise_number(out):
            continue
        if DIGITS.search(token):
            # May have been spelled out in a language this checker cannot read.
            found.append(f"quantity-unverified:{token}")
        else:
            found.append(f"lexical-unverified:{token}")

    for token in case.identifiers:
        digits = normalise_number(token)
        if digits and digits in normalise_number(out):
            continue
        # Unambiguous and severe. Nothing legitimate reformats a phone number
        # into different digits.
        found.append(f"identifier-corrupted:{token}")

    # 3. NEGATION PRESERVATION -- the defect that matters most in a chat
    if case.negated:
        markers = NEG_MARKERS.get(target, NEG_MARKERS["en"])
        if not any(re.search(m, out, re.I) for m in markers):
            found.append("negation-lost")

    # 4/5. OMISSION and HALLUCINATION, by sentence count
    #
    # Counting CLAUSE boundaries, not full stops, and requiring real length
    # loss. Yoruba and Igbo routinely join what English splits, so a
    # three-sentence source arriving as one sentence with two semicolons has
    # lost nothing -- and the first run of this screen called that an omission
    # four times per language. Real omission shows up as missing CONTENT.
    out_sentences = len([s for s in re.split(r"[.!?;。]+", out) if s.strip()])
    length_ratio = len(out) / max(1, len(case.text))
    if case.sentences > 1 and out_sentences < case.sentences and length_ratio < 0.6:
        found.append(
            f"omission({out_sentences}/{case.sentences} clauses, {length_ratio:.0%} length)"
        )
    if out_sentences > case.sentences + 1:
        found.append(f"addition({out_sentences}/{case.sentences} sentences)")

    # Degeneration: the repetition loop already observed in Igbo and MADLAD.
    toks = out.split()
    for i in range(len(toks) - 2):
        if toks[i] == toks[i + 1] == toks[i + 2] and len(toks[i]) > 1:
            found.append(f"repetition-loop({toks[i]})")
            break

    # 6. TARGET LANGUAGE -- script is a floor, not a ceiling. These three are
    # Latin-script, so anything else is a routing failure rather than a bad
    # translation. It cannot detect "fluent Hausa when Yoruba was asked for";
    # only a speaker can, which is why Phase 5 exists.
    for ch in out:
        if ch.isalpha() and not unicodedata.name(ch, "").startswith("LATIN"):
            found.append("non-latin-script")
            break

    # Untranslated passthrough -- but NOT for non-linguistic input, where
    # returning the input unchanged is the CORRECT answer. An emoji, a bare
    # number, an OTP string and a row of punctuation have no translation, and
    # handing them back verbatim is what a good engine should do. Flagging that
    # counted MADLAD's correct handling of four such cases as failures.
    if (case.text.strip() and target != "en" and not case.non_linguistic
            and chrf(out, case.text) > 88):
        found.append("passthrough")

    return found


@dataclass
class Row:
    engine: str
    direction: str
    case: Case
    output: str
    latency_ms: float
    defects: list[str] = field(default_factory=list)
