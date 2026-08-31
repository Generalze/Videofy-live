# OPUS-MT staged model inventory

What is on the staging box, where it came from, what licence it carries, and
what it is emphatically NOT.

Recorded 2026-08-30 against staging, `c7-eu-01`, cache `/var/lib/videofy/models`,
Python runtime `/opt/videofy-ai/bin/python`.

## Staging a model is not approving a route

Nothing in this file approves anything. It records artefacts on a disk.

Whether production may invoke a language pair is decided by the translation
route registry, which holds **one record per direction**. `en->yo` and `yo->en`
are separate records with separate evidence. The same model may be approved for
messaging and refused for a live call. There is no global OPUS switch, and a
model appearing below means only that the box has it.

Two things in particular are not evidence:

- **A successful download is not a working route.** Every model below downloaded
  and loads. Section "Artefact integrity" shows several of them producing
  confidently wrong English while doing so.
- **A forward pair says nothing about its reverse.** `en->ha` has been in
  service; that is not evidence for `ha->en`, which is a different model, a
  different training corpus and a different direction.

## What changed in this pass

Before: the cache held eight models, all of them `en->X` except `es-en` and
`fr-en`. Hausa, Igbo and Yoruba could be translated INTO but not OUT OF.

Staged in this pass, without enabling any route:

| model | why |
| --- | --- |
| `opus-mt-ha-en` | Hausa into English. Direct single-pair model, exists upstream. |
| `opus-mt-ig-en` | Igbo into English. Direct single-pair model, exists upstream. |
| `opus-mt-yo-en` | Yoruba into English. Direct single-pair model, exists upstream. |
| `opus-mt-ROMANCE-en` | Portuguese into English, and every other Romance source. |

Note the asymmetry that survives: Yoruba OUT of English still has no direct
model and goes through the `en-alv` group model with a `>>yor<<` token, but
Yoruba INTO English is now a direct model needing no token at all. The two
directions do not share a model, a corpus, or a quality profile.

## Upstream availability, checked this pass

Checked by HTTP status on `https://huggingface.co/api/models/Helsinki-NLP/<id>`
on 2026-08-30.

| model id | status | note |
| --- | --- | --- |
| `opus-mt-ha-en` | 200 | staged |
| `opus-mt-ig-en` | 200 | staged |
| `opus-mt-yo-en` | 200 | staged |
| `opus-mt-ROMANCE-en` | 200 | staged |
| `opus-mt-alv-en` | 200 | not staged; not needed, the three direct models exist |
| `opus-mt-mul-en` | 200 | not staged |
| `opus-mt-bnt-en` | 200 | not staged |
| `opus-mt-itc-en` | 200 | not staged; `ROMANCE-en` covers the same need |
| `opus-mt-pt-en` | **401** | absent or gated. Not available. |
| `opus-mt-en-pt` | **401** | absent or gated. Not available. |

### The Portuguese reverse route

`pt->en` was to be verified through a Romance group model rather than
substituted for. The verification:

- `opus-mt-ROMANCE-en` **exists** upstream (HTTP 200).
- Its model card lists Portuguese explicitly among its source languages:
  `... es_VE,pt,pt_br,pt_BR,pt_PT,gl,lad ...` with `target languages: en`.
- Its tokenizer carries **zero** `>>lang<<` tokens, confirmed by loading the
  staged copy and enumerating the vocabulary. This is the expected shape for a
  many-to-one model: the source language is inferred from the text and no
  routing token is required or accepted.

So `pt->en` is **supportable** by a real Portuguese-capable model, not a
substitute. It is not approved; see "Artefact integrity" for raw output and
note that no reviewer has looked at it.

For completeness in the other direction, `en->pt` is likewise served by the
already-staged `opus-mt-en-ROMANCE`, whose tokenizer does contain a `>>pt<<`
token (verified on the staged copy, 47 language tokens present). That direction
was not part of this pass and carries no evidence here.

## Inventory

All twelve entries were loaded on the box with `local_files_only=True` and
`HF_HUB_OFFLINE=1`, through the same call the worker makes
(`MarianTokenizer`/`MarianMTModel.from_pretrained(id, cache_dir=...)`, see
`services/media-ingest/src/translation-provider.ts`). All twelve loaded; zero
broken.

Local path is `/var/lib/videofy/models/models--Helsinki-NLP--<name>`, owner
`videofy:videofy`. Revision is the commit the local snapshot pins, read from
`refs/main` in the cache. Checksum is SHA-256 of the weights file the snapshot
resolves to.

### Reverse routes staged in this pass

| model | rev | src | tgt | licence | weights | sha256 |
| --- | --- | --- | --- | --- | --- | --- |
| `opus-mt-ha-en` | `71a171f838d1d6b618a55a31f8ed5c33ecbc47bc` | ha | en | apache-2.0 | `pytorch_model.bin` 297903585 B | `37b8f46afe47156fd11541a0cf4fe165c07f7eab96079fe124d826fefba4697d` |
| `opus-mt-ig-en` | `88be2fe2e1230a5679ce11e8d409619f5362fa49` | ig | en | apache-2.0 | `pytorch_model.bin` 293877561 B | `f8d45d7ab82d7eeb4c98f038ddec12e3a337e8cd200b221050eb3761c6513118` |
| `opus-mt-yo-en` | `f3d791bfa5ccd8d0ff7171f177f3e55c5bb3971c` | yo | en | apache-2.0 | `pytorch_model.bin` 295332429 B | `40ef20144550eec583ac964c14ad1def638e5766837f4c69d9e7c38a24738ec3` |
| `opus-mt-ROMANCE-en` | `e9ca9975e3972afd80732f08ce01d3a1339f47f8` | fr, es, **pt**, it, ro, ca, gl, la, +40 more | en | apache-2.0 | `pytorch_model.bin` 312087009 B | `9d77bbbd43a214959e027ffc8713fbe31f8609d14827fba645f1361ca20a6f3a` |

### Already staged before this pass

| model | rev | src | tgt | licence | weights | sha256 |
| --- | --- | --- | --- | --- | --- | --- |
| `opus-mt-en-fr` | `dd7f6540a7a48a7f4db59e5c0b9c42c8eea67f18` | en | fr | apache-2.0 | `pytorch_model.bin` 300827685 B | `cc1de10b49342ad2f33e06bc4474ddd6eaca278474903c4a8636ce15680d64de` |
| `opus-mt-fr-en` | `c4aed37b318c763fd177aa449b44e3b783cc6c02` | fr | en | apache-2.0 | `model.safetensors` 300803608 B | `6e3837f34b903802c3d0d670362b997cee6e87584a1108eb3fa89e4625e4424a` |
| `opus-mt-en-es` | `5bc4493d463cf000c1f0b50f8d56886a392ed4ab` | eng | spa | apache-2.0 | `pytorch_model.bin` 312087523 B | `befce0f620e8e63f83bbb7f0818eb51d541cba28057a7cc14b00466d85c4994c` |
| `opus-mt-es-en` | `c96e2c5399ebfae4fc43d9669556b9afa74bb69d` | spa | eng | apache-2.0 | `pytorch_model.bin` 312087523 B | `586a4e69e0804459ac7c176a5dc76852652100d9af1ee0db796de719899a5deb` |
| `opus-mt-en-ROMANCE` | `f8f3a28e8b6272d0ccc0290b832f699e154ae431` | en | fr, es, **pt**, it, ro, ca, gl, la, +40 more | apache-2.0 | `pytorch_model.bin` 312087009 B | `e64d119b5cb4d2baad0e54176c36f9a9cf3190bd2876484a2638dadcc8b1855a` |
| `opus-mt-en-ha` | `9736e603aa1c79372d62b3a9d96029d0b51f7466` | en | ha | apache-2.0 | `pytorch_model.bin` 297903585 B | `04e8fcd91fc33cb2511aa7fcddc3c079a2a4fc49a2ccbcb3b52471fe002b5de7` |
| `opus-mt-en-ig` | `0657b968cb9068ab59fe68e8b7dbc89eb21a2a20` | en | ig | apache-2.0 | `pytorch_model.bin` 293877561 B | `fdcfbdef1b1c06d7de802ddefbfec8b0e22c1ad8c2bd31b4c86dda7a300dccf7` |
| `opus-mt-en-alv` | `d4a06bd700113c56624f44d5b4287e54a29ebd6d` | eng | ewe, fuc, fuv, ibo, kin, lin, lug, nya, run, sag, sna, swh, toi_Latn, tso, umb, wol, **yor**, zul | apache-2.0 | `pytorch_model.bin` 305060961 B | `5c94b2423bdabcd2f81d1e757f53b95942ae446d66cc15f221ae6b6188da92d7` |

Total cache on disk: 7.4 GB (excludes `silero_vad.onnx`, the VAD model, which is
not a translation model and is checked by size in the install script).

Weight file sizes repeat across some rows (`en-ha` and `ha-en` are both
297903585 bytes, `en-ig` and `ig-en` both 293877561) because Marian models of
the same vocabulary shape have identical tensor layouts. The **checksums
differ**, which is what confirms they are genuinely different weights and not
one file downloaded twice.

### Licence evidence

Every model above is **Apache-2.0**, commercial use permitted.

Read in two independent places on 2026-08-30:

1. The model card front matter, fetched raw:
   `https://huggingface.co/Helsinki-NLP/opus-mt-<pair>/raw/main/README.md`,
   first line matching `^license:` -- returned `license: apache-2.0` for all
   twelve.
2. The hub metadata API,
   `https://huggingface.co/api/models/Helsinki-NLP/opus-mt-<pair>`, tag
   `license:apache-2.0` -- present for all twelve.

The README is **not** in the local snapshots for models fetched by
`from_pretrained` (it pulls only the files needed to load: config, weights,
`source.spm`, `target.spm`, `vocab.json`, tokenizer config). `en-alv`,
`en-ha` and `en-ig` do carry a local `README.md` because they were fetched
differently; those three read `license: apache-2.0` from the copy on disk as
well. So licence evidence is upstream evidence for most rows, by necessity, and
is dated rather than pinned to the local revision.

## Artefact integrity

Below is raw decoder output from the newly staged models, on the box, offline,
beam size 4. It is recorded so nobody has to take "the download succeeded" as
though it meant something.

**THIS IS NOT ROUTE EVIDENCE.** No sample count, no success rate, no latency, no
reviewer. It exists to show the artefacts are functional and to warn the
evidence lanes what they are about to measure.

Inputs were written **without diacritics** -- no Yoruba tone marks, no Igbo
dotted vowels -- which is itself a quality penalty on these models and a
realistic one, since text arriving from speech recognition is often undiacritised
too. Read the outputs with that caveat attached.

```
ha->en   IN : Ina son ka zo gida yau da yamma.
         OUT: I want you to come home today in the evening.
ha->en   IN : Sunana Zoe kuma ina zaune a Legas.
         OUT: My name comes, and I sit in I don't know what to say.

ig->en   IN : Achloro m ka i bia n'ulo taa.
         OUT: I was asked to live on a stage today.
ig->en   IN : Aha m bu Zoe, m bi na Legos.
         OUT: My name has been changed, and I live in Lessa.

yo->en   IN : Mo fe ki o wa si ile loni.
         OUT: I'm going to let you go.
yo->en   IN : Oruko mi ni Zoe, mo n gbe ni Eko.
         OUT: I lived in Eriko, and I lived on the island of Ekoko.

pt->en   IN : Bom dia, o meu nome e Zoe e moro em Lagos.
         OUT: Good morning, my name and Zoe and I live in Lagos.
pt->en   IN : Preciso de falar consigo sobre a reuniao de amanha.
         OUT: I need to talk to you about tomorrow's meeting.
```

What that shows, stated plainly and no further:

- The four artefacts load and generate. They are not corrupt.
- `pt->en` produced recognisable English on both inputs.
- `ha->en`, `ig->en` and `yo->en` each produced at least one output that is
  fluent English and **wrong** -- not garbled, not empty, not obviously broken.
  "Oruko mi ni Zoe, mo n gbe ni Eko" is "My name is Zoe, I live in Lagos"; the
  model returned "I lived in Eriko, and I lived on the island of Ekoko". A
  caller would have no signal that they had been mistranslated.

This is the failure mode already on record for general-purpose vendors on
Nigerian languages, now reproduced on the local models in the reverse direction.
An evidence lane measuring these must not score them on fluency, and a route
that can emit confident nonsense into a live call should not reach
`serviceScopes.call-live: approved` on technical evidence alone. That is a
ruling for whoever owns the registry, not for this lane.

## Traps found while staging

**`cache_dir` is not `HF_HOME`.** Fetching with only `HF_HOME=/var/lib/videofy/models`
put the four new models in `/var/lib/videofy/models/hub/models--*`, because
transformers resolves the hub cache to `$HF_HOME/hub`. The worker passes
`cache_dir=OPUS_MT_MODEL_CACHE_DIR` and uses that path verbatim, so it would
never have looked there. Every download reported `ok`. The models were moved to
the path the service reads and re-verified offline; the install script now ends
with a load check under `local_files_only=True` that would have caught it, since
the download report could not.

**A literal `\n` in the install script wrote a junk key.** The env-writing loop
ended a line with the two characters `\n` instead of a backslash-newline, which
put the bare word `n` into the loop and appended a line reading `n` to
`/etc/videofy/media-ingest.env`. It is still there on staging at the time of
writing. systemd ignores a line with no `=`, so nothing ever failed and nothing
ever warned. The script is fixed and now refuses any entry lacking an `=`; the
stray line in the live env file has been left alone, since restarting or
reconfiguring a running service is not this lane's to do.

**Root-owned model directories.** `en-alv`, `en-ha` and `en-ig` were owned by
`root` in the cache, along with their lock directories, from a hand-run fetch.
The service runs as `videofy`. Ownership across the whole cache has been
restored to `videofy:videofy`.

## The cache is shared with production

Staging and production run on the same box and read the **same model cache**:

```
/etc/videofy/media-ingest.env       OPUS_MT_MODEL_CACHE_DIR=/var/lib/videofy/models
/etc/videofy-prod/media-ingest.env  OPUS_MT_MODEL_CACHE_DIR=/var/lib/videofy/models
```

Both also set `HF_HOME=/var/lib/videofy/models`, `HF_HUB_OFFLINE=1` and
`OPUS_MT_ALLOW_MODEL_DOWNLOAD=false`.

So putting a model on disk "for staging" puts it within reach of the production
media-ingest process at the same moment. There is no filesystem boundary here.
The four models staged in this pass are physically loadable by production right
now.

What stops production serving them is the route registry and the language
configuration above it -- nothing else. That is a deliberate design (the
registry is meant to be the authority) but it is worth stating plainly, because
"it is only on staging" is not true of models and would be a false comfort if
anyone reasoned from it.

The stray `n` line described above exists in the staging env file only;
`/etc/videofy-prod/media-ingest.env` has none, since the install script has only
ever been run against staging.

## Rebuilding a box

`deploy/staging/install-translation-models.sh` now fetches all twelve. It
fetches, chowns to the service user, verifies every one loads offline through
the worker's own call, then writes the env keys. It does not consult, populate
or respect the route registry -- a rebuilt box has the models and still no
approved routes.
