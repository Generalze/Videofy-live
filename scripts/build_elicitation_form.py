#!/usr/bin/env python3
"""Build the native-source elicitation form, one per language.

This is the FIRST thing a contributor receives — before the V2 forward pack,
before any candidate output, before any answer key. A contributor who has
already read thirty translations of money and OTP cases has learned what the
benchmark hunts for and will write toward it, and their sentences would then
test the engines on the cases we already knew about rather than the ones we
did not.

The form carries the contributor permission at the top and will not be sent
without it. Reviewer-authored text is NOT C7-owned by default: writing
sentences transfers no copyright, and an earlier draft of this project's
documentation wrongly said otherwise. What is obtained here is a broad
perpetual LICENCE; the author keeps their copyright.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

LANGUAGES = {"yo": "Yoruba", "ha": "Hausa", "ig": "Igbo"}

PERMISSION = (
    "By submitting these messages and English meanings, I confirm they are my "
    "original writing and grant C7 / Tech Advance Concept a perpetual, worldwide, "
    "irrevocable, royalty-free licence to use, reproduce, modify, evaluate, "
    "publish internally, and use them for training, testing, benchmarking and "
    "improving translation systems and related C7 services."
)

# Fifteen slots, each naming what it is for. Prompting per row rather than in a
# preamble is what stops a contributor writing fifteen greetings -- and every
# category here is one that has already broken an engine, except the ordinary
# ones, which exist so naturalness can be judged against something normal.
SLOTS: list[tuple[str, str]] = [
    ("money", "A price or an amount — what something costs, or what is owed"),
    ("money", "Confirming you HAVE received a payment"),
    ("money-negation", "Saying you have NOT received a payment. Use your normal way of "
                       "saying 'not' — this exact shape has already broken two engines"),
    ("money", "Asking someone to send money, with the amount"),
    ("identifier", "A message containing a phone number"),
    ("identifier", "A message containing an account number or a code (like an OTP)"),
    ("datetime", "Arranging a meeting — with a day and a time"),
    ("datetime", "Telling someone a plan has changed to a different day or time"),
    ("datetime", "Saying you are running late, with how long"),
    ("instruction", "Telling someone to do something"),
    ("instruction-negation", "Telling someone NOT to do something, or a warning"),
    ("instruction", "Asking someone to bring or collect something"),
    ("ordinary", "A greeting — how you would really open a message"),
    ("ordinary", "A question to a friend or family member"),
    ("code-switch", "A message that MIXES English with your language, if that is how "
                    "you normally write. Leave blank if that is not natural for you"),
]


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1
               else "docs/certification/review-packets-v2/elicitation")
    out.mkdir(parents=True, exist_ok=True)

    for code, name in LANGUAGES.items():
        path = out / f"elicitation-{code}.csv"
        with path.open("w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow([f"C7 {name} source messages — please read the permission below"])
            w.writerow([PERMISSION])
            w.writerow(["I agree (type YES here):", ""])
            w.writerow(["Your name (for attribution, optional):", ""])
            w.writerow([])
            w.writerow(["item", "what this one is for",
                        f"your message in {name}",
                        "what it means in English"])
            for i, (_, prompt) in enumerate(SLOTS, 1):
                w.writerow([i, prompt, "", ""])
        print(f"  {name:8s} -> {path.name}")

        (out / f"ELICITATION-{code}.md").write_text(brief(name, code), encoding="utf-8")

    print("\nSend the elicitation form FIRST. Do not send the V2 review pack,")
    print("any answer key, or any machine score until the form comes back frozen.")
    return 0


def brief(name: str, code: str) -> str:
    return f"""# Writing {name} messages for C7 — about 20 minutes

Thank you. This is a small task, and it is the part nobody else can do.

## Please read this first

{PERMISSION}

You keep the copyright in what you write. This is permission to use it, not a
transfer of ownership. Type **YES** in the form to agree, and add your name if
you would like to be credited.

## What we need

C7 (Videofy Live) is choosing a translation engine for {name}. We can test
English → {name} ourselves, but we cannot test **{name} → English**, because
that needs real {name} written by a {name} speaker — and nobody on our team is
one. Everything we could find was either unusable for licence reasons or drawn
from religious texts that do not resemble how people actually message.

So: open `elicitation-{code}.csv` and write **15 short messages in {name}** — the
kind you would really send to a friend, family member, or someone you do
business with. Each row tells you what that one is for.

Then, in the last column, write **what it means in English**.

## What makes a good answer

**Write how you actually type**, not how you would write formally. If you would
use short forms, or mix in English words, do that — one row specifically asks
for a mixed message, and you should leave it blank if mixing is not natural for
you.

**Keep them short.** One or two sentences.

**Do not translate from English.** Write the {name} first, as the message you
would send, then say what it means.

## About the English column

It is what the message MEANS, not a model answer. If a translation engine later
says it differently but gets the meaning right, that counts as correct. You are
giving us the meaning to check against, not the wording.

## What happens next

Your 15 messages get locked before any software touches them. Then translation
engines translate them into English, and we will ask you to judge those English
translations — without telling you which engine produced which, so nothing
influences you.

You will not see any of those translations until after you have sent this back.
That is deliberate: if you saw them first, you would naturally write messages
aimed at the problems you had already noticed, and we would learn nothing new.
"""


if __name__ == "__main__":
    raise SystemExit(main())
