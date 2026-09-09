#!/usr/bin/env node
/** @author masterzee001 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GOOGLE_CREDENTIALS_PATH = '/etc/videofy/google-translation.json';
const DIRECTIONS = ['en->yo', 'yo->en', 'en->ig', 'ig->en', 'en->ha', 'ha->en'];
const DEFAULT_TIMEOUT_MS = 10_000;

const CORPUS = {
  'en->yo': [
    ['en-yo-01', 'Good morning, has the meeting started?'],
    ['en-yo-02', 'Please send the receipt before four o clock.'],
    ['en-yo-03', 'I have received the money, thank you.'],
    ['en-yo-04', 'We will see each other tomorrow morning.'],
    ['en-yo-05', 'The children are waiting at the school gate.'],
    ['en-yo-06', 'Do not share the access code with anyone.'],
    ['en-yo-07', 'The doctor will call after the test result arrives.'],
    ['en-yo-08', 'Our office moved from Ikeja to Yaba last week.'],
  ],
  'yo->en': [
    ['yo-en-01', 'E kaaro, se ipade ti bere?'],
    ['yo-en-02', 'Jowo fi risiti ranse ki ago merin to ku.'],
    ['yo-en-03', 'Mo ti gba owo naa, e se.'],
    ['yo-en-04', 'A o ri ara wa ni owuro ola.'],
    ['yo-en-05', 'Awon omode n duro ni enu ona ile iwe.'],
    ['yo-en-06', 'Ma pin koodu wiwolu pelu enikeni.'],
    ['yo-en-07', 'Dokita yoo pe leyin ti esi idanwo ba de.'],
    ['yo-en-08', 'Ofisi wa gbe lati Ikeja si Yaba lose to koja.'],
  ],
  'en->ig': [
    ['en-ig-01', 'Good morning, has the meeting started?'],
    ['en-ig-02', 'Please send the receipt before four o clock.'],
    ['en-ig-03', 'I have received the money, thank you.'],
    ['en-ig-04', 'We will see each other tomorrow morning.'],
    ['en-ig-05', 'The children are waiting at the school gate.'],
    ['en-ig-06', 'Do not share the access code with anyone.'],
    ['en-ig-07', 'The doctor will call after the test result arrives.'],
    ['en-ig-08', 'Our office moved from Ikeja to Yaba last week.'],
  ],
  'ig->en': [
    ['ig-en-01', 'Ututu oma, nzuko amalitela?'],
    ['ig-en-02', 'Biko zipu risiti tupu elekere ano.'],
    ['ig-en-03', 'Enwetala m ego ahu, daalu.'],
    ['ig-en-04', 'Anyi ga ahu onwe anyi echi ututu.'],
    ['ig-en-05', 'Umuaka na-eche n onu uzo ulo akwukwo.'],
    ['ig-en-06', 'Ekesala koodu nbanye ahu nye onye obula.'],
    ['ig-en-07', 'Dọkịta ga-akpọ mgbe nsonaazụ ule rutere.'],
    ['ig-en-08', 'Ofis anyi siri Ikeja kwaga Yaba izu gara aga.'],
  ],
  'en->ha': [
    ['en-ha-01', 'Good morning, has the meeting started?'],
    ['en-ha-02', 'Please send the receipt before four o clock.'],
    ['en-ha-03', 'I have received the money, thank you.'],
    ['en-ha-04', 'We will see each other tomorrow morning.'],
    ['en-ha-05', 'The children are waiting at the school gate.'],
    ['en-ha-06', 'Do not share the access code with anyone.'],
    ['en-ha-07', 'The doctor will call after the test result arrives.'],
    ['en-ha-08', 'Our office moved from Ikeja to Yaba last week.'],
  ],
  'ha->en': [
    ['ha-en-01', 'Ina kwana, an fara taron?'],
    ['ha-en-02', 'Don Allah aika rasit kafin karfe hudu.'],
    ['ha-en-03', 'Na karbi kudin, na gode.'],
    ['ha-en-04', 'Za mu ga juna gobe da safe.'],
    ['ha-en-05', 'Yara suna jira a kofar makaranta.'],
    ['ha-en-06', 'Kada ka raba lambar shiga da kowa.'],
    ['ha-en-07', 'Likita zai kira bayan sakamakon gwaji ya iso.'],
    ['ha-en-08', 'Ofishinmu ya koma daga Ikeja zuwa Yaba makon da ya gabata.'],
  ],
};

function parseArgs(argv) {
  const out = { engine: 'google', compare: null, warmup: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--engine') out.engine = valueAfter(argv, ++index, arg);
    else if (arg === '--out') out.out = valueAfter(argv, ++index, arg);
    else if (arg === '--dist') out.dist = valueAfter(argv, ++index, arg);
    else if (arg === '--project') out.project = valueAfter(argv, ++index, arg);
    else if (arg === '--credentials') out.credentials = valueAfter(argv, ++index, arg);
    else if (arg === '--quota-project') out.quotaProject = valueAfter(argv, ++index, arg);
    else if (arg === '--location') out.location = valueAfter(argv, ++index, arg);
    else if (arg === '--timeout-ms') out.timeoutMs = Number(valueAfter(argv, ++index, arg));
    else if (arg === '--samples') out.samples = Number(valueAfter(argv, ++index, arg));
    else if (arg === '--only') out.only = valueAfter(argv, ++index, arg);
    else if (arg === '--env') out.envFile = valueAfter(argv, ++index, arg);
    else if (arg === '--compare') {
      out.compare = [valueAfter(argv, ++index, arg), valueAfter(argv, ++index, arg)];
    } else if (arg === '--no-warmup') out.warmup = false;
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function valueAfter(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function usage() {
  console.log(`Usage:
  node scripts/nigerian-translation-screen.mjs --engine google --out google.json
  node scripts/nigerian-translation-screen.mjs --engine opus --out opus.json
  node scripts/nigerian-translation-screen.mjs --compare google.json opus.json

Options:
  --samples N       measured samples per direction, default all corpus rows
  --only a,b        comma-separated directions, e.g. en->yo,yo->en
  --timeout-ms N    provider timeout, default ${DEFAULT_TIMEOUT_MS}
  --dist PATH       media-ingest dist src path
  --env PATH        env file to load before reading variables
  --no-warmup       skip the unmeasured warm-up request per direction

Google reads GOOGLE_TRANSLATE_PROJECT_ID and credentials from
GOOGLE_TRANSLATE_CREDENTIALS_FILE, GOOGLE_APPLICATION_CREDENTIALS, or
${GOOGLE_CREDENTIALS_PATH}. Values are never printed.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.envFile) loadEnvFile(args.envFile);
  if (args.compare) {
    const report = compareReports(args.compare[0], args.compare[1]);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.engine !== 'google' && args.engine !== 'opus') {
    throw new Error('--engine must be google or opus.');
  }
  const directions = selectedDirections(args.only);
  const provider = await createProvider(args);
  const report = {
    generatedAt: new Date().toISOString(),
    engine: args.engine,
    routeSet: 'nigerian-en-yo-ig-ha',
    warmup: args.warmup,
    environment: {
      projectIdConfigured: Boolean(args.project || process.env.GOOGLE_TRANSLATE_PROJECT_ID),
      credentialConfigured: Boolean(
        args.credentials ||
          process.env.GOOGLE_TRANSLATE_CREDENTIALS_FILE ||
          process.env.GOOGLE_APPLICATION_CREDENTIALS,
      ),
      credentialDefaultPath: args.engine === 'google' ? GOOGLE_CREDENTIALS_PATH : null,
    },
    routes: [],
  };

  for (const direction of directions) {
    const route = await measureDirection(provider, direction, args);
    report.routes.push(route);
    console.error(
      `${args.engine} ${direction}: success ${route.successCount}/${route.sampleCount}, p95 ${route.latencyMs.p95} ms`,
    );
  }
  provider.dispose?.();

  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    writeFileSync(resolve(args.out), `${json}\n`, 'utf8');
  } else {
    console.log(json);
  }
}

function selectedDirections(raw) {
  if (!raw) return DIRECTIONS;
  const selected = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const direction of selected) {
    if (!DIRECTIONS.includes(direction)) throw new Error(`Unsupported direction: ${direction}`);
  }
  return selected;
}

async function createProvider(args) {
  const dist = resolve(args.dist ?? 'services/media-ingest/dist/services/media-ingest/src');
  const translationModule = await importBuilt(dist, 'translation-provider.js');
  if (args.engine === 'google') {
    const googleModule = await importBuilt(dist, 'providers/google/translation.js');
    const projectId = args.project || process.env.GOOGLE_TRANSLATE_PROJECT_ID;
    if (!projectId) {
      throw new Error('Google screen requires GOOGLE_TRANSLATE_PROJECT_ID or --project.');
    }
    return new googleModule.GoogleTimestampedTranslationProvider({
      projectId,
      credentialsFile:
        args.credentials ||
        process.env.GOOGLE_TRANSLATE_CREDENTIALS_FILE ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        GOOGLE_CREDENTIALS_PATH,
      quotaProjectId: args.quotaProject || process.env.GOOGLE_CLOUD_QUOTA_PROJECT || null,
      location: args.location || process.env.GOOGLE_TRANSLATE_LOCATION || 'global',
      timeoutMs: providerTimeoutMs(args),
    });
  }

  const configModule = await importBuilt(dist, 'config.js');
  return new translationModule.OpusMtTimestampedTranslationProvider({
    pythonExecutable:
      process.env.OPUS_MT_PYTHON ||
      process.env.AI_PYTHON_EXECUTABLE ||
      process.env.ARGOS_TRANSLATE_PYTHON ||
      'python',
    modelCacheDir: process.env.OPUS_MT_MODEL_CACHE_DIR || null,
    supportedTargetLanguages: ['yo', 'ig', 'ha', 'en'],
    languageModels: parseOpusModels(
      process.env.OPUS_MT_LANGUAGE_MODELS || configModule.DEFAULT_OPUS_MT_LANGUAGE_MODELS,
    ),
    timeoutMs: providerTimeoutMs(args),
    maxConcurrency: positiveInt(process.env.OPUS_MT_MAX_CONCURRENCY, 1),
    allowModelDownload: String(process.env.OPUS_MT_ALLOW_MODEL_DOWNLOAD || 'false').toLowerCase() === 'true',
  });
}

async function importBuilt(dist, relativePath) {
  const file = resolve(dist, relativePath);
  if (!existsSync(file)) {
    throw new Error(
      `Missing ${file}. Build first with: npm run build -w @videofy-live/media-ingest`,
    );
  }
  return await import(pathToFileURL(file).href);
}

async function measureDirection(provider, direction, args) {
  const [sourceLanguage, targetLanguage] = direction.split('->');
  const rows = CORPUS[direction].slice(0, args.samples || CORPUS[direction].length);
  if (args.warmup && rows[0]) {
    await provider
      .translate(inputFor(rows[0], sourceLanguage, targetLanguage, 'warmup'))
      .catch(() => {});
  }

  const samples = [];
  for (const row of rows) {
    const started = Date.now();
    try {
      const result = await provider.translate(inputFor(row, sourceLanguage, targetLanguage, 'screen'));
      const latencyMs = result.providerLatencyMs ?? Date.now() - started;
      samples.push({
        id: row[0],
        ok: true,
        latencyMs,
        sourceLength: row[1].length,
        outputLength: result.translatedText.length,
        providerName: result.providerName ?? provider.name,
        modelId: result.modelId ?? null,
      });
    } catch (error) {
      samples.push({
        id: row[0],
        ok: false,
        latencyMs: Date.now() - started,
        sourceLength: row[1].length,
        outputLength: 0,
        failureCode: error?.code ?? 'translation-failed',
        failureMessage: safeMessage(error),
      });
    }
  }
  const latencies = samples.filter((sample) => sample.ok).map((sample) => sample.latencyMs);
  return {
    direction,
    sourceLanguage,
    targetLanguage,
    provider: provider.name,
    sampleCount: samples.length,
    successCount: samples.filter((sample) => sample.ok).length,
    failureCount: samples.filter((sample) => !sample.ok).length,
    successRate: samples.length === 0 ? 0 : samples.filter((sample) => sample.ok).length / samples.length,
    latencyMs: latencySummary(latencies),
    samples,
  };
}

function inputFor(row, sourceLanguage, targetLanguage, sessionId) {
  return {
    sessionId,
    streamId: 'nigerian-translation-screen',
    segmentId: row[0],
    sequence: 0,
    sourceLanguage,
    targetLanguage,
    sourceText: row[1],
    routeProvider: undefined,
    startMs: 0,
    endMs: 1000,
  };
}

function latencySummary(values) {
  if (values.length === 0) return { min: null, median: null, mean: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    median: percentile(sorted, 0.5),
    mean: Math.round(sum / sorted.length),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function compareReports(googlePath, opusPath) {
  const google = JSON.parse(readFileSync(resolve(googlePath), 'utf8'));
  const opus = JSON.parse(readFileSync(resolve(opusPath), 'utf8'));
  const opusRoutes = new Map(opus.routes.map((route) => [route.direction, route]));
  const routes = google.routes.map((route) => {
    const baseline = opusRoutes.get(route.direction);
    const googleP95 = route.latencyMs.p95;
    const opusP95 = baseline?.latencyMs?.p95 ?? null;
    return {
      direction: route.direction,
      googleP95,
      opusP95,
      googleSuccessRate: route.successRate,
      opusSuccessRate: baseline?.successRate ?? null,
      googleFaster: typeof googleP95 === 'number' && typeof opusP95 === 'number' && googleP95 < opusP95,
      successRateNotWorse:
        typeof baseline?.successRate === 'number' && route.successRate >= baseline.successRate,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    googleReport: googlePath,
    opusReport: opusPath,
    googlePrimaryLatencyEligible: routes.every((route) => route.googleFaster),
    googlePrimarySuccessEligible: routes.every((route) => route.successRateNotWorse),
    routes,
  };
}

function parseOpusModels(raw) {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sourceLanguage, targetLanguage, modelId, ...localPathParts] = entry.split(':');
      if (!sourceLanguage || !targetLanguage || !modelId) {
        throw new Error('OPUS_MT_LANGUAGE_MODELS entries must use source:target:modelId[:localPath].');
      }
      return {
        sourceLanguage: sourceLanguage.toLowerCase(),
        targetLanguage: targetLanguage.toLowerCase(),
        modelId,
        localPath: localPathParts.join(':') || null,
      };
    });
}

function providerTimeoutMs(args) {
  const envTimeout =
    args.engine === 'opus' ? process.env.TRANSLATION_TIMEOUT_MS : process.env.GOOGLE_TRANSLATE_TIMEOUT_MS;
  const value = args.timeoutMs ?? positiveInt(envTimeout, DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(value) || value < 1) throw new Error('--timeout-ms must be a positive integer.');
  return value;
}

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function loadEnvFile(path) {
  const content = readFileSync(resolve(path), 'utf8');
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/gu, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
      '[redacted private key]',
    )
    .replace(/"private_key"\s*:\s*"[^"]+"/giu, '"private_key":"[redacted]"')
    .slice(0, 240);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
