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
4. Add or approve missing fixture corpora before claiming STT accuracy for fr, pt, ha, ig and pcm.
5. Add Portuguese TTS evidence before any route targeting pt can be considered live-ready.
6. Extend the deterministic end-to-end verifier before using it for pt, ha, ig, yo or pcm directions.
7. After evidence is gathered, update the registry only through a reviewed route-document change. Do not approve scopes by editing generated framework docs.

## Exact first manual command

```bash
node scripts/qualification/programme-language-surface.mjs --print-evidence-commands
```

That command prints the reusable collection commands without running provider benchmarks. Read the printed plan, then run the relevant evidence command on the qualification host.
