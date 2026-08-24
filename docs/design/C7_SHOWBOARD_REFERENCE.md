# C7 Ecosystem Reference Showboard — build specification

The approved visual direction, transcribed from the owner's showboard artwork
(`CONSUMMATE 7 — Ecosystem Reference Showboard`, supplied 2026-08-24).

**Why this document exists.** The artwork arrived as chat attachments and is not
committed — it is not ours to redistribute, and binaries do not belong in this
tree. Without a transcription the reference is unavailable to anyone who was not
in that conversation, which is how "make it match the design" becomes an
argument about memory. Everything below is measurable against the running page.

Anything marked **CANONICAL** was explicitly shown in the artwork. Anything
marked *derived* is an implementation choice made to reproduce it and may be
changed freely, provided the canonical properties survive.

---

## 1. Global visual language

| Property | Value |
|---|---|
| Ground | near-black, `#05070c`–`#080b14`, with a faint blue-teal wash top-left |
| Accent ramp | violet `#b465ff` → indigo `#7c6bff` → blue `#7fc4ff` → white → cyan `#22d3ee` |
| Signature | luminous ring/orbit forms, heavy bloom, thin hairline geometry |
| Type | humanist sans; very large light headline, cyan sub-headline |
| Surfaces | dark cards, hairline borders, generous radius (~16–20px) |

**CANONICAL:** the accent ramp always runs violet → blue → cyan through a
white-hot crest. It is the brand's single strongest signal and appears on the
orbital rim, the C7 mark, primary buttons and progress bars.

---

## 2. Ecosystem homepage — header

**CANONICAL** navigation, left to right:

- Logo: circular C7 monogram (gradient ring, white numeral) + wordmark `CONSUMMATE 7`
- Links: `Ecosystem` · `Domains` · `About` · `News` · `Join`
- Right: `Join the Ecosystem` — pill, **outlined in cyan**, transparent fill

---

## 3. Ecosystem homepage — hero

### Copy (CANONICAL, verbatim)

- H1: `Building technology` / `for what comes next.` (two lines, light weight, white)
- Sub: `Seven domains. One ecosystem.` — cyan
- Body: `C7 unites intelligent systems across seven critical domains to solve
  real-world challenges and unlock new possibilities.`
- Primary CTA: `Explore the Ecosystem` — filled, blue→violet gradient pill
- Secondary: a **circular play button** (▶) beside it, outlined, no label

### The orbital (CANONICAL composition)

The hero's whole visual weight. Right-hand ~45% of the hero band.

- **Three** concentric orbit ellipses at *different rotations*, crossing each
  other to read as a three-dimensional cage rather than flat rings. Hairline
  strokes, low opacity, cool blue.
- A **bright central lens**: a horizontal ellipse with an intense
  violet→white→cyan rim and heavy volumetric bloom. This is the brightest
  object on the page.
- The **C7 monogram** at the centre of the lens, large, gradient-filled.
- **Six satellite nodes**, each a circular badge: dark fill, coloured hairline
  ring, glyph inside, soft outer glow. They sit on/near the rings, NOT evenly
  spaced — the composition is deliberately irregular.

Node inventory (CANONICAL — position by clock face, icon, tone):

| Clock | Glyph | Tone |
|---|---|---|
| 12:00 | single person | blue `#7fd4ff` |
| 10:00 | two people (group) | blue `#9bb8ff` |
| 2:00 | shield with heart | teal `#6ee7d0` |
| 4:00 | heart | pink `#ff9db4` |
| 8:00 | bar chart | white-blue `#e6ecff` |
| 6:00 | camera | blue `#8fb6ff` |

> The nodes are **decorative**. They carry no labels, are hidden from assistive
> technology, and are NOT derived from the domain list. Six shapes are texture
> saying "a connected system" — the public domain disclosure is the card grid
> below, in text. Do not wire these to data.

---

## 4. Ecosystem homepage — domain cards

**CANONICAL:** five cards in one row, each with a distinct illustrative
background, a numbered category label, and a status treatment. Closing line
beneath the row: `More domains coming. Infinite possibilities.`

| # | Category | Product | Art | Status |
|---|---|---|---|---|
| 1 | COMMUNICATION & CONNECTION | **VIDEOFY** | world map, glowing nodes | `Available now` — cyan check badge |
| 2 | PROTECTION & SECURITY | **SENTINEL-A** | shield over circuitry | `COMING SOON` + progress bar **56%** |
| 3 | HEALTH, SAFETY & ENVIRONMENT | — | luminous plant / leaf | `20% • Early development` + bar **20%** |
| 4 | FINANCE & MARKETS | — | candlestick chart | `LOCKED` — padlock badge |
| 5 | MEDIA & ENTERTAINMENT | — | stage / concert lights | `Emerging` — star badge |

Card 2 carries body copy: *"Intelligence for protection, awareness and
coordinated response. A next-generation security platform being developed
within the Consummate 7 ecosystem."*

> Sentinel's internal detail is NOT public. The card says only what the artwork
> shows.

**Art is drawn, not photographed.** Every background is SVG/CSS built in-repo:
no external image hosts, no licensing question, sharp on any display, and it
survives an offline deploy. *(derived)*

---

## 5. Videofy family homepage (`/videofy/`)

- Wordmark `VIDEOFY`, nav: Products · Solutions · Creators · Resources · About,
  CTA `Explore Videofy` (violet filled pill)
- Hero: `VIDEOFY` huge, sub `Communication. Creation. Entertainment. Reach.`,
  lede `One connected media and communication ecosystem.`
- Background: deep violet with flowing wave contours
- **Five product tiles**, each icon + name + status pill + one-line description:

| Product | Status | Description |
|---|---|---|
| VIDEOFY-LIVE | `Available now` | Real-time multilingual communication |
| VIDEOFY STUDIO | `Coming soon` | AI-assisted video creation and editing |
| VIDEOFY WATCH | `Coming soon` | Creator content viewing and discovery |
| VIDEOFY PROMOTE | `Coming soon` | Audience growth and promotion |
| VID AI | `In development` | The intelligence layer powering Videofy |

- Footer CTA: `Explore Videofy →` full-width gradient bar

---

## 6. Videofy Live homepage (`/videofy/live/`)

- Title `VIDEOFY-LIVE`, headline `Speak naturally, Understand globally.`
- Lede: `Real-time multilingual voice communication and interpretation for
  conversations, conferences and live programmes.`
- CTAs: `Start a Live Conversation` (filled) + `Watch a Demo` (play, outlined)
- Four stat chips: `100+ Languages` · `Low Latency / Real-time` ·
  `Global Reach / Any device` · `Secure / End-to-end`
- Background: glowing globe with network arcs

### Feature panels (CANONICAL)

- **A. PERSONAL CALLS** — *Talk naturally while Videofy progressively interprets
  the conversation into each participant's selected language.* Two-person call
  mock, `Speaking: English` / `Listening: Spanish`, waveform between, call
  controls bar.
- **B. CONFERENCE** — *One speaker. Multiple listeners. Each in their chosen
  language.* Speaker tile plus per-listener language tags (Spanish, French,
  Portuguese).
- **C. LIVE PROGRAMME** — *Live source, interpreted into multiple languages your
  audience can choose.* Programme still + audio-mode radio list (Original,
  Interpretation, Replacement, Captions ON) + language row incl. **Yoruba**.
- **E. CONNECTED COMMUNICATION / UNIVERSALITY VISION** — three columns:
  - `Working today`: browser calling, programme viewer, operator control,
    multilingual interpretation, SIP/RTP infrastructure
  - `In development`: native mobile
  - `Network expansion`: GSM/PSTN carrier reach, device integration, potential
    OEM/OS integration

> These panels describe capability honestly, including what is NOT built.
> `In development` and `Network expansion` must never be presented as working.

---

## 7. Information architecture (CANONICAL)

```
/                 C7 ecosystem homepage
└── /videofy/     Videofy family homepage
    └── /videofy/live/     Videofy Live product homepage
        ├── /call/         Call application
        ├── /listen/       Programme viewer
        └── /operator/     Programme operator
```

---

## Build order

1. Hero orbital + header + hero copy  ← the page's whole first impression
2. Domain card grid
3. Videofy family page
4. Videofy Live page and its feature panels

Each stage should be screenshotted at 1440 and 390 wide and compared against
this document before moving to the next.
