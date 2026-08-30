/** @author masterzee001 */
/**
 * The SELF-HOSTED half of the live chain, declared to the same standard as the
 * commercial half.
 *
 * Why this file had to exist. The capability resolver used to answer "which
 * languages can this deployment do" for the MT stage from a ten-entry list
 * copied out of media-ingest's env defaults, so ninety of the catalogue's
 * languages reported `unavailable` -- not because no engine can translate them
 * but because nothing here had ever written them down. A short list is not a
 * capability model; it is the absence of one, and it made the console lie in
 * the safe direction. The rule this wave adopts is that a language is enabled
 * by the resolver SEEING a provider that declares it, never by anybody adding
 * the language to a list.
 *
 * A self-hosted engine is not a vendor account, so `CommercialProvider` does
 * not fit: there is no API key, no integration stage and no live observation
 * against a third party. What it does have is exactly the distinction that
 * matters here, kept with the discipline commercial-providers.ts uses:
 *
 *   exercisedLanguages  a model PINNED BY REVISION in this repository's asset
 *                       registry, whose `languages` name this language. It has
 *                       been downloaded and run here.        -> declared
 *   declaredLanguages   the model card / tokenizer publishes it. Nobody here
 *                       has run it in this language.         -> claimed
 *
 * EVERY LIST BELOW WAS READ FROM ITS SOURCE ON 2026-08-30, not recalled. The
 * URL beside each is the exact artefact the codes were taken from, so a later
 * reader can diff rather than argue. A language list written from memory is
 * worse than an empty one, because it is believed.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED. Piper and MMS-TTS both cover far more
 * languages than appear here, and neither can speak one until a voice for it
 * is configured (PIPER_VOICES, MMS_TTS_VOICES). A voice nobody has configured
 * is not a capability, so their published catalogues are absent on purpose and
 * only the pinned voices count. The same reasoning keeps 9jaLingo out of this
 * file entirely: it is a vendor account and lives with the other vendors.
 */
import { lookupLanguage } from '@videofy-live/language-catalogue';

/** The three stages of the live chain. Re-exported by the resolver. */
export type CapabilityStage = 'stt' | 'mt' | 'tts';

export interface SelfHostedEngine {
  /** Matches the asset registry's `providerId` where one exists. */
  readonly engineId: string;
  readonly displayName: string;
  readonly stage: CapabilityStage;
  /**
   * The env var NAME whose VALUE selects this engine in media-ingest. A name,
   * never a value; nothing in this repository prints the value of one.
   */
  readonly selectedBy: string;
  /** Run here, pinned by revision in the asset registry. Strongest evidence. */
  readonly exercisedLanguages: readonly string[];
  /** Published by the model card or tokenizer and never run here. A claim. */
  readonly declaredLanguages: readonly string[];
  /** The artefact the language lists were read from. */
  readonly evidence: string;
  readonly notes?: string;
}

/**
 * Whisper's own tokenizer LANGUAGES table, in its order. Read from source
 * rather than from a documentation page, because the tokenizer is what the
 * runtime actually accepts.
 *
 * Igbo is NOT in it, and that absence is load-bearing: it is independent
 * confirmation of the 2026-08-26 Nigerian-language finding from a direction
 * that has nothing to do with synthesis. `tl` here is Filipino, which the
 * catalogue keys `fil`; `nn` folds to `no`. Codes outside the catalogue (haw,
 * jw, yue, br, oc, be, yi, fo, tk, mt, sa, lb, bo, as, tt, ba, su, mi, la) are
 * kept as read and simply never match a catalogue row.
 */
const WHISPER_TOKENIZER_LANGUAGES: readonly string[] = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl',
  'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi', 'he', 'uk', 'el', 'ms', 'cs', 'ro',
  'da', 'hu', 'ta', 'no', 'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy',
  'sk', 'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu',
  'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw', 'gl', 'mr', 'pa', 'si', 'km',
  'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo',
  'uz', 'fo', 'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg',
  'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su', 'yue',
];

/**
 * M2M-100's published coverage, from the model card's own language list.
 * `ns` is Northern Sotho, which the catalogue keys `nso`; `tl` is Filipino.
 */
const M2M100_MODEL_CARD_LANGUAGES: readonly string[] = [
  'af', 'am', 'ar', 'ast', 'az', 'ba', 'be', 'bg', 'bn', 'br', 'bs', 'ca',
  'ceb', 'cs', 'cy', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'ff', 'fi',
  'fr', 'fy', 'ga', 'gd', 'gl', 'gu', 'ha', 'he', 'hi', 'hr', 'ht', 'hu',
  'hy', 'id', 'ig', 'ilo', 'is', 'it', 'ja', 'jv', 'ka', 'kk', 'km', 'kn',
  'ko', 'lb', 'lg', 'ln', 'lo', 'lt', 'lv', 'mg', 'mk', 'ml', 'mn', 'mr',
  'ms', 'my', 'ne', 'nl', 'no', 'ns', 'oc', 'or', 'pa', 'pl', 'ps', 'pt',
  'ro', 'ru', 'sd', 'si', 'sk', 'sl', 'so', 'sq', 'sr', 'ss', 'su', 'sv',
  'sw', 'ta', 'th', 'tl', 'tn', 'tr', 'uk', 'ur', 'uz', 'vi', 'wo', 'xh',
  'yi', 'yo', 'zh', 'zu',
];

/** M2M-100 writes Northern Sotho `ns`; the catalogue key is `nso`. */
const M2M100_CODE_OVERRIDES: Readonly<Record<string, string>> = { ns: 'nso' };

/**
 * NLLB-200's FLORES-200 codes, paired with the catalogue key each one is.
 *
 * Stored as PAIRS rather than as a bare list of catalogue codes so the mapping
 * is the checkable thing. FLORES writes ISO 639-3 plus a script, and several
 * pairings are decisions rather than lookups -- `arb_Arab` for Arabic,
 * `pes_Arab` for Persian, `zsm_Latn` for Malay, `khk_Cyrl` for Mongolian,
 * `als_Latn` for Albanian, `plt_Latn` for Malagasy, `nob_Latn` for Norwegian,
 * `swh_Latn` for Swahili, `fuv_Latn` for the Nigerian variety of Fula,
 * `gaz_Latn` for Oromo, `kmr_Latn` for Kurmanji Kurdish, `uzn_Latn` for Uzbek,
 * `npi_Deva` for Nepali, `lvs_Latn` for Latvian, `pbt_Arab` for Pashto and
 * `tgl_Latn` for Filipino. Where NLLB splits a catalogue entry across scripts
 * (`zho_Hans`/`zho_Hant`, `azj`/`azb`), the script the catalogue defaults to is
 * the one recorded.
 *
 * THE TWO CATALOGUE LANGUAGES NLLB-200 DOES NOT COVER are Nigerian Pidgin
 * (`pcm`) and Venda (`ve`). Neither appears in the model card's 200, and
 * neither is invented here: the resolver reports their translation stage as
 * having no provider, which is the truth and is the kind of gap this table
 * exists to make visible.
 */
const NLLB_200_PAIRS: readonly (readonly [string, string])[] = [
  ['eng_Latn', 'en'], ['zho_Hans', 'zh'], ['hin_Deva', 'hi'], ['spa_Latn', 'es'],
  ['fra_Latn', 'fr'], ['arb_Arab', 'ar'], ['ben_Beng', 'bn'], ['por_Latn', 'pt'],
  ['rus_Cyrl', 'ru'], ['urd_Arab', 'ur'], ['ind_Latn', 'id'], ['deu_Latn', 'de'],
  ['jpn_Jpan', 'ja'], ['swh_Latn', 'sw'], ['mar_Deva', 'mr'], ['tel_Telu', 'te'],
  ['tur_Latn', 'tr'], ['tam_Taml', 'ta'], ['vie_Latn', 'vi'], ['kor_Hang', 'ko'],
  ['pes_Arab', 'fa'], ['ita_Latn', 'it'], ['hau_Latn', 'ha'], ['guj_Gujr', 'gu'],
  ['tha_Thai', 'th'], ['pan_Guru', 'pa'], ['kan_Knda', 'kn'], ['tgl_Latn', 'fil'],
  ['pol_Latn', 'pl'], ['yor_Latn', 'yo'], ['mal_Mlym', 'ml'], ['zsm_Latn', 'ms'],
  ['ory_Orya', 'or'], ['mya_Mymr', 'my'], ['ukr_Cyrl', 'uk'], ['ibo_Latn', 'ig'],
  ['amh_Ethi', 'am'], ['uzn_Latn', 'uz'], ['nld_Latn', 'nl'], ['ron_Latn', 'ro'],
  ['npi_Deva', 'ne'], ['snd_Arab', 'sd'], ['pbt_Arab', 'ps'], ['gaz_Latn', 'om'],
  ['kmr_Latn', 'ku'], ['azj_Latn', 'az'], ['ell_Grek', 'el'], ['hun_Latn', 'hu'],
  ['ces_Latn', 'cs'], ['swe_Latn', 'sv'], ['zul_Latn', 'zu'], ['kaz_Cyrl', 'kk'],
  ['som_Latn', 'so'], ['khm_Khmr', 'km'], ['kin_Latn', 'rw'], ['plt_Latn', 'mg'],
  ['heb_Hebr', 'he'], ['sin_Sinh', 'si'], ['bul_Cyrl', 'bg'], ['srp_Cyrl', 'sr'],
  ['xho_Latn', 'xh'], ['afr_Latn', 'af'], ['tir_Ethi', 'ti'], ['wol_Latn', 'wo'],
  ['fuv_Latn', 'ff'], ['lin_Latn', 'ln'], ['sna_Latn', 'sn'], ['tgk_Cyrl', 'tg'],
  ['kir_Cyrl', 'ky'], ['dan_Latn', 'da'], ['fin_Latn', 'fi'], ['slk_Latn', 'sk'],
  ['nob_Latn', 'no'], ['hrv_Latn', 'hr'], ['cat_Latn', 'ca'], ['nso_Latn', 'nso'],
  ['sot_Latn', 'st'], ['tsn_Latn', 'tn'], ['hye_Armn', 'hy'], ['kat_Geor', 'ka'],
  ['khk_Cyrl', 'mn'], ['lao_Laoo', 'lo'], ['hat_Latn', 'ht'], ['als_Latn', 'sq'],
  ['bos_Latn', 'bs'], ['lit_Latn', 'lt'], ['tso_Latn', 'ts'], ['slv_Latn', 'sl'],
  ['mkd_Cyrl', 'mk'], ['lvs_Latn', 'lv'], ['glg_Latn', 'gl'], ['est_Latn', 'et'],
  ['eus_Latn', 'eu'], ['cym_Latn', 'cy'], ['gle_Latn', 'ga'], ['isl_Latn', 'is'],
];

/** The catalogue keys NLLB-200 reaches, derived from the pairs above. */
export const NLLB_200_CATALOGUE_COVERAGE: readonly string[] = NLLB_200_PAIRS.map(
  ([, catalogueCode]) => catalogueCode,
);

/** The FLORES-200 code NLLB wants for a catalogue language, or undefined. */
export function flores200CodeFor(catalogueCode: string): string | undefined {
  return NLLB_200_PAIRS.find(([, code]) => code === catalogueCode)?.[0];
}

const WHISPER_EVIDENCE =
  'https://raw.githubusercontent.com/openai/whisper/main/whisper/tokenizer.py ' +
  '(LANGUAGES table, read 2026-08-30)';
const M2M100_EVIDENCE =
  'https://huggingface.co/facebook/m2m100_418M (model card language list, read 2026-08-30)';
const NLLB_EVIDENCE =
  'https://huggingface.co/facebook/nllb-200-distilled-600M ' +
  '(model card FLORES-200 language list, read 2026-08-30)';
const OPUS_MT_EVIDENCE =
  'services/ai-registry/src/registry.ts (opus-mt assets pinned by revision) and ' +
  'media-ingest DEFAULT_OPUS_MT_LANGUAGE_MODELS / ' +
  'DEFAULT_TRANSLATION_SUPPORTED_TARGET_LANGUAGES';
const LOCAL_VOICE_EVIDENCE =
  'services/ai-registry/src/registry.ts (piper and mms-tts voices pinned by checksum or revision)';

export const SELF_HOSTED_ENGINES: readonly SelfHostedEngine[] = [
  {
    engineId: 'faster-whisper',
    displayName: 'faster-whisper (local Whisper)',
    stage: 'stt',
    selectedBy: 'TRANSCRIPTION_PROVIDER',
    // Systran/faster-whisper-small, pinned by revision, declares en/es/fr.
    exercisedLanguages: ['en', 'es', 'fr'],
    declaredLanguages: WHISPER_TOKENIZER_LANGUAGES,
    evidence: WHISPER_EVIDENCE,
    notes:
      'BATCH ONLY. The live path needs a streaming recogniser and Whisper is not ' +
      'one, so a language whose only recogniser is Whisper can be transcribed ' +
      'from an uploaded programme and not spoken into a live one. The resolver ' +
      'reports the language; the execution policy still decides the route.',
  },
  {
    engineId: 'opus-mt',
    displayName: 'OPUS-MT (Helsinki-NLP Marian)',
    stage: 'mt',
    selectedBy: 'TRANSLATION_PROVIDER',
    exercisedLanguages: ['en', 'es', 'fr'],
    // Mirror of DEFAULT_TRANSLATION_SUPPORTED_TARGET_LANGUAGES: listed as
    // targets with no explicit model route, so the runtime must find a
    // Helsinki-NLP snapshot by convention. A convention is a claim.
    declaredLanguages: ['en', 'fr', 'es', 'de', 'pt', 'it', 'ja', 'zh', 'ar', 'yo'],
    evidence: OPUS_MT_EVIDENCE,
  },
  {
    engineId: 'm2m100',
    displayName: 'M2M-100 418M',
    stage: 'mt',
    selectedBy: 'TRANSLATION_PROVIDER',
    // The registry pins en->es, en->fr, en->pt, en->yo, en->zh.
    exercisedLanguages: ['en', 'es', 'fr', 'pt', 'yo', 'zh'],
    declaredLanguages: M2M100_MODEL_CARD_LANGUAGES.map(
      (code) => M2M100_CODE_OVERRIDES[code] ?? code,
    ),
    evidence: M2M100_EVIDENCE,
  },
  {
    engineId: 'nllb-200',
    displayName: 'NLLB-200 distilled 600M',
    stage: 'mt',
    selectedBy: 'TRANSLATION_FALLBACK_PROVIDER',
    exercisedLanguages: ['en', 'yo'],
    declaredLanguages: NLLB_200_CATALOGUE_COVERAGE,
    evidence: NLLB_EVIDENCE,
    notes:
      'CC-BY-NC-4.0. The registry records it as blocked-noncommercial, so its ' +
      'reach is a capability fact and NOT a licence to ship. Breadth here must ' +
      'never be read as breadth we may sell.',
  },
  {
    engineId: 'piper',
    displayName: 'Piper (local neural voices)',
    stage: 'tts',
    selectedBy: 'TEXT_TO_SPEECH_PROVIDER',
    exercisedLanguages: ['en', 'es', 'fr'],
    // A Piper voice must be installed per language (PIPER_VOICES). A voice
    // nobody configured is not a capability, so nothing is claimed beyond the
    // voices this repository actually pins.
    declaredLanguages: [],
    evidence: LOCAL_VOICE_EVIDENCE,
  },
  {
    engineId: 'mms-tts',
    displayName: 'MMS-TTS (Massively Multilingual Speech)',
    stage: 'tts',
    selectedBy: 'TEXT_TO_SPEECH_PROVIDER',
    exercisedLanguages: ['yo'],
    declaredLanguages: [],
    evidence: LOCAL_VOICE_EVIDENCE,
    notes:
      'MMS publishes voices for over a thousand languages and this deployment ' +
      'reaches exactly the ones in MMS_TTS_VOICES. Claiming the published ' +
      'catalogue would advertise a thousand languages nobody can synthesise.',
  },
];

/** Reduce a vendor tag to a catalogue key, honouring the catalogue's aliases. */
export function catalogueKeyOf(tag: string): string | null {
  return lookupLanguage(tag)?.code ?? null;
}

export function selfHostedEnginesForStage(
  stage: CapabilityStage,
  engines: readonly SelfHostedEngine[] = SELF_HOSTED_ENGINES,
): readonly SelfHostedEngine[] {
  return engines.filter((engine) => engine.stage === stage);
}
