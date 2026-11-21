#!/usr/bin/env python3
"""Which model answers for each catalogue language, and in what script.

ONE TABLE, DECLARED, NEVER INFERRED. Every entry below was checked against
the Hub on 10 Oct 2026 (a repo that does not exist answers 401 there, and the
control for that is recorded in the commit). Precedence when more than one
model could serve a direction:

    dedicated pair  >  tc-big pair  >  language-group model with a target
    token  >  M2M100 1.2B (MIT)  >  nothing

A GROUP MODEL IS ONLY AS GOOD AS ITS TOKEN. `opus-mt-en-ROMANCE` with
`>>por<<` answered Portuguese in Italian, six times out of thirty-four, and
nothing errored. So a prefix here is a CLAIM, and run_translation_screen.py
refuses to run a language whose prefix is not in the loaded tokenizer's vocab.
The tokens were read from each model's vocab.json, not guessed.

The script column is what the integrity checker compares output against. The
checker used to call ANY non-Latin output a defect -- correct for the three
Nigerian languages it was written for, and flatly wrong for Chinese, Arabic,
Hindi and Russian. Script comes from the language catalogue.

NOT HERE: ha, yo, ig, pcm. The Nigerian languages have their own screen,
their own review packets and their own rulings (Igbo and Pidgin are dropped by
the founder's ruling of 20 Sep 2026). English is the pivot, not a target.
"""
from __future__ import annotations

from dataclasses import dataclass

M2M100 = "facebook/m2m100_1.2B"


@dataclass(frozen=True)
class Route:
    """One direction's engine. `prefix` is the target token, with its trailing
    space, for Marian group models; empty for dedicated pairs."""
    engine: str            # "opus" | "m2m100"
    model: str             # HF repo id, or the M2M100 language code
    prefix: str = ""
    resolved_by: str = ""  # dedicated | tc-big | group | m2m100


def _opus(model: str, prefix: str = "", by: str = "dedicated") -> Route:
    return Route("opus", f"Helsinki-NLP/{model}", prefix, by)


def _grp(model: str, token: str) -> Route:
    return Route("opus", f"Helsinki-NLP/{model}", f">>{token}<< ", "group")


def _m2m(code: str) -> Route:
    return Route("m2m100", code, "", "m2m100")


# Catalogue order (by speakers), English and the Nigerian four removed.
INTERNATIONAL: tuple[str, ...] = (
    "zh", "hi", "es", "fr", "ar", "bn", "pt", "ru", "ur", "id", "de", "ja", "sw",
    "mr", "te", "tr", "ta", "vi", "ko", "fa", "it", "gu", "th", "pa", "kn", "fil",
    "pl", "ml", "ms", "or", "my", "uk", "am", "uz", "nl", "ro", "ne", "sd", "ps",
    "om", "ku", "az", "el", "hu", "cs", "sv", "zu", "kk", "so", "km", "rw", "mg",
    "he", "si", "bg", "sr", "xh", "af", "ti", "wo", "ff", "ln", "sn", "tg", "ky",
    "da", "fi", "sk", "no", "hr", "ca", "nso", "st", "tn", "hy", "ka", "mn", "lo",
    "ht", "sq", "bs", "lt", "ts", "sl", "mk", "lv", "gl", "et", "eu", "ve", "cy",
    "ga", "is",
)

NAMES: dict[str, str] = {
    "zh": "Chinese (Mandarin)", "hi": "Hindi", "es": "Spanish", "fr": "French",
    "ar": "Arabic", "bn": "Bengali", "pt": "Portuguese", "ru": "Russian", "ur": "Urdu",
    "id": "Indonesian", "de": "German", "ja": "Japanese", "sw": "Swahili", "mr": "Marathi",
    "te": "Telugu", "tr": "Turkish", "ta": "Tamil", "vi": "Vietnamese", "ko": "Korean",
    "fa": "Persian", "it": "Italian", "gu": "Gujarati", "th": "Thai", "pa": "Punjabi",
    "kn": "Kannada", "fil": "Filipino", "pl": "Polish", "ml": "Malayalam", "ms": "Malay",
    "or": "Odia", "my": "Burmese", "uk": "Ukrainian", "am": "Amharic", "uz": "Uzbek",
    "nl": "Dutch", "ro": "Romanian", "ne": "Nepali", "sd": "Sindhi", "ps": "Pashto",
    "om": "Oromo", "ku": "Kurdish", "az": "Azerbaijani", "el": "Greek", "hu": "Hungarian",
    "cs": "Czech", "sv": "Swedish", "zu": "Zulu", "kk": "Kazakh", "so": "Somali",
    "km": "Khmer", "rw": "Kinyarwanda", "mg": "Malagasy", "he": "Hebrew", "si": "Sinhala",
    "bg": "Bulgarian", "sr": "Serbian", "xh": "Xhosa", "af": "Afrikaans", "ti": "Tigrinya",
    "wo": "Wolof", "ff": "Fula", "ln": "Lingala", "sn": "Shona", "tg": "Tajik",
    "ky": "Kyrgyz", "da": "Danish", "fi": "Finnish", "sk": "Slovak", "no": "Norwegian",
    "hr": "Croatian", "ca": "Catalan", "nso": "Northern Sotho", "st": "Southern Sotho",
    "tn": "Tswana", "hy": "Armenian", "ka": "Georgian", "mn": "Mongolian", "lo": "Lao",
    "ht": "Haitian Creole", "sq": "Albanian", "bs": "Bosnian", "lt": "Lithuanian",
    "ts": "Tsonga", "sl": "Slovenian", "mk": "Macedonian", "lv": "Latvian",
    "gl": "Galician", "et": "Estonian", "eu": "Basque", "ve": "Venda", "cy": "Welsh",
    "ga": "Irish", "is": "Icelandic",
    "en": "English", "ha": "Hausa", "yo": "Yoruba", "ig": "Igbo", "pcm": "Nigerian Pidgin",
}

# ISO 15924 from the language catalogue (packages/language-catalogue).
SCRIPT: dict[str, str] = {
    "en": "Latn", "zh": "Hans", "hi": "Deva", "es": "Latn", "fr": "Latn", "ar": "Arab",
    "bn": "Beng", "pt": "Latn", "ru": "Cyrl", "ur": "Arab", "id": "Latn", "de": "Latn",
    "ja": "Jpan", "sw": "Latn", "mr": "Deva", "te": "Telu", "tr": "Latn", "ta": "Taml",
    "vi": "Latn", "ko": "Kore", "fa": "Arab", "it": "Latn", "ha": "Latn", "pcm": "Latn",
    "gu": "Gujr", "th": "Thai", "pa": "Guru", "kn": "Knda", "fil": "Latn", "pl": "Latn",
    "yo": "Latn", "ml": "Mlym", "ms": "Latn", "or": "Orya", "my": "Mymr", "uk": "Cyrl",
    "ig": "Latn", "am": "Ethi", "uz": "Latn", "nl": "Latn", "ro": "Latn", "ne": "Deva",
    "sd": "Arab", "ps": "Arab", "om": "Latn", "ku": "Latn", "az": "Latn", "el": "Grek",
    "hu": "Latn", "cs": "Latn", "sv": "Latn", "zu": "Latn", "kk": "Cyrl", "so": "Latn",
    "km": "Khmr", "rw": "Latn", "mg": "Latn", "he": "Hebr", "si": "Sinh", "bg": "Cyrl",
    "sr": "Cyrl", "xh": "Latn", "af": "Latn", "ti": "Ethi", "wo": "Latn", "ff": "Latn",
    "ln": "Latn", "sn": "Latn", "tg": "Cyrl", "ky": "Cyrl", "da": "Latn", "fi": "Latn",
    "sk": "Latn", "no": "Latn", "hr": "Latn", "ca": "Latn", "nso": "Latn", "st": "Latn",
    "tn": "Latn", "hy": "Armn", "ka": "Geor", "mn": "Cyrl", "lo": "Laoo", "ht": "Latn",
    "sq": "Latn", "bs": "Latn", "lt": "Latn", "ts": "Latn", "sl": "Latn", "mk": "Cyrl",
    "lv": "Latn", "gl": "Latn", "et": "Latn", "eu": "Latn", "ve": "Latn", "cy": "Latn",
    "ga": "Latn", "is": "Latn",
}

# FORWARD, en->X. The only direction this wave reviews: the reverse rows are
# round-trip reconstructions, and build_review_packet.py --forward-only keeps
# them away from reviewers for exactly that reason.
FORWARD: dict[str, Route | None] = {
    # dedicated pairs (both directions exist on the Hub)
    **{c: _opus(f"opus-mt-en-{c}") for c in (
        "hi", "es", "fr", "ar", "ru", "ur", "id", "de", "mr", "vi", "it", "ml", "uk",
        "nl", "om", "az", "hu", "cs", "sv", "rw", "mg", "bg", "xh", "af", "ti", "ln",
        "sn", "da", "fi", "sk", "ca", "nso", "st", "tn", "hy", "ht", "sq", "ts", "mk",
        "gl", "et", "eu", "cy", "ga", "is", "sw", "ro", "el", "he",
    )},
    # dedicated, with a target token the model documents
    "zh": _opus("opus-mt-en-zh", ">>cmn_Hans<< "),
    "ja": _opus("opus-mt-en-jap"),
    # tc-big pairs where no plain pair exists
    "pt": _opus("opus-mt-tc-big-en-pt", by="tc-big"),
    "tr": _opus("opus-mt-tc-big-en-tr", by="tc-big"),
    # NOT opus-mt-tc-big-en-ko. It loads, it answers, and every answer is word
    # salad -- "프로세스、 인기560、 25% 이스케이프。" for "the price is two
    # thousand naira per bag" -- with 13 of 34 outputs not even in Hangul.
    # Measured 10 Oct 2026; the other four tc-big models (pt, tr, lt, lv) are
    # fine. M2M100 renders the same sentence as 가격은 가방 당 2천 나이라입니다,
    # at ~2.8 s instead of 0.37 s, which is the price of being right.
    "ko": _m2m("ko"),
    "lt": _opus("opus-mt-tc-big-en-lt", by="tc-big"),
    "lv": _opus("opus-mt-tc-big-en-lv", by="tc-big"),
    # language-group models, token read from vocab.json
    "bn": _grp("opus-mt-en-inc", "ben"), "gu": _grp("opus-mt-en-inc", "guj"),
    "pa": _grp("opus-mt-en-inc", "pan_Guru"), "or": _grp("opus-mt-en-inc", "ori"),
    "sd": _grp("opus-mt-en-inc", "snd_Arab"), "si": _grp("opus-mt-en-inc", "sin"),
    "te": _grp("opus-mt-en-dra", "tel"), "ta": _grp("opus-mt-en-dra", "tam"),
    "kn": _grp("opus-mt-en-dra", "kan"),
    "pl": _grp("opus-mt-en-sla", "pol"), "sr": _grp("opus-mt-en-sla", "srp_Cyrl"),
    "hr": _grp("opus-mt-en-sla", "hrv"), "bs": _grp("opus-mt-en-sla", "bos_Latn"),
    "sl": _grp("opus-mt-en-sla", "slv"),
    "no": _grp("opus-mt-en-gmq", "nob"),
    "am": _grp("opus-mt-en-sem", "amh"),
    "zu": _grp("opus-mt-en-bnt", "zul"),
    "uz": _grp("opus-mt-en-trk", "uzb_Latn"), "kk": _grp("opus-mt-en-trk", "kaz_Cyrl"),
    "ky": _grp("opus-mt-en-trk", "kir_Cyrl"),
    "th": _grp("opus-mt-en-mul", "tha"), "fa": _grp("opus-mt-en-mul", "pes"),
    "ka": _grp("opus-mt-en-mul", "kat"), "ms": _grp("opus-mt-en-mul", "zlm_Latn"),
    "my": _grp("opus-mt-en-mul", "mya"), "ps": _grp("opus-mt-en-mul", "pus"),
    "ku": _grp("opus-mt-en-mul", "kur_Latn"), "so": _grp("opus-mt-en-mul", "som"),
    "km": _grp("opus-mt-en-mul", "khm"), "wo": _grp("opus-mt-en-mul", "wol"),
    "tg": _grp("opus-mt-en-mul", "tgk_Cyrl"), "mn": _grp("opus-mt-en-mul", "mon"),
    "lo": _grp("opus-mt-en-mul", "lao"),
    # no OPUS model of any kind: M2M100 (MIT, already on the box)
    "fil": _m2m("tl"), "ne": _m2m("ne"), "ff": _m2m("ff"),
    # nothing serves it
    "ve": None,
}

assert set(FORWARD) == set(INTERNATIONAL), (
    sorted(set(INTERNATIONAL) - set(FORWARD)), sorted(set(FORWARD) - set(INTERNATIONAL)))


def models_needed(languages: list[str]) -> list[str]:
    """Every Hub repo the given languages need, deduplicated, in first-use order."""
    seen: list[str] = []
    for lang in languages:
        r = FORWARD.get(lang)
        if r is None:
            continue
        repo = M2M100 if r.engine == "m2m100" else r.model
        if repo not in seen:
            seen.append(repo)
    return seen


if __name__ == "__main__":
    by: dict[str, list[str]] = {}
    for lang in INTERNATIONAL:
        r = FORWARD[lang]
        by.setdefault(r.resolved_by if r else "unsupported", []).append(lang)
    for k, v in by.items():
        print(f"{k:12s} {len(v):3d}  {' '.join(v)}")
    print(f"models to fetch: {len(models_needed(list(INTERNATIONAL)))}")
