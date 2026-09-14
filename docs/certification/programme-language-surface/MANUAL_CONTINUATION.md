# Manual continuation

This is the stop point for the automated framework work. No production configuration, deployment, merge, route approval or hosted qualification has been performed.

## What Zoe can complete manually

1. Run the evidence command plan and store resulting JSON under an evidence ticket or a dated qualification folder.
2. Arrange human review for every current direction:

   - en->fr
   - fr->en
   - en->es
   - es->en
   - en->pt
   - pt->en
   - en->ha
   - ha->en
   - en->ig
   - ig->en
   - en->yo
   - yo->en
   - en->pcm
   - pcm->en

3. Complete licence/commercial clearance for every third-party model named by the registry. Apache-2.0 identifiers are not enough; obligations and redistribution requirements must be reviewed.
4. Verify Google Cloud STT V2 / Chirp repo/server wiring and non-secret configuration names before any ha-NG, ig-NG or yo-NG live benchmark.
5. Add or approve missing fixture corpora before claiming STT accuracy for fr, pt, ha, ig, yo and pcm.
6. Keep pcm separate and unresolved unless repo evidence proves a specific STT candidate.
7. Add Portuguese TTS evidence before any route targeting pt can be considered live-ready.
8. Extend the deterministic end-to-end verifier before using it for pt, ha, ig, yo or pcm directions.
9. After evidence is gathered, update the registry only through a reviewed route-document change. Do not approve scopes by editing generated framework docs.

## Google STT manual verification before live benchmarks

Google Translation and Google STT are separate provider surfaces. The existing Google translation integration does not prove STT wiring. Before any live STT run for Hausa, Igbo or Yoruba, verify all of the following:

- A Google Cloud Speech-to-Text V2 / Chirp adapter or selector is present in the media-ingest runtime.
- Non-secret configuration names exist for the resource project, location and recognizer/model selection.
- ADC/quota-project handling is explicitly compatible with the existing Google authorization path.
- The configured candidate locales are exactly `ha-NG`, `ig-NG` and `yo-NG` for this gate.
- No result is written as production approval; live accuracy remains unqualified until a benchmark and human review are complete.

## Exact first manual command

```bash
node scripts/qualification/programme-language-surface.mjs --check-google-stt-wiring
```

That command prints the reusable collection commands without running provider benchmarks. Read the printed plan, then run the relevant evidence command on the qualification host.
