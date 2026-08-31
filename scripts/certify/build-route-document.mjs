/** @author masterzee001 */
/**
 * RECONCILIATION: build the translation route document from the certification
 * wave's evidence.
 *
 * This script exists so the document is REPRODUCIBLE rather than hand-typed.
 * Fourteen directions, each carrying the measurement that was actually taken
 * and the reason it does not amount to approval. Running it rewrites
 * packages/translation-routes/routes/translation-routes.seed.json; the
 * package's own validation then refuses the result if any rule is broken, so a
 * mistake here fails the build rather than reaching production.
 *
 * NOTHING IN THIS FILE MAY SET productionApproved TRUE. That is asserted at the
 * bottom, because the one edit nobody should be able to make casually is the
 * one that turns a measurement into a permission.
 *
 *   node scripts/certify/build-route-document.mjs
 */
import { writeFileSync } from 'node:fs';

const OPUS_LICENCE = (model, rev) => ({
  licence: 'Apache-2.0',
  commercialUse: 'unknown',
  evidence:
    `Licence IDENTIFIER established twice, independently, on 2026-08-30, for ${model} ` +
    `pinned at revision ${rev}: (1) model-card front matter at ` +
    `https://huggingface.co/${model}/raw/main/README.md reading "license: apache-2.0"; ` +
    `(2) the hub metadata API tag "license:apache-2.0", read per model id rather than ` +
    `per family. COMMERCIAL USE REMAINS "unknown" DELIBERATELY. The Apache-2.0 text ` +
    `permits commercial use, but nobody in this repository has read its OBLIGATIONS -- ` +
    `carrying the licence text and NOTICE for twelve third-party models is a ` +
    `distribution question, not a benchmark question -- and services/ai-registry/src/` +
    `registry.ts still records commercialUseState "review-required" for these assets. ` +
    `The registry states what has been ESTABLISHED, not what is likely.`,
});

const ev = (sampleCount, successRate, [min, median, mean, max], notes) => ({
  sampleCount,
  successRate,
  latencyMs: { min, median, mean, max },
  recordedAt: '2026-08-30',
  notes,
});

const MEASURED =
  'docs/certification/opus-benchmarks.md. Eight short conversational turns (6-9 words, ' +
  'one clause), driven through the DEPLOYED provider at /srv/videofy/app/services/' +
  'media-ingest/dist against /opt/videofy-ai/bin/python, concurrency 1. Run twice one ' +
  'hour apart: every median within 1.3% and the identical pass/fail pattern, including ' +
  'WHICH sample failed. LATENCY IS AN UPPER BOUND: both runs sat at load 8.4-9.3 on 8 ' +
  'vCPU with an unrelated root process holding 99.9% of one core since 25 August. ' +
  'Success means five separate gates, not a non-empty string: no provider error, ' +
  'non-empty, not an echo of the input (token Jaccard below 0.6), identified as the ' +
  'TARGET language by a judge calibrated 56/56 in-sample and 14/14 out-of-sample with ' +
  'zero wrong labels, and an output length consistent with a translation.';

const MALFORMED =
  'DEFECTS PRESENT ON EVERY ROUTE, reproducible, and not routable-around: ' +
  'whitespace-only and emoji-only input HALLUCINATE confident invented sentences ' +
  '(en-to-fr returned a paragraph of EU regulation boilerplate; ha-to-en "The Bible"); ' +
  'DIGITS ARE CORRUPTED (en-to-es turned 08031234567 into 080314567, two digits ' +
  'deleted); and a 5000-character input either times out at 120 s -- stalling every ' +
  'queued chat line behind it at concurrency 1 -- or is silently truncated to its first ' +
  'sentence.';

const NIGERIAN_WRONG =
  'READING THE OUTPUT FOUND FLUENT ENGLISH THAT IS MATERIALLY WRONG. This route ' +
  'returns confident, well-formed English with no signal a caller can detect -- the ' +
  'same failure mode already on record for general vendors on Yoruba, Hausa and Igbo, ' +
  'reproduced here on local models in the reverse direction. It is fast and it always ' +
  'returns something, so a success-rate-and-latency harness scores it well. That is ' +
  'precisely the danger.';

const NOT_REACHABLE =
  'THE DEPLOYED SERVICE CANNOT INVOKE THIS DIRECTION. It is absent from ' +
  'DEFAULT_OPUS_MT_LANGUAGE_MODELS in services/media-ingest/src/config.ts, so findModel ' +
  'rejects it with unsupported-language (400) before any model loads. The weights are ' +
  'staged and complete under the configured cache root and the benchmark drove the ' +
  'provider directly with its own model list. "The model works at this latency" is ' +
  'established; "the service can serve this pair today" is NOT.';

const UNAPPROVED = {
  messaging: 'unapproved',
  'programme-live': 'unapproved',
  'call-live': 'unapproved',
};
const CALL_LIVE_REFUSED = {
  messaging: 'unapproved',
  'programme-live': 'unapproved',
  'call-live': 'refused',
};

const routes = [];

function opus(source, target, model, rev, evidence, scopes, extraLicenceNote) {
  const licence = OPUS_LICENCE(model, rev);
  routes.push({
    sourceLanguage: source,
    targetLanguage: target,
    provider: 'opus-mt',
    modelId: model,
    executionClass: 'local',
    productionApproved: false,
    technicalEvidence: evidence,
    // EVERY direction, Romance included. The benchmark lane proposed
    // 'not-required' for the six Romance directions and this reconciliation
    // declines: its own reading of fr-to-en found "On se voit demain matin."
    // returned as "I'll see you in the morning." -- the day is gone. A dropped
    // "tomorrow" in a chat message is the wrong day, not a matter of style, and
    // a language nobody has checked is not a language known to be fine.
    humanReviewStatus: 'required-not-done',
    licenceStatus: extraLicenceNote
      ? { ...licence, evidence: `${licence.evidence} ${extraLicenceNote}` }
      : licence,
    serviceScopes: scopes,
  });
}

// --- Romance: measured, unread by anyone, unapproved ------------------------
opus(
  'en',
  'fr',
  'Helsinki-NLP/opus-mt-en-fr',
  'dd7f6540a7a48a7f4db59e5c0b9c42c8eea67f18',
  ev(8, 1.0, [3176, 5647, 5444, 7025], `${MEASURED} ${MALFORMED}`),
  UNAPPROVED,
);

opus(
  'fr',
  'en',
  'Helsinki-NLP/opus-mt-fr-en',
  'c4aed37b318c763fd177aa449b44e3b783cc6c02',
  ev(
    8,
    1.0,
    [4210, 5621, 5414, 6476],
    `${MEASURED} MEANING LOSS OBSERVED: "On se voit demain matin." returned "I'll see ` +
      `you in the morning." -- "tomorrow" is gone. In a messaging product that is not a ` +
      `style difference, it is the wrong day, and it is why this direction is recorded ` +
      `as needing a reader rather than as needing nobody. ${MALFORMED}`,
  ),
  UNAPPROVED,
);

opus(
  'en',
  'es',
  'Helsinki-NLP/opus-mt-en-es',
  '5bc4493d463cf000c1f0b50f8d56886a392ed4ab',
  ev(8, 1.0, [4256, 5106, 5083, 5862], `${MEASURED} ${MALFORMED}`),
  UNAPPROVED,
);

opus(
  'es',
  'en',
  'Helsinki-NLP/opus-mt-es-en',
  'c96e2c5399ebfae4fc43d9669556b9afa74bb69d',
  ev(
    8,
    1.0,
    [4225, 5662, 5505, 7036],
    `${MEASURED} MEANING LOSS OBSERVED: "Llego en cinco minutos." returned "I'll be here ` +
      `in five minutes." -- arriving became already being there. ${MALFORMED}`,
  ),
  UNAPPROVED,
);

opus(
  'en',
  'pt',
  'Helsinki-NLP/opus-mt-en-ROMANCE',
  'f8f3a28e8b6272d0ccc0290b832f699e154ae431',
  ev(
    8,
    1.0,
    [3695, 4800, 5085, 7063],
    `${MEASURED} GROUP MODEL: one set of weights serves roughly 47 Romance targets, ` +
      `selected by a ">>pt<<" target token. The token was proved to STEER rather than ` +
      `coincide: the same model with ">>ro<<" returned Romanian ("Ce mai faci azi?"). Had ` +
      `they matched, a Portuguese route would have been an accident. ${MALFORMED}`,
  ),
  UNAPPROVED,
  'There is no Helsinki-NLP/opus-mt-en-pt: the hub answers 401 for it. This record is ' +
    'the group model, licensed as its own artefact.',
);

opus(
  'pt',
  'en',
  'Helsinki-NLP/opus-mt-ROMANCE-en',
  'e9ca9975e3972afd80732f08ce01d3a1339f47f8',
  ev(
    8,
    1.0,
    [4239, 5640, 5499, 6478],
    `${MEASURED} MANY-TO-ONE GROUP MODEL: its card lists pt, pt_BR and pt_PT among ` +
      `roughly 47 source languages and its tokenizer carries ZERO ">>lang<<" tokens -- ` +
      `the expected shape when the source is inferred from the text. So Portuguese here ` +
      `is a genuinely Portuguese-capable model, not a substitute standing in for the ` +
      `absent direct pair. ${MALFORMED} ${NOT_REACHABLE}`,
  ),
  UNAPPROVED,
  'There is no Helsinki-NLP/opus-mt-pt-en: the hub answers 401 for it.',
);

// --- Nigerian: measured, materially wrong, call-live REFUSED ----------------
opus(
  'en',
  'ha',
  'Helsinki-NLP/opus-mt-en-ha',
  '9736e603aa1c79372d62b3a9d96029d0b51f7466',
  ev(
    8,
    0.875,
    [4240, 5832, 6218, 9794],
    `${MEASURED} THE FAILING SAMPLE IS A RUNAWAY, NOT A REFUSAL: "See you tomorrow ` +
      `morning." (4 words) returned 72 words / 350 characters of unrelated devotional ` +
      `prose, in fluent Hausa, after 73.7 SECONDS -- an 18x expansion that passes ` +
      `non-empty, not-echo and correct-language perfectly, and that reproduced ` +
      `identically on the second run. It is a latency event as well as a correctness ` +
      `one: no output-length or generation-time bound exists to stop it. The latency ` +
      `profile above covers the seven passing samples; including the runaway the max is ` +
      `73700 ms. NOBODY WHO READS HAUSA HAS REVIEWED A SINGLE OUTPUT OF THIS ROUTE. ` +
      `${MALFORMED}`,
  ),
  CALL_LIVE_REFUSED,
);

opus(
  'ha',
  'en',
  'Helsinki-NLP/opus-mt-ha-en',
  '71a171f838d1d6b618a55a31f8ed5c33ecbc47bc',
  ev(
    8,
    1.0,
    [4255, 4820, 5507, 8128],
    `${MEASURED} ${NIGERIAN_WRONG} SPECIFICALLY: 3 of 8 outputs materially wrong in ` +
      `meaning, including "Sai gobe da safe." (see you tomorrow morning) returned as ` +
      `"The next morning." -- the farewell is simply gone. A separate ` +
      `artefact-integrity pass found "Sunana Zoe kuma ina zaune a Legas." (my name is ` +
      `Zoe and I live in Lagos) returned as "My name comes, and I sit in I do not know ` +
      `what to say." ${MALFORMED} ${NOT_REACHABLE}`,
  ),
  CALL_LIVE_REFUSED,
);

opus(
  'en',
  'ig',
  'Helsinki-NLP/opus-mt-en-ig',
  '0657b968cb9068ab59fe68e8b7dbc89eb21a2a20',
  ev(
    8,
    0.875,
    [4774, 6519, 6554, 9284],
    `${MEASURED} THE NON-PASSING SAMPLE IS AN ABSTENTION, NOT AN OBSERVED FAILURE: "How ` +
      `are you doing today?" returned "Olee otu i si eme taa?", which is Igbo written ` +
      `without sub-dot diacritics; the language judge scored it 1-1 against English on ` +
      `the bare pronoun "i" and declined to label it. It is recorded as undetermined ` +
      `rather than as a pass BECAUSE widening the judge after seeing the sample is how a ` +
      `judge gets tuned to a result. A human reader of Igbo would very likely score this ` +
      `route 8/8 -- and no human reader of Igbo has seen it. ${MALFORMED}`,
  ),
  CALL_LIVE_REFUSED,
);

opus(
  'ig',
  'en',
  'Helsinki-NLP/opus-mt-ig-en',
  '88be2fe2e1230a5679ce11e8d409619f5362fa49',
  ev(
    8,
    1.0,
    [4280, 5658, 6530, 10105],
    `${MEASURED} ${NIGERIAN_WRONG} SPECIFICALLY: 4 of 8 outputs materially wrong in ` +
      `meaning. THE ONE THAT DECIDES THIS RECORD: "Enwetala m ego ahu, daalu." -- I have ` +
      `received the money, thank you -- was returned as "I had found the money, and I ` +
      `lost it." A money confirmation delivered as a money loss, in fluent English, on a ` +
      `route that scored 8/8 on every automated gate. ${MALFORMED} ${NOT_REACHABLE}`,
  ),
  CALL_LIVE_REFUSED,
);

opus(
  'en',
  'yo',
  'Helsinki-NLP/opus-mt-en-alv',
  'd4a06bd700113c56624f44d5b4287e54a29ebd6d',
  ev(
    8,
    1.0,
    [4811, 9103, 9323, 13413],
    `${MEASURED} GROUP MODEL WITH A TARGET TOKEN, and the trap was checked rather than ` +
      `assumed. (1) The token the runtime actually selects is ">>yor<<" -- the worker ` +
      `probes its own vocabulary and the probe reproduces the candidate order yo, yor, ` +
      `yo_br exactly. (2) The token STEERS: the same model and sentence with ">>ewe<<" ` +
      `returns Ewe ("Aleke wole egbeae?") rather than the same Yoruba, so Yoruba is not ` +
      `arriving by coincidence. (3) All 8 outputs identified as Yoruba, none an echo, ` +
      `none a sibling language. THE SLOWEST ROUTE MEASURED: median 9.1 s, max 13.4 s for ` +
      `one short chat line. NOBODY WHO READS YORUBA HAS REVIEWED A SINGLE OUTPUT. ` +
      `${MALFORMED}`,
  ),
  CALL_LIVE_REFUSED,
);

opus(
  'yo',
  'en',
  'Helsinki-NLP/opus-mt-yo-en',
  'f3d791bfa5ccd8d0ff7171f177f3e55c5bb3971c',
  ev(
    8,
    1.0,
    [4254, 6393, 6777, 10671],
    `${MEASURED} ${NIGERIAN_WRONG} SPECIFICALLY: 4 of 8 outputs materially wrong in ` +
      `meaning, including "Mo ti gba owo naa, e se." (I have received the money, thank ` +
      `you) returned as "I have taken the money, you." and "A o ri ara wa ni aaro ola." ` +
      `(we will see each other tomorrow morning) returned as "We will see ourselves in ` +
      `the future." A separate artefact-integrity pass found "Oruko mi ni Zoe, mo n gbe ` +
      `ni Eko." (my name is Zoe, I live in Lagos) returned as "I lived in Eriko, and I ` +
      `lived on the island of Ekoko." ${MALFORMED} ${NOT_REACHABLE}`,
  ),
  CALL_LIVE_REFUSED,
);

// --- Nigerian Pidgin: a declared gap, both directions -----------------------
for (const [source, target] of [
  ['en', 'pcm'],
  ['pcm', 'en'],
]) {
  routes.push({
    sourceLanguage: source,
    targetLanguage: target,
    provider: 'unassigned',
    modelId: 'unassigned',
    executionClass: 'local',
    productionApproved: false,
    technicalEvidence: null,
    humanReviewStatus: 'required-not-done',
    licenceStatus: {
      licence: 'unassigned',
      commercialUse: 'unknown',
      evidence:
        'A DECLARED GAP, recorded separately for each direction because they are ' +
        'separate routes. NO MACHINE TRANSLATION MODEL IN THIS DEPLOYMENT COVERS ' +
        'NIGERIAN PIDGIN IN EITHER DIRECTION: OPUS-MT has no pcm pair, ' +
        'services/ai-registry/src/self-hosted-engines.ts records pcm as one of the two ' +
        'catalogue languages NLLB-200 does not cover, and pcm is absent from ' +
        'M2M100_MODEL_CARD_LANGUAGES in the same file. 9jaLingo SPEAKS pcm and its ' +
        'Pidgin voice is technically certified (10/10, zero silent clips, 2.57-4.06 s ' +
        'durations), but SPEECH IS NOT TRANSLATION and its translation capability is ' +
        'recorded as UNVERIFIED_TRANSLATION in ' +
        'services/ai-registry/src/commercial-providers.ts. So Pidgin has a certified ' +
        'VOICE and no way to reach it: the route is visible here as a gap rather than ' +
        'absent as an oversight, and somebody owes an explicit product decision that pcm ' +
        'stays deliberately untranslatable rather than looking half-finished. ' +
        'executionClass is a placeholder with no meaning until a provider is named, and ' +
        'validation refuses to approve an unassigned provider, so this gap can only be ' +
        'closed by naming a real model.',
    },
    serviceScopes: UNAPPROVED,
  });
}

const document = {
  version: 1,
  author: 'masterzee001',
  note:
    'RECONCILED 2026-08-31 from the provider-certification wave, by ' +
    'scripts/certify/build-route-document.mjs. FOURTEEN DIRECTIONS, NOT ONE APPROVED ' +
    'FOR ANY SCOPE. Twelve now carry measured technical evidence where the seed carried ' +
    'none; that evidence is what makes these refusals specific rather than merely ' +
    'cautious. NOTHING WAS PROMOTED TO productionApproved, for four INDEPENDENT reasons, ' +
    'so closing any one of them changes nothing on its own: (1) NO HUMAN HAS READ A ' +
    'SINGLE OUTPUT of any route, in any language; (2) three defects live on EVERY route ' +
    '-- blank and emoji-only input hallucinate confident invented sentences, digits are ' +
    'deleted or reformatted, and long input either times out for 120 s or is silently ' +
    'truncated to its first sentence; (3) 4.8-9.1 s median for one short chat line, and ' +
    'that on a loaded box, so the idle-box figure that would decide live use is ' +
    'unmeasured; (4) four directions (pt->en, ha->en, ig->en, yo->en) the deployed ' +
    'service cannot invoke at all. ' +
    'THE SIX NIGERIAN DIRECTIONS ARE call-live REFUSED, not merely unapproved. Refused ' +
    'is a decision, and this one is made: reading the X->en output found 3-4 materially ' +
    'wrong meanings in 8 for each of ha, ig and yo -- including a money confirmation ' +
    'returned as a money loss -- all in fluent, confident English with no signal a ' +
    'caller can detect, while en->ha produced an 18x runaway of unrelated prose. Those ' +
    'routes are fast and always return something, so a success-rate-and-latency harness ' +
    'scores them well; call-live puts the result in somebody’s ear in real time ' +
    'with nothing to check it against. No future green harness may promote that cell. ' +
    'Only a human reader of the language can move it. ' +
    'PROVIDER CORRECTED: the seed named m2m100 for the six Nigerian directions. Nothing ' +
    'measured m2m100 on them and the deployed service does not use it -- ' +
    'TRANSLATION_PROVIDER is opus-mt and DEFAULT_OPUS_MT_LANGUAGE_MODELS names a ' +
    'Helsinki-NLP model per pair. A registry naming a model that would never serve the ' +
    'route is the unwired-seam defect in registry form, so each record now names the ' +
    'model that would actually run. ' +
    'LICENCE: the Apache-2.0 IDENTIFIER is now established twice per model id, but ' +
    'commercialUse stays "unknown" because nobody has read the OBLIGATIONS and ' +
    'services/ai-registry/src/registry.ts still records commercialUseState ' +
    '"review-required". Under this document unknown blocks production approval, so that ' +
    'is load-bearing rather than cosmetic.',
  reviewRequiredLanguages: ['yo', 'ha', 'ig', 'pcm'],
  routes,
};

for (const route of document.routes) {
  if (route.productionApproved !== false) {
    throw new Error(
      `${route.sourceLanguage}->${route.targetLanguage} is productionApproved in a ` +
        'generator that is not allowed to approve anything. Approval is a human ' +
        'decision recorded against a named reviewer, never a side effect of a rebuild.',
    );
  }
  for (const approval of Object.values(route.serviceScopes)) {
    if (approval === 'approved') {
      throw new Error(
        `${route.sourceLanguage}->${route.targetLanguage} has an approved scope in a ` +
          'generator that is not allowed to approve anything.',
      );
    }
  }
}

writeFileSync(
  new URL('../../packages/translation-routes/routes/translation-routes.seed.json', import.meta.url),
  `${JSON.stringify(document, null, 2)}\n`,
);
console.log(`wrote ${document.routes.length} routes, 0 approved`);
