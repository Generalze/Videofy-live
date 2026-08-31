# Translation quality: Yoruba, Hausa, Igbo

Measured 2026-08-31 on c7-eu-01 with `scripts/evaluate-opus-mt.py` and
`scripts/compare-translation-engines.py`, 24 sentences across six domains
(broadcast, conversation, business, health, agriculture, precision).

**Status: Hausa via OPUS-MT is NOT FIT FOR USE. Yoruba and Igbo are usable
with named restrictions. Nothing here is certified — `humanLanguageReview`
remains `required-not-done` for all three.**

## How this was measured, and what the number is worth

Round-trip chrF: English → target → English, scored against the original by
character n-gram F-score. Both directions use the same engine, so each is
judged by its own pair rather than borrowing the other's reverse model.

**A high score is weak evidence.** Round-trip conflates two models and can
reward two wrongs that agree. **A low score, and every defect, is strong
evidence.** One case below shows the metric failing outright, and it is
reported rather than hidden.

## Results

| language | engine | chrF | defects |
|---|---|---:|---:|
| Yoruba | OPUS-MT (`en-alv` + `>>yor<<`) | 59.7 | 0/24 |
| Yoruba | NLLB-200 distilled 600M | **65.9** | 0/24 |
| Hausa | OPUS-MT (`en-ha`) | **39.4** | 1/24 |
| Hausa | NLLB-200 distilled 600M | **70.7** | 0/24 |
| Igbo | OPUS-MT (`en-ig`) | 58.4 | 0/24 |
| Igbo | NLLB-200 distilled 600M | **66.0** | 0/24 |

By domain, OPUS-MT: **precision (numbers, dates, times) is the weakest band in
every language** — yo 40.2, ha 25.5, ig 44.3. Business is second weakest.
Health and conversation score highest. That ordering is the opposite of what a
business demo needs.

## The Hausa failure is categorical, not marginal

`Helsinki-NLP/opus-mt-en-ha` is trained predominantly on religious text and
has no general register to fall back on. Asked for ordinary business or
broadcast sentences it emits Qur'anic narrative, fluently, with HTTP 200:

| English asked for | Hausa produced | what it means |
|---|---|---|
| Good morning everyone, and welcome to this broadcast. | Sai ya wãyi gari a cikin birnin yanã mai tsõro, yanã sauna. | So he was in the city, fearful and vigilant. |
| Please send me the address before you leave. | Don me Ka wajabta yãƙi a kaina? | Why have You ordained fighting for me? |
| The price is two thousand naira per bag. | To, abin da yake misãlinsa, kamar falalen dũtse ne… | a parable about rain washing dust from a rock |
| My name is Zoe and I work in Lagos. | Sunana shi ne Abababa kuma ina aiki a yaren kurame. | My name is to give birth and to work in sign language. |

The tell is orthographic: `ã õ ĩ ũ` are characteristic of Hausa Qur'an
translations, not of standard Hausa. It is also where the "(Igbo)" string in
the 31 Aug programme came from — see [[batch-tts-empty-file]] for that session.

Yoruba shows the same contamination more mildly: *My name is Zoe and I work in
Lagos* round-trips as *My name was Ian, and I worked in Smyrna.*

Igbo's characteristic failure is word sense, not register: **fertiliser →
"ihe na-esi ísì ụtọ"** (a sweet-smelling thing).

## NLLB-200 closes the gap — and cannot be shipped

NLLB-200 fixes every case above. *My name is Zoe and I work in Lagos* →
`Sunana Zoe kuma ina aiki a Legas` (chrF 100). *Please transfer the payment to
the account I sent you* → correct in all three.

**BLOCKER: NLLB-200 is released under CC-BY-NC-4.0 — non-commercial use
only.** Videofy Live is a commercial product, so this model is a BENCHMARK
here, not a proposed engine. The repo already states this licence in
`translation-provider.ts`, and `TRANSLATION_FALLBACK_PROVIDER=nllb200` must
not be enabled on a commercial deployment without a licence review. Its value
is that it proves the quality gap is a model choice, not a ceiling.

## Where NLLB is worse, and one place the metric lied

Reported because a comparison that only lists wins is advocacy.

- *How are you doing this evening?* — NLLB renders "evening" as night
  (yo `òru`, ig `abalị`) where OPUS-MT correctly uses `alẹ́` / `mgbede`.
- *If the fever does not stop…* — NLLB drops the body word in Igbo, leaving
  `ọkụ` (fire) rather than `ahụ́ ọkụ` (fever). A real regression.
- **The metric failed on Hausa precision.** OPUS-MT scored 24.4 and NLLB 13.6
  on *The event starts at four thirty on the fifteenth of March*. But NLLB's
  output — `da karfe 4:30 na ranar 15 ga watan Maris` — is CORRECT, and
  OPUS-MT's dropped both the 30 and the 15th. NLLB scored lower for keeping
  digits the reverse model then rendered differently. This is exactly why a
  score is never the verdict.

## Standing restrictions until a speaker certifies

1. **Do not present Hausa translation.** Not a tuning problem.
2. **Do not present numbers, prices, dates or times** in any of the three.
   Precision is the weakest band everywhere; *two thousand naira per bag*
   round-tripped as *2,000 tons*.
3. Greetings, thanks, and simple health and conversational sentences are the
   strongest material in all three.
4. A translation being fluent is not evidence it is right — the same rule that
   governs the [[nigerian-language-specialist]] voice route governs the text.

## Reproducing

```
scp scripts/evaluate-opus-mt.py c7-claude:/tmp/evaluate_opus_mt.py
scp scripts/compare-translation-engines.py c7-claude:/tmp/
ssh c7-claude 'sudo -n env HF_HUB_CACHE=/var/lib/videofy/models \
  HF_HUB_OFFLINE=1 /opt/videofy-ai/bin/python /tmp/compare-translation-engines.py'
```
