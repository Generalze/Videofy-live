# Google Nigerian Translation Setup

Owner: masterzee001.

Google Cloud Translation is an MT provider only. It does not replace STT, TTS,
Deepgram, ElevenLabs, Azure or 9jaLingo.

The default remains:

```env
NIGERIAN_TRANSLATION_PRIMARY=opus-mt
TRANSLATION_PROVIDER=opus-mt
```

To screen Google for Nigerian MT:

```env
NIGERIAN_TRANSLATION_PRIMARY=google-cloud
TRANSLATION_PROVIDER=opus-mt
GOOGLE_TRANSLATE_PROJECT_ID=project-e11a8346-7d3c-49c6-8a8
GOOGLE_TRANSLATE_CREDENTIALS_FILE=/etc/videofy/google-translation.json
GOOGLE_TRANSLATE_LOCATION=global
GOOGLE_TRANSLATE_TIMEOUT_MS=10000
```

`TRANSLATION_PROVIDER=opus-mt` is required with the Google selector because OPUS
is the fallback. In production the only accepted Google key-file path is:

```text
/etc/videofy/google-translation.json
```

The JSON key must stay outside the repository, outside images, and out of logs.
`GOOGLE_APPLICATION_CREDENTIALS` can still provide ADC, but production Google
Nigerian MT resolves to the same path above.

## Screening

Build media-ingest first:

```powershell
npm run build -w packages/translation-routes
npm run build -w services/media-ingest
```

Run the two engines against the same corpus:

```powershell
node scripts/nigerian-translation-screen.mjs --engine google --out google-nigerian.json
node scripts/nigerian-translation-screen.mjs --engine opus --out opus-nigerian.json
node scripts/nigerian-translation-screen.mjs --compare google-nigerian.json opus-nigerian.json
```

Google may become primary only for `en<->yo`, `en<->ig` and `en<->ha`, and only
where the comparison shows lower p95 than OPUS-MT for that exact direction and
the route document is separately promoted with human review, licence and scope
approval. No benchmark output in this repo promotes a route by itself.

## Runtime Behavior

- Route registry approval still decides whether messages, programmes or calls
  may translate.
- The gate passes the approved provider id into media-ingest.
- If the route approves Google for a Nigerian English pair, media-ingest tries
  Google first and falls back once to OPUS-MT on timeout/error.
- If the route approves OPUS-MT, Google is not called.
- If both providers fail, the existing original-text fail-safe remains in force.

Official client references checked for this implementation:

- https://docs.cloud.google.com/translate/docs/reference/libraries/v3/overview-v3
- https://googleapis.dev/nodejs/translate/latest/module-@google-cloud_translate.html
- https://googleapis.dev/nodejs/translate/latest/v3.TranslationServiceClient.html
