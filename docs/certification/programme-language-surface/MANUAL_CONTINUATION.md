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
4. Verify Google Cloud STT V2 / Chirp 3 server configuration and non-secret configuration names before any ha-NG or yo-NG live benchmark; keep ig-NG blocked pending a qualified real-time recognizer.
5. Add or approve missing spoken fixture corpora before claiming STT accuracy for fr, pt, ha or yo. Do not claim ig or pcm STT accuracy until a qualified real-time recognizer exists.
6. Keep ig and pcm separate and unresolved for live STT unless repo evidence proves a specific qualified real-time recognizer.
7. Add Portuguese TTS evidence before any route targeting pt can be considered live-ready.
8. Extend the deterministic end-to-end verifier before using it for pt, ha, ig, yo or pcm directions.
9. After evidence is gathered, update the registry only through a reviewed route-document change. Do not approve scopes by editing generated framework docs.

## Google STT Chirp 3 manual verification before live benchmarks

Google Translation and Google STT are separate provider surfaces. The existing Google translation integration does not prove STT readiness. Before any live Google STT run for Hausa or Yoruba, verify all of the following. Igbo is not part of this Google live lane and remains fail-closed:

- The isolated qualification runtime is at the exact candidate SHA containing the Google Cloud Speech-to-Text V2 / Chirp 3 adapter and `deepgram-google-stt` language-routed selector. Production may remain on an older release until deployment is explicitly authorized.
- Non-secret configuration names exist for the resource project, location and recognizer/model selection.
- ADC/quota-project handling is explicitly compatible with the existing Google authorization path.
- The configured route table sends `ha-NG` and `yo-NG` to Google STT Chirp 3, keeps `en`, `es`, `fr` and `pt` on Deepgram, and refuses live STT for `ig` and `pcm`.
- Igbo remains in the 14-direction product/translation scope; only its live STT source lane is blocked pending a qualified recognizer.
- No result is written as production approval; live accuracy remains unqualified until a benchmark and human review are complete.

## Exact first manual command

```bash
ssh c7-claude 'echo ===PRODUCTION_SHA===; cd /srv/videofy-prod/current && git rev-parse HEAD; echo ===QUALIFICATION_SHA===; cd /home/claude/videofy-qualification-language-surface && git rev-parse HEAD && node scripts/qualification/programme-language-surface.mjs --check-google-stt-wiring; echo ===CONFIG_NAMES===; sudo awk -F= '"'"'/^(STREAMING_TRANSCRIPTION_PROVIDER|DEEPGRAM_API_KEY|DEEPGRAM_MODEL|GOOGLE_STT_PROJECT_ID|GOOGLE_STT_LOCATION|GOOGLE_STT_RECOGNIZER|GOOGLE_STT_MODEL|GOOGLE_CLOUD_QUOTA_PROJECT)=/ {print $1"=<set>"}'"'"' /etc/videofy/media-ingest.env'
```

That command is read-only: it prints the production SHA separately from the isolated qualification SHA, runs the repo-side wiring check only in the qualification checkout, and prints only whether the non-secret Google STT configuration names are set. It does not print credentials, change production, or run a live benchmark.
