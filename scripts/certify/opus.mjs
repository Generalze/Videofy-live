#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Lane E -- benchmark the LOCAL OPUS-MT translation routes, one DIRECTION at a
 * time, and report evidence a registry record could be written from.
 *
 * WHAT THIS MEASURES. Twelve directions, each independently:
 *
 *   en->fr fr->en  en->es es->en  en->pt pt->en
 *   en->ha ha->en  en->ig ig->en  en->yo yo->en
 *
 * en->yo is NOT the reverse of yo->en and is not measured as if it were. Each
 * direction gets its own model, its own samples, its own latency distribution
 * and its own verdict. Nothing here averages a pair.
 *
 * WHY IT DRIVES THE SERVICE'S OWN PROVIDER. It imports
 * `OpusMtTimestampedTranslationProvider` out of the DEPLOYED media-ingest
 * build and runs it against `/opt/videofy-ai/bin/python`. A second inference
 * path written for the benchmark would measure the benchmark: different
 * decoding flags, a different tokenizer prefix, a different model revision,
 * and numbers that describe code nobody deploys. The only thing this file adds
 * around the provider is a stopwatch and a judge.
 *
 * A NON-EMPTY STRING IS NOT A SUCCESS. Three separate ways an OPUS-MT route
 * fails while returning text, all of them checked here:
 *
 *   1. THE ECHO. Handed a language it cannot reach, a Marian model frequently
 *      returns the input nearly verbatim. Checked by token overlap with the
 *      source, not by equality alone -- a model that copies the input and
 *      changes the punctuation has still translated nothing.
 *   2. THE SIBLING. `opus-mt-en-alv` is a GROUP model covering the whole
 *      Atlantic-Volta family and picks its output language from a `>>yor<<`
 *      control token. Given the wrong token -- or no token -- it answers in a
 *      sibling language, fluently, at a perfectly good latency. Checked by
 *      identifying the language of the OUTPUT and requiring it to be the
 *      target.
 *   3. THE UNSTEERED GROUP MODEL. If the control token is not actually
 *      steering the model, `>>yor<<` and `>>ewe<<` produce the same string.
 *      Checked directly, by asking the same model for the same sentence under
 *      a different token and requiring the answers to differ.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. Not quality. The language identifier
 * below is a marker-and-diacritic heuristic, honest about being one: it can
 * tell Yoruba from Igbo and either from the English input, and it cannot tell
 * good Yoruba from bad Yoruba. For yo/ha/ig every route is reported with human
 * review REQUIRED, and the strongest sentence available about them is "output
 * was produced, in the target language, at this latency". Every raw output is
 * kept in the JSON so a human reviewer reads sentences rather than a verdict.
 *
 * COLD START IS REPORTED, NEVER AVERAGED IN. The first request against a model
 * pays interpreter start-up plus a multi-hundred-megabyte load; production
 * keeps the worker warm. That sample is timed, reported on its own line, and
 * excluded from the distribution.
 *
 * CREDENTIALS. This script needs none -- the models are local files -- but it
 * reads the service env file for the runtime's own settings and therefore
 * reports env facts by NAME and presence only, never by value.
 *
 * THREE MODES, because measuring and judging are separate jobs:
 *
 *     sudo node scripts/certify/opus.mjs --out /tmp/opus-benchmarks.json
 *     node scripts/certify/opus.mjs --self-check          # calibrate the judge
 *     node scripts/certify/opus.mjs --reclassify r.json   # re-judge, no inference
 *
 * `--reclassify` exists so a correction to the language identifier never
 * becomes a reason to run the models again. Re-running inference after
 * adjusting a judge is how a benchmark gets repeated until it passes;
 * re-judging fixed, already-recorded outputs cannot do that.
 */
import { cpus, loadavg } from 'node:os';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// --- arguments -------------------------------------------------------------

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const ENV_PATH = argValue('--env', '/etc/videofy/media-ingest.env');
const DIST_ROOT = argValue(
  '--dist',
  '/srv/videofy/app/services/media-ingest/dist/services/media-ingest/src',
);
const OUT_PATH = argValue('--out', '/tmp/videofy-certify/opus-benchmarks.json');
const ONLY = argValue('--only', '');
const SAMPLE_LIMIT = Math.max(1, Number.parseInt(argValue('--samples', '8'), 10) || 8);
const TIMEOUT_MS = Math.max(1000, Number.parseInt(argValue('--timeout-ms', '120000'), 10) || 120000);
const ENVIRONMENT_LABEL = argValue('--environment', 'staging (c7-eu-01)');

const selected = ONLY.trim() === '' ? null : new Set(ONLY.split(',').map((part) => part.trim()));
const wanted = (id) => selected === null || selected.has(id);

// --- environment: NAMES leave this scope, values never do -------------------

function loadEnvFile(path) {
  if (!existsSync(path)) return { loaded: false, names: [] };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    console.error(
      `Cannot read ${path} (${error?.code ?? 'error'}). Run this on the box, with permission ` +
        'to read the service env file -- try sudo.',
    );
    process.exit(2);
  }
  const names = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) continue;
    names.push(name);
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[name] === undefined || process.env[name] === '') process.env[name] = value;
  }
  return { loaded: true, names };
}

const envFile = loadEnvFile(ENV_PATH);
const env = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

const PYTHON = argValue('--python', env('OPUS_MT_PYTHON') ?? '/opt/videofy-ai/bin/python');
/**
 * Cache roots, in probe order.
 *
 * The service is configured with ONE (`OPUS_MT_MODEL_CACHE_DIR`). A model that
 * is only present under a different root is measurable but NOT reachable by
 * the running service, and the report has to say which of the two it was --
 * "the model works" and "the service can load the model" are different claims
 * and only one of them belongs in a registry record.
 */
const CONFIGURED_CACHE = env('OPUS_MT_MODEL_CACHE_DIR') ?? '/var/lib/videofy/models';
const HF_HOME = env('HF_HOME') ?? CONFIGURED_CACHE;
const CACHE_ROOTS = [
  { label: 'configured', path: CONFIGURED_CACHE },
  { label: 'hf-home-hub', path: `${HF_HOME.replace(/\/+$/u, '')}/hub` },
];

// --- the sample set --------------------------------------------------------

/**
 * REPRESENTATIVE OF MESSAGING, WHICH IS THE SERVICE THESE ROUTES ARE FOR.
 *
 * Eight short conversational turns of the kind a chat actually carries:
 * greeting, arrival time, thanks, whereabouts, money received, call-me-back,
 * reassurance, sign-off. Six to nine words, one clause, present or perfect
 * tense, no literary prose and no domain jargon -- because a latency measured
 * on a paragraph of prose is not the latency of a chat line, and a success
 * rate measured on curated literary sentences is not the success rate of
 * "Ina kake?".
 *
 * The eight meanings are the SAME across all seven source languages, so a
 * direction can be compared against its opposite without also changing the
 * subject matter. That is a convenience for the reader; it is not a licence to
 * average the two, and the report does not.
 */
const SAMPLE_SETS = {
  en: [
    'How are you doing today?',
    'I am on my way, give me five minutes.',
    'Thank you very much for your help.',
    'Where are you right now?',
    'I have received the money, thank you.',
    'Please call me back when you are free.',
    'No problem at all.',
    'See you tomorrow morning.',
  ],
  fr: [
    "Comment vas-tu aujourd'hui ?",
    "J'arrive dans cinq minutes.",
    'Merci beaucoup pour ton aide.',
    'Où es-tu en ce moment ?',
    "J'ai bien reçu l'argent, merci.",
    'Rappelle-moi quand tu es libre.',
    "Il n'y a aucun problème.",
    'On se voit demain matin.',
  ],
  es: [
    '¿Cómo estás hoy?',
    'Llego en cinco minutos.',
    'Muchas gracias por tu ayuda.',
    '¿Dónde estás ahora mismo?',
    'Ya recibí el dinero, gracias.',
    'Llámame cuando estés libre.',
    'No hay ningún problema.',
    'Nos vemos mañana por la mañana.',
  ],
  pt: [
    'Como você está hoje?',
    'Chego em cinco minutos.',
    'Muito obrigado pela sua ajuda.',
    'Onde você está agora?',
    'Já recebi o dinheiro, obrigado.',
    'Me liga quando estiver livre.',
    'Não tem problema nenhum.',
    'Até amanhã de manhã.',
  ],
  ha: [
    'Yaya kake yau?',
    'Ina kan hanya, ka ba ni minti biyar.',
    'Na gode sosai da taimakonka.',
    'Ina kake yanzu?',
    'Na karɓi kuɗin, na gode.',
    'Don Allah ka sake kira na idan ka samu lokaci.',
    'Babu matsala ko kaɗan.',
    'Sai gobe da safe.',
  ],
  ig: [
    'Kedu ka ị mere taa?',
    'Anọ m nʼụzọ, nye m nkeji ise.',
    'Daalụ nke ukwuu maka enyemaka gị.',
    'Ebee ka ị nọ ugbu a?',
    'Enwetala m ego ahụ, daalụ.',
    'Biko kpọọ m òkù ọzọ mgbe ị nwere ohere.',
    'Ọ dịghị nsogbu ọ bụla.',
    'Anyị ga-ahụ echi ụtụtụ.',
  ],
  yo: [
    'Báwo ni o ṣe wà lónìí?',
    'Mo wà ní ọ̀nà, fún mi ní ìṣẹ́jú márùn-ún.',
    'Ẹ ṣé púpọ̀ fún ìrànlọ́wọ́ yín.',
    'Níbo ni o wà báyìí?',
    'Mo ti gba owó náà, ẹ ṣé.',
    'Jọ̀wọ́ pè mí padà tí o bá ní àyè.',
    'Kò sí ìṣòro kankan.',
    'A ó rí ara wa ní àárọ̀ ọ̀la.',
  ],
};

/**
 * The malformed-input battery.
 *
 * Every one of these reaches a live chat eventually: an empty edit, a line of
 * whitespace, a reaction sent as text, a pasted phone number, and somebody
 * pasting a whole document into a message box. What matters is not that they
 * translate but that the failure is a defined one -- an error the pipeline can
 * classify, or a defined empty result -- rather than a hang, a crash that
 * takes the persistent worker down, or a confident hallucination.
 */
const MALFORMED_INPUTS = [
  { id: 'empty', text: '', note: 'empty string' },
  { id: 'whitespace', text: '   \t  ', note: 'whitespace only' },
  { id: 'emoji', text: '😀😀😀', note: 'emoji only, no words' },
  { id: 'digits', text: '08031234567', note: 'digits only (a phone number)' },
  {
    id: 'control-chars',
    // Written as escapes: this repository refuses source containing real
    // control characters (scripts/check-source-hygiene.mjs), and the probe
    // needs the bytes at RUNTIME, not in the file.
    text: `hello${String.fromCharCode(0)}${String.fromCharCode(7)} world`,
    note: 'embedded NUL and BEL control characters',
  },
  { id: 'very-long', text: `${'How are you doing today? '.repeat(200)}`, note: '5000 characters' },
];

// --- the twelve routes -----------------------------------------------------

/**
 * `groupModel` marks a model that serves more than one target language and
 * therefore needs a `>>lang<<` control token. `controlTarget` is a SIBLING
 * language inside that same group, used only to prove the token steers.
 */
const ROUTES = [
  { id: 'en-fr', source: 'en', target: 'fr', modelId: 'Helsinki-NLP/opus-mt-en-fr', groupModel: false },
  { id: 'fr-en', source: 'fr', target: 'en', modelId: 'Helsinki-NLP/opus-mt-fr-en', groupModel: false },
  { id: 'en-es', source: 'en', target: 'es', modelId: 'Helsinki-NLP/opus-mt-en-es', groupModel: false },
  { id: 'es-en', source: 'es', target: 'en', modelId: 'Helsinki-NLP/opus-mt-es-en', groupModel: false },
  {
    id: 'en-pt',
    source: 'en',
    target: 'pt',
    modelId: 'Helsinki-NLP/opus-mt-en-ROMANCE',
    groupModel: true,
    controlTarget: 'ro',
  },
  {
    id: 'pt-en',
    source: 'pt',
    target: 'en',
    modelId: 'Helsinki-NLP/opus-mt-ROMANCE-en',
    groupModel: false,
    note: 'multi-SOURCE group model; the source side needs no control token',
  },
  { id: 'en-ha', source: 'en', target: 'ha', modelId: 'Helsinki-NLP/opus-mt-en-ha', groupModel: false },
  { id: 'ha-en', source: 'ha', target: 'en', modelId: 'Helsinki-NLP/opus-mt-ha-en', groupModel: false },
  { id: 'en-ig', source: 'en', target: 'ig', modelId: 'Helsinki-NLP/opus-mt-en-ig', groupModel: false },
  { id: 'ig-en', source: 'ig', target: 'en', modelId: 'Helsinki-NLP/opus-mt-ig-en', groupModel: false },
  {
    id: 'en-yo',
    source: 'en',
    target: 'yo',
    modelId: 'Helsinki-NLP/opus-mt-en-alv',
    groupModel: true,
    controlTarget: 'ewe',
    note: 'opus-mt-en-yo does not exist; Yoruba comes from the Atlantic-Volta group model',
  },
  { id: 'yo-en', source: 'yo', target: 'en', modelId: 'Helsinki-NLP/opus-mt-yo-en', groupModel: false },
];

/** Human quality review is mandatory for the low-resource Nigerian targets. */
const HUMAN_REVIEW_REQUIRED_TARGETS = new Set(['yo', 'ha', 'ig']);

// --- language identification (a heuristic, and it says so) -----------------

/**
 * Marker-based language identification over the seven languages in scope.
 *
 * This is NOT a general-purpose language identifier and is not presented as
 * one. It answers one narrow question the benchmark actually needs: is this
 * output in the target language, or is it the input echoed back / a sibling
 * language the group model reached for instead?
 *
 * Two signals, deliberately simple so the verdict is auditable:
 *
 *   FUNCTION WORDS. Closed-class words appear in nearly every sentence of a
 *   language and almost never in another. Words shared between siblings
 *   (es/pt "problema", yo/ig "na") are omitted rather than shared, so the
 *   score counts only evidence that discriminates.
 *
 *   ORTHOGRAPHY. Yoruba writes dots under e/o/s, Igbo under i/o/u, Hausa uses
 *   hooked b/d/k, Portuguese has tildes on a/o, Spanish has inverted marks and
 *   n-tilde. A single one of these is close to conclusive between the pair it
 *   separates, so it is weighted above a function word.
 *
 * The reported verdict requires the target to be the STRICT maximum with a
 * non-zero score. A tie, or an all-zero row, is not a pass -- it is reported
 * as `undetermined`, which is a fact about the identifier as much as about the
 * output, and a human resolves it from the raw sentence stored alongside.
 */
const FUNCTION_WORDS = {
  en: ['the', 'and', 'you', 'are', 'is', 'to', 'for', 'me', 'my', 'i', 'it', 'that', 'this', 'we', 'they', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'not', 'but', 'with', 'from', 'your', 'our', 'them', 'there', 'here', 'what', 'who', 'which', 'because', 'if', 'about', 'after', 'before', 'than', 'then', 'also', 'just', 'only', 'more', 'most', 'please', 'thank', 'thanks', 'tomorrow', 'today', 'yesterday', 'evening', 'morning', 'night', 'money', 'when', 'where', 'how', 'back', 'free', 'problem', 'very', 'much', 'help', 'way', 'all', 'doing', 'right', 'now', 'later', 'received', 'will', 'would', 'can', 'could', 'send', 'sent', 'see', 'meeting', 'documents', 'minutes', 'five', 'four', 'give'],
  fr: ['je', "j'ai", "j'arrive", 'tu', 'vous', 'nous', 'ils', 'elles', 'le', 'les', 'une', 'des', 'du', 'aux', 'et', 'est', 'sont', 'était', 'été', 'pas', 'ne', 'qui', 'pour', 'avec', 'sur', 'dans', 'mais', 'plus', 'très', 'vais', 'suis', 'avez', 'avons', 'peux', 'peut', 'veux', 'veut', 'bien', 'aussi', 'encore', 'déjà', 'maintenant', 'merci', 'beaucoup', 'où', 'aide', 'argent', 'quand', 'libre', 'demain', 'hier', 'matin', 'soir', 'heures', 'réunion', 'problème', 'aucun', 'rappelle', 'arrive', 'comment', "aujourd'hui", 'ton', 'reçu', 'cinq', 'chemin', 'route', 'moi', 'toi', 'êtes', 'es-tu', 'vas-tu', 'envoyer', 'documents'],
  es: ['cómo', 'estás', 'están', 'estoy', 'soy', 'eres', 'hoy', 'ayer', 'llego', 'muchas', 'gracias', 'ayuda', 'dónde', 'ahora', 'mismo', 'recibí', 'dinero', 'llámame', 'cuando', 'estés', 'hay', 'ningún', 'vemos', 'camino', 'mañana', 'muy', 'todo', 'todos', 'el', 'los', 'las', 'una', 'unos', 'unas', 'pero', 'con', 'sin', 'también', 'luego', 'después', 'noche', 'reunión', 'cuatro', 'ellos', 'nosotros', 'usted', 'ustedes', 'tengo', 'tiene', 'puedo', 'puede', 'quiero', 'quiere', 'hace', 'más', 'menos', 'otra', 'otro', 'nuevo', 'bueno', 'enviaré', 'cambiado'],
  pt: ['você', 'vocês', 'nós', 'eles', 'hoje', 'chego', 'obrigado', 'obrigada', 'pela', 'pelo', 'sua', 'seu', 'onde', 'agora', 'já', 'recebi', 'dinheiro', 'liga', 'estiver', 'livre', 'não', 'tem', 'tenho', 'nenhum', 'até', 'amanhã', 'manhã', 'caminho', 'estou', 'ajuda', 'muito', 'os', 'um', 'uma', 'uns', 'umas', 'do', 'da', 'dos', 'das', 'com', 'sem', 'também', 'depois', 'vou', 'vai', 'vamos', 'é', 'são', 'foi', 'pode', 'posso', 'quero', 'fazer', 'faz', 'noite', 'reunião', 'quatro', 'bom', 'novo', 'outro', 'adiada'],
  ha: ['yaya', 'kake', 'kike', 'yau', 'jiya', 'gobe', 'ina', 'hanya', 'minti', 'biyar', 'hudu', 'gode', 'sosai', 'taimakonka', 'yanzu', 'karɓi', 'kuɗin', 'kudi', 'allah', 'sake', 'kira', 'idan', 'samu', 'lokaci', 'babu', 'matsala', 'kaɗan', 'safe', 'yamma', 'dare', 'karfe', 'taron', 'canza', 'aika', 'takardun', 'ne', 'ce', 'don', 'saboda', 'zan', 'zai', 'za', 'an', 'kai', 'yana', 'tana', 'suna', 'muna', 'kuna', 'wannan', 'wani', 'wata', 'amma', 'kuma', 'shi', 'ita', 'mutane', 'gida'],
  ig: ['kedu', 'taa', 'echi', 'anọ', 'nʼụzọ', 'nkeji', 'ise', 'ano', 'daalụ', 'ukwuu', 'maka', 'enyemaka', 'gị', 'ebee', 'nọ', 'ugbu', 'enwetala', 'ego', 'ahụ', 'biko', 'kpọọ', 'òkù', 'ọzọ', 'mgbe', 'nwere', 'ohere', 'dịghị', 'nsogbu', 'bụla', 'anyị', 'unu', 'ụtụtụ', 'abalị', 'nke', 'ndị', 'bụ', 'dị', 'adị', 'ihe', 'mmadụ', 'ụlọ', 'ụbọchị', 'elekere', 'nzuko', 'nzukọ', 'budatala', 'ezite', 'akwụkwọ', 'aga', 'ị', 'gaa'],
  yo: ['báwo', 'bawo', 'lónìí', 'loni', 'àná', 'ọ̀nà', 'fún', 'ìṣẹ́jú', 'márùn-ún', 'marun', 'ṣé', 'ṣe', 'púpọ̀', 'ìrànlọ́wọ́', 'yín', 'níbo', 'nibo', 'báyìí', 'owó', 'náà', 'jọ̀wọ́', 'jowo', 'pè', 'mí', 'padà', 'àyè', 'kò', 'kì', 'ìṣòro', 'kankan', 'àárọ̀', 'ọ̀la', 'àwọn', 'tí', 'ń', 'wà', 'yóò', 'èmi', 'ìwọ', 'òun', 'àwa', 'ẹ̀yin', 'wọn', 'nítorí', 'nígbà', 'ọjọ́', 'ilé', 'ènìyàn', 'ìpàdé', 'aago', 'mẹ́rin', 'ránṣẹ́', 'alẹ́', 'ìwé', 'yí'],
};

/** One hit is close to conclusive for the pair the mark separates. */
const ORTHOGRAPHY = {
  // Each entry lists only marks the language does NOT share with its nearest
  // confusable. Yoruba writes a dot under E and S; the dot under O is left out
  // because Igbo writes it too, and a mark both siblings emit separates
  // neither. Same reasoning for the circumflex: French and Portuguese both use
  // it, so it belongs to Portuguese here only against Spanish, and French is
  // left with grave-U, grave-E and the OE ligature, which Portuguese does not
  // write at all.
  yo: /[ẹṣ]|[es]̣/iu,
  ig: /[ịụṅ]|[iu]̣/iu,
  ha: /[ɓɗƙƴ]/iu,
  pt: /[ãõâêô]/iu,
  es: /[ñ¿¡]/u,
  fr: /[œùè]/iu,
  en: null,
};

const ORTHOGRAPHY_WEIGHT = 2.5;

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{M}'ʼ-]+/u)
    .filter((word) => word !== '');
}

function identifyLanguage(text) {
  const tokens = tokenize(text);
  const scores = {};
  for (const [language, words] of Object.entries(FUNCTION_WORDS)) {
    const set = new Set(words);
    let score = 0;
    for (const token of tokens) if (set.has(token)) score += 1;
    const pattern = ORTHOGRAPHY[language];
    if (pattern && pattern.test(text)) score += ORTHOGRAPHY_WEIGHT;
    scores[language] = Number(score.toFixed(2));
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topLanguage, topScore] = ranked[0];
  const runnerUpScore = ranked[1]?.[1] ?? 0;
  if (topScore <= 0 || topScore === runnerUpScore) {
    return { language: null, scores, top: topLanguage, topScore, margin: 0 };
  }
  return {
    language: topLanguage,
    scores,
    top: topLanguage,
    topScore,
    margin: Number((topScore - runnerUpScore).toFixed(2)),
  };
}

/**
 * Echo detection. A Marian model handed a target it cannot reach very often
 * returns the source almost unchanged, and "almost" is the operative word --
 * equality alone misses the copy that dropped a comma. Jaccard over the token
 * sets, with the threshold set high enough that a genuine translation sharing
 * a proper noun or a number does not trip it.
 */
const ECHO_JACCARD_THRESHOLD = 0.6;

function echoScore(sourceText, outputText) {
  const source = new Set(tokenize(sourceText));
  const output = new Set(tokenize(outputText));
  if (source.size === 0 || output.size === 0) return 0;
  let shared = 0;
  for (const token of output) if (source.has(token)) shared += 1;
  const union = source.size + output.size - shared;
  return union === 0 ? 0 : Number((shared / union).toFixed(3));
}

/**
 * The one place a sample's outcome is decided, so the live run and the offline
 * re-classification below cannot drift apart.
 *
 * SIX OUTCOMES, and only one of them is a pass. `undetermined` exists because
 * "the identifier could not confirm the target language" is a statement about
 * the identifier, not proof the model answered in the wrong language -- and
 * collapsing the two would let a weak identifier manufacture failures the same
 * way a 200 manufactures successes.
 */
function classifySample(sample, targetLanguage) {
  if (sample.error) return { outcome: 'error', failureReason: 'provider error' };
  const text = String(sample.outputText ?? '');
  if (text.trim() === '') return { outcome: 'empty', failureReason: 'empty output' };
  const identity = identifyLanguage(text);
  const echoJaccard = echoScore(sample.sourceText, text);
  const sourceWords = tokenize(sample.sourceText).length;
  const outputWords = tokenize(text).length;
  const common = {
    identifiedLanguage: identity.language,
    languageScores: identity.scores,
    languageMargin: identity.margin,
    echoJaccard,
    sourceWords,
    outputWords,
    expansionRatio:
      sourceWords === 0 || outputWords < RUNAWAY_MINIMUM_OUTPUT_WORDS
        ? null
        : Number((outputWords / sourceWords).toFixed(2)),
  };
  if (echoJaccard >= ECHO_JACCARD_THRESHOLD) {
    return { ...common, outcome: 'echo', failureReason: `output echoes the input (jaccard ${echoJaccard})` };
  }
  if (identity.language === null) {
    return {
      ...common,
      outcome: 'undetermined',
      failureReason: 'the language identifier could not confirm a language for this output',
    };
  }
  if (identity.language !== targetLanguage) {
    return {
      ...common,
      outcome: 'wrong-language',
      failureReason: `output identified as ${identity.language}, not ${targetLanguage}`,
    };
  }
  if (common.expansionRatio !== null && common.expansionRatio >= RUNAWAY_EXPANSION_RATIO) {
    return {
      ...common,
      outcome: 'runaway-expansion',
      failureReason:
        `output is ${common.expansionRatio}x the length of the input (${common.outputWords} words ` +
        `from ${common.sourceWords}); the model kept generating instead of stopping`,
    };
  }
  return { ...common, outcome: 'in-target-language', failureReason: null };
}

/**
 * A chat line that comes back as a paragraph has failed, whatever language the
 * paragraph is in.
 *
 * This is here because it HAPPENED, not as a precaution. Handed "See you
 * tomorrow morning.", `opus-mt-en-ha` returned three hundred and fifty
 * characters of unrelated devotional prose, in fluent Hausa, after seventy-four
 * seconds. Every check above passes it: non-empty, not an echo, unmistakably
 * Hausa. Only the length gives it away, so the length is checked -- an eight
 * word message does not have a sixty word translation, and the ratio catches
 * the degenerate decode that the language identifier cannot see.
 *
 * The floor of forty output words keeps a legitimately expansive short
 * rendering ("Hi." -> a five word greeting) out of the net.
 */
const RUNAWAY_EXPANSION_RATIO = 5;
const RUNAWAY_MINIMUM_OUTPUT_WORDS = 40;

/**
 * CALIBRATION. Sentences the marker lists were NOT written from, so the number
 * this produces is an out-of-sample figure rather than the identifier grading
 * its own homework. Run it with `--self-check`; the report embeds the result,
 * because a verdict produced by an unmeasured judge is not evidence.
 */
const CALIBRATION_SET = [
  ['en', 'The meeting has been moved to four o clock.'],
  ['en', 'I will send the documents later this evening.'],
  ['fr', 'La réunion a été déplacée à seize heures.'],
  ['fr', 'Je vais envoyer les documents ce soir.'],
  ['es', 'La reunión se ha cambiado a las cuatro.'],
  ['es', 'Enviaré los documentos esta noche.'],
  ['pt', 'A reunião foi adiada para as quatro horas.'],
  ['pt', 'Vou enviar os documentos esta noite.'],
  ['ha', 'An canza taron zuwa karfe hudu.'],
  ['ha', 'Zan aika da takardun da yamma.'],
  ['ig', 'E budatala nzuko ahu ruo elekere ano.'],
  ['ig', 'Aga m ezite akwụkwọ ndị ahụ nʼabalị.'],
  ['yo', 'A ti yí ìpàdé náà padà sí aago mẹ́rin.'],
  ['yo', 'Èmi yóò fi àwọn ìwé náà ránṣẹ́ ní alẹ́.'],
];

function selfCheck() {
  const inSample = { correct: 0, total: 0, misses: [] };
  for (const [language, sentences] of Object.entries(SAMPLE_SETS)) {
    for (const sentence of sentences) {
      inSample.total += 1;
      const identified = identifyLanguage(sentence).language;
      if (identified === language) inSample.correct += 1;
      else inSample.misses.push({ expected: language, identified, sentence });
    }
  }
  const outOfSample = { correct: 0, abstained: 0, wrong: 0, total: 0, errors: [] };
  for (const [language, sentence] of CALIBRATION_SET) {
    outOfSample.total += 1;
    const identified = identifyLanguage(sentence).language;
    if (identified === language) outOfSample.correct += 1;
    else if (identified === null) outOfSample.abstained += 1;
    else {
      outOfSample.wrong += 1;
      outOfSample.errors.push({ expected: language, identified, sentence });
    }
  }
  return { inSample, outOfSample };
}

/**
 * Roll the per-sample outcomes up onto the route record.
 *
 * `successRate` counts ONLY samples confirmed to be in the target language.
 * Undetermined samples are neither counted as successes nor hidden: they get
 * their own field, because a route whose evidence is "6 confirmed, 2 the judge
 * could not read" is a different registry decision from "6 confirmed, 2
 * answered in Ewe".
 */
function summariseSamples(record) {
  record.sampleCount = record.samples.length;
  const counts = {};
  for (const sample of record.samples) {
    counts[sample.outcome] = (counts[sample.outcome] ?? 0) + 1;
  }
  record.outcomeCounts = counts;
  record.successCount = counts['in-target-language'] ?? 0;
  record.undeterminedCount = counts['undetermined'] ?? 0;
  record.wrongLanguageCount = counts['wrong-language'] ?? 0;
  record.echoCount = counts['echo'] ?? 0;
  record.runawayExpansionCount = counts['runaway-expansion'] ?? 0;
  record.successRate =
    record.sampleCount === 0 ? 0 : Number((record.successCount / record.sampleCount).toFixed(3));
  return record;
}

// --- statistics ------------------------------------------------------------

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function stats(values) {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    min: Math.min(...values),
    median: median(values),
    mean: Math.round(sum / values.length),
    max: Math.max(...values),
  };
}

// --- model location and control token --------------------------------------

/**
 * Which cache root actually holds a COMPLETE snapshot of this model.
 *
 * "Complete" is checked rather than assumed because a half-finished download
 * leaves a snapshot directory holding only `model.safetensors` and no
 * tokenizer, which loads far enough to look present and then fails at first
 * use -- exactly the shape of failure that gets diagnosed as "the model is
 * broken" when the truth is "the download is still running".
 */
const REQUIRED_SNAPSHOT_FILES = ['config.json', 'vocab.json', 'source.spm', 'target.spm'];

async function locateModel(modelId) {
  const folder = `models--${modelId.replace(/\//gu, '--')}`;
  const found = [];
  for (const root of CACHE_ROOTS) {
    const base = `${root.path}/${folder}/snapshots`;
    if (!existsSync(base)) continue;
    let complete = false;
    let revision = null;
    const partialRevisions = [];
    try {
      for (const snapshot of readdirSync(base)) {
        const present = REQUIRED_SNAPSHOT_FILES.every((file) =>
          existsSync(`${base}/${snapshot}/${file}`),
        );
        if (present) {
          complete = true;
          revision = snapshot;
        } else {
          partialRevisions.push(snapshot);
        }
      }
    } catch {
      complete = false;
    }
    // The snapshot directory name IS the hub commit the weights came from, so
    // recording it pins the evidence to a REVISION rather than to a model name
    // that upstream can move under us.
    found.push({ ...root, complete, revision, partialRevisions });
  }
  const usable = found.find((entry) => entry.complete) ?? null;
  return { folder, roots: found, usable };
}

/**
 * Which `>>lang<<` control token the RUNTIME would choose for this target.
 *
 * The worker probes its own tokenizer vocabulary rather than being told a
 * token, which is the right design and also means nothing in the repository
 * states what token any given route ends up using. Since the report has to
 * name it, this reproduces the worker's candidate order EXACTLY -- the list
 * below is copied from `_target_prefix` in translation-provider.ts -- and asks
 * the vocabulary the same question. It loads a tokenizer, never a model, and
 * runs no inference.
 */
const TOKEN_PROBE = String.raw`
import json, sys
from transformers import MarianTokenizer

model_id = sys.argv[1]
cache_dir = sys.argv[2] or None
targets = sys.argv[3].split(",") if sys.argv[3] else []

kwargs = {"local_files_only": True}
if cache_dir:
    kwargs["cache_dir"] = cache_dir
tokenizer = MarianTokenizer.from_pretrained(model_id, **kwargs)
vocab = tokenizer.get_vocab()

_iso3 = {"pt": "por", "fr": "fra", "es": "spa", "it": "ita", "ro": "ron", "ca": "cat", "gl": "glg", "de": "deu", "nl": "nld", "sv": "swe", "ar": "ara", "yo": "yor"}
_prefix_candidates = {"zh": ["cmn_Hans", "cmn", "zho", "zh"], "el": ["ell", "el"], "ru": ["rus", "ru"], "la": ["la", "lat"]}

def chosen(target):
    lowered = target.lower()
    candidates = list(_prefix_candidates.get(lowered, []))
    for cand in (lowered, _iso3.get(lowered), lowered + "_br"):
        if cand and cand not in candidates:
            candidates.append(cand)
    for cand in candidates:
        if (">>" + cand + "<<") in vocab:
            return {"target": target, "token": ">>" + cand + "<<", "probed": candidates}
    return {"target": target, "token": None, "probed": candidates}

control_tokens = sorted(token for token in vocab if token.startswith(">>") and token.endswith("<<"))
print(json.dumps({
    "vocabSize": len(vocab),
    "controlTokenCount": len(control_tokens),
    "controlTokenSample": control_tokens[:12],
    "targets": [chosen(target) for target in targets],
}))
`;

async function probeControlToken(modelId, cacheDir, targets) {
  try {
    const { stdout } = await execFileAsync(
      PYTHON,
      ['-c', TOKEN_PROBE, modelId, cacheDir ?? '', targets.join(',')],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env } },
    );
    return JSON.parse(stdout.trim().split('\n').pop());
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 400) };
  }
}

// --- licence ---------------------------------------------------------------

/**
 * Stated from the model cards, not inferred from the family. Every Helsinki-NLP
 * OPUS-MT model measured here carries the same licence, but the check belongs
 * per model rather than per family: a licence claim covering "OPUS-MT" is the
 * kind of blanket that turns out to have an exception in it.
 */
async function readLicence(modelId, cacheDir) {
  const folder = `models--${modelId.replace(/\//gu, '--')}`;
  const base = `${cacheDir}/${folder}/snapshots`;
  const result = { modelId, licence: 'unknown', source: null, commercialUse: 'unknown' };
  if (!existsSync(base)) return result;
  try {
    for (const snapshot of readdirSync(base)) {
      for (const file of ['README.md', 'metadata.json']) {
        const path = `${base}/${snapshot}/${file}`;
        if (!existsSync(path)) continue;
        const text = readFileSync(path, 'utf8');
        const match = /license:\s*([A-Za-z0-9.\-+]+)/u.exec(text) ?? /"license"\s*:\s*"([^"]+)"/u.exec(text);
        if (match) {
          result.licence = match[1];
          result.source = `${file} in local snapshot`;
          result.commercialUse = /^(apache|mit|cc-by-4|cc-by-sa-4)/iu.test(match[1])
            ? 'permitted'
            : /nc/iu.test(match[1])
              ? 'restricted'
              : 'unknown';
          return result;
        }
      }
    }
  } catch {
    /* fall through to unknown */
  }
  return result;
}

// --- the run ---------------------------------------------------------------

async function loadProviderClass() {
  const path = `${DIST_ROOT}/translation-provider.js`;
  if (!existsSync(path)) {
    console.error(
      `No deployed media-ingest build at ${path}. This benchmark drives the SERVICE's provider, ` +
        'not a private copy of it -- point --dist at a real build.',
    );
    process.exit(2);
  }
  const module = await import(`file://${path}`);
  return module.OpusMtTimestampedTranslationProvider;
}

function buildProvider(OpusMtProvider, route, location) {
  const languageModels = [
    {
      sourceLanguage: route.source,
      targetLanguage: route.target,
      modelId: route.modelId,
      localPath: null,
    },
  ];
  const supported = [route.target];
  if (route.controlTarget) {
    languageModels.push({
      sourceLanguage: route.source,
      targetLanguage: route.controlTarget,
      modelId: route.modelId,
      localPath: null,
    });
    supported.push(route.controlTarget);
  }
  return new OpusMtProvider({
    pythonExecutable: PYTHON,
    modelCacheDir: location.usable?.path ?? CONFIGURED_CACHE,
    supportedTargetLanguages: supported,
    languageModels,
    timeoutMs: TIMEOUT_MS,
    maxConcurrency: 1,
    allowModelDownload: false,
  });
}

let sequence = 0;
function translationInput(route, target, text) {
  sequence += 1;
  return {
    sessionId: 'lane-e-opus-benchmark',
    streamId: route.id,
    segmentId: `seg-${sequence}`,
    sequence,
    sourceLanguage: route.source,
    targetLanguage: target,
    sourceText: text,
    startMs: 0,
    endMs: 1000,
  };
}

async function timedTranslate(provider, input) {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await provider.translate(input);
    const latencyMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
    return { ok: true, latencyMs, text: result.translatedText ?? '', modelId: result.modelId ?? null };
  } catch (error) {
    const latencyMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
    return {
      ok: false,
      latencyMs,
      error: String(error?.message ?? error).slice(0, 600),
      code: error?.code ?? null,
    };
  }
}

async function runRoute(OpusMtProvider, route) {
  const location = await locateModel(route.modelId);
  const record = {
    id: route.id,
    provider: 'opus-mt',
    sourceLanguage: route.source,
    targetLanguage: route.target,
    modelId: route.modelId,
    groupModel: route.groupModel,
    note: route.note ?? null,
    modelLocation: {
      folder: location.folder,
      roots: location.roots,
      usedRoot: location.usable?.label ?? null,
      usedPath: location.usable?.path ?? null,
      revision: location.usable?.revision ?? null,
      reachableByConfiguredService: location.usable?.label === 'configured',
    },
    controlToken: null,
    /**
     * The box is shared. Other lanes were running while this measured, and a
     * latency taken under contention is an UPPER bound rather than a clean
     * one -- so the load average is recorded next to the number instead of
     * being left for a later reader to wonder about.
     */
    loadAverageBefore: loadavg().map((value) => Number(value.toFixed(2))),
    loadAverageAfter: null,
    cpuCount: cpus().length,
    coldStart: null,
    samples: [],
    latencyMs: null,
    successCount: 0,
    sampleCount: 0,
    successRate: 0,
    malformed: [],
    tokenSteering: null,
    licence: null,
    humanReviewRequired: HUMAN_REVIEW_REQUIRED_TARGETS.has(route.target),
    verdict: 'unmeasured',
    verdictReason: null,
  };

  if (!location.usable) {
    record.verdict = 'unmeasured';
    record.verdictReason =
      'no complete local snapshot of this model under any known cache root; nothing was run';
    return record;
  }

  record.licence = await readLicence(route.modelId, location.usable.path);
  const targets = [route.target, ...(route.controlTarget ? [route.controlTarget] : [])];
  record.controlToken = await probeControlToken(route.modelId, location.usable.path, targets);

  const provider = buildProvider(OpusMtProvider, route, location);
  try {
    // Cold start: interpreter spawn plus model load. Timed, reported, and
    // excluded from the distribution -- production keeps the worker warm.
    const warmup = await timedTranslate(
      provider,
      translationInput(route, route.target, SAMPLE_SETS[route.source][0]),
    );
    record.coldStart = {
      latencyMs: warmup.latencyMs,
      ok: warmup.ok,
      error: warmup.ok ? null : warmup.error,
      excludedFromDistribution: true,
    };
    if (!warmup.ok) {
      record.verdict = 'failed';
      record.verdictReason = `the model would not load or translate: ${warmup.error}`;
      return record;
    }

    const sources = SAMPLE_SETS[route.source].slice(0, SAMPLE_LIMIT);
    const latencies = [];
    for (const sourceText of sources) {
      const outcome = await timedTranslate(provider, translationInput(route, route.target, sourceText));
      const sample = {
        sourceText,
        outputText: outcome.ok ? outcome.text : null,
        latencyMs: outcome.latencyMs,
        error: outcome.ok ? null : outcome.error,
        nonEmpty: outcome.ok && outcome.text.trim() !== '',
        identifiedLanguage: null,
        languageScores: null,
        languageMargin: null,
        echoJaccard: null,
        outcome: null,
        success: false,
        failureReason: null,
      };
      Object.assign(sample, classifySample(sample, route.target));
      sample.success = sample.outcome === 'in-target-language';
      if (sample.success) latencies.push(outcome.latencyMs);
      record.samples.push(sample);
    }

    summariseSamples(record);
    record.latencyMs = stats(latencies);

    // Malformed input: the interesting result is that the worker SURVIVES.
    for (const probe of MALFORMED_INPUTS) {
      const outcome = await timedTranslate(provider, translationInput(route, route.target, probe.text));
      record.malformed.push({
        id: probe.id,
        note: probe.note,
        inputLength: probe.text.length,
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        outputText: outcome.ok ? String(outcome.text).slice(0, 300) : null,
        outputLength: outcome.ok ? String(outcome.text).length : null,
        error: outcome.ok ? null : outcome.error,
      });
    }
    // The worker must still answer a normal request after the battery.
    const afterBattery = await timedTranslate(
      provider,
      translationInput(route, route.target, SAMPLE_SETS[route.source][0]),
    );
    record.workerSurvivedMalformedInput = afterBattery.ok && afterBattery.text.trim() !== '';

    // Unsupported target: the pipeline depends on this being a classified
    // rejection rather than a translation into something arbitrary.
    const unsupported = await timedTranslate(
      provider,
      translationInput(route, 'zz', SAMPLE_SETS[route.source][0]),
    );
    record.unsupportedTargetBehaviour = {
      rejected: !unsupported.ok,
      code: unsupported.code ?? null,
      error: unsupported.ok ? null : unsupported.error,
    };

    // Token steering, for group models only.
    if (route.controlTarget) {
      const primary = await timedTranslate(
        provider,
        translationInput(route, route.target, SAMPLE_SETS[route.source][0]),
      );
      const control = await timedTranslate(
        provider,
        translationInput(route, route.controlTarget, SAMPLE_SETS[route.source][0]),
      );
      record.tokenSteering = {
        controlTarget: route.controlTarget,
        primaryOutput: primary.ok ? primary.text : null,
        controlOutput: control.ok ? control.text : null,
        outputsDiffer: primary.ok && control.ok ? primary.text !== control.text : null,
        interpretation:
          primary.ok && control.ok
            ? primary.text === control.text
              ? 'IDENTICAL: the control token is not steering this model'
              : 'the control token changes the output, so it is steering the model'
            : 'not established',
      };
    }
  } finally {
    record.loadAverageAfter = loadavg().map((value) => Number(value.toFixed(2)));
    provider.dispose?.();
  }

  if (record.successRate === 1) {
    record.verdict = 'all-samples-in-target-language';
  } else if (record.successCount === 0) {
    record.verdict = 'failed';
  } else {
    record.verdict = 'partial';
  }
  record.verdictReason =
    `${record.successCount}/${record.sampleCount} samples were non-empty, not an echo of the input, ` +
    `and identified as ${route.target}`;
  return record;
}

/**
 * Re-decide every stored sample with the CURRENT judge, without translating
 * anything again.
 *
 * Inference costs minutes per route and the language identifier is a pure
 * function of text that is already saved. When the identifier is corrected --
 * as it was, once, after it confused a Portuguese sentence for a French one on
 * a shared circumflex -- re-running the models would change the latency
 * numbers for no reason and invite the suspicion that the run was repeated
 * until it passed. Re-judging the same recorded outputs cannot do that: the
 * sentences are fixed, only the verdict moves, and the report says so.
 */
function reclassifyReport(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  for (const record of report.routes) {
    const latencies = [];
    for (const sample of record.samples ?? []) {
      Object.assign(sample, classifySample(sample, record.targetLanguage));
      sample.success = sample.outcome === 'in-target-language';
      if (sample.success) latencies.push(sample.latencyMs);
    }
    if (!record.samples || record.samples.length === 0) continue;
    summariseSamples(record);
    record.latencyMs = stats(latencies);
    record.verdict =
      record.successRate === 1
        ? 'all-samples-in-target-language'
        : record.successCount === 0
          ? 'failed'
          : 'partial';
    record.verdictReason =
      `${record.successCount}/${record.sampleCount} samples were non-empty, not an echo of the ` +
      `input, and identified as ${record.targetLanguage}`;
  }
  report.reclassifiedAt = new Date().toISOString();
  report.reclassificationNote =
    'Sample verdicts recomputed from the STORED model outputs with the current language ' +
    'identifier. No model was run again; latencies are the originals.';
  report.languageIdentifierCalibration = selfCheck();
  return report;
}

async function main() {
  if (process.argv.includes('--self-check')) {
    const calibration = selfCheck();
    console.log(JSON.stringify(calibration, null, 2));
    process.exit(calibration.outOfSample.wrong === 0 ? 0 : 1);
  }
  const reclassifyPath = argValue('--reclassify', '');
  if (reclassifyPath !== '') {
    const report = reclassifyReport(reclassifyPath);
    writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}
`, 'utf8');
    printTable(report);
    return;
  }
  const OpusMtProvider = await loadProviderClass();
  const report = {
    lane: 'E -- OPUS benchmarks',
    generatedAt: new Date().toISOString(),
    environment: ENVIRONMENT_LABEL,
    runtime: {
      python: PYTHON,
      distRoot: DIST_ROOT,
      nodeVersion: process.version,
      envFileLoaded: envFile.loaded,
      envNamesSeen: envFile.names.filter((name) => /^(OPUS_MT_|HF_|TRANSLATION_)/u.test(name)),
      configuredCacheRoot: CONFIGURED_CACHE,
      cacheRootsProbed: CACHE_ROOTS,
    },
    sampleSetRationale:
      'eight short conversational turns per source language (greeting, arrival time, thanks, ' +
      'whereabouts, money received, call-me-back, reassurance, sign-off); 6-9 words, one clause. ' +
      'Chosen to represent MESSAGING traffic rather than literary prose.',
    languageIdentifierCalibration: selfCheck(),
    successDefinition:
      'non-empty AND not an echo of the input (token Jaccard < 0.6) AND identified as the target ' +
      'language by the marker/orthography heuristic documented in this script',
    routes: [],
  };

  for (const route of ROUTES) {
    if (!wanted(route.id)) continue;
    process.stderr.write(`  running ${route.id} (${route.modelId})\n`);
    const record = await runRoute(OpusMtProvider, route);
    report.routes.push(record);
    const latency = record.latencyMs;
    process.stderr.write(
      `    ${record.verdict}  ${record.successCount}/${record.sampleCount}` +
        (latency ? `  median ${latency.median} ms` : '') +
        '\n',
    );
  }

  writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stderr.write(`\nwrote ${OUT_PATH}\n`);

  printTable(report);
}

function printTable(report) {
  console.log('direction  model                        n  ok  und  median  mean   max  verdict');
  for (const record of report.routes) {
    const latency = record.latencyMs;
    console.log(
      `${record.id.padEnd(10)} ${record.modelId.replace('Helsinki-NLP/', '').padEnd(26)} ` +
        `${String(record.sampleCount ?? 0).padStart(2)}  ${String(record.successCount ?? 0).padStart(2)}  ` +
        `${String(record.undeterminedCount ?? 0).padStart(3)}  ` +
        `${String(latency?.median ?? '-').padStart(6)}  ${String(latency?.mean ?? '-').padStart(5)} ` +
        `${String(latency?.max ?? '-').padStart(5)}  ${record.verdict}`,
    );
  }
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
