/** @author masterzee001 */
/**
 * Print the QA set definition for a packet in docs/certification/review-packets,
 * as the JSON body `POST /admin/language-specialists/qa-sets` takes.
 *
 * It prints; it does not post. Publishing a set is an operator act behind the
 * platform allowlist and live verification, and this script has neither. The
 * operator reads what it printed, then sends it with their own session:
 *
 *   npx tsx src/qa-set-packet-cli.ts --language fr \
 *     --review ../../docs/certification/review-packets/review-fr.csv \
 *     --version review-packets/2026-09-25 \
 *     --single-engine opus \
 *     --engine 'opus@en->fr=opus-mt/Helsinki-NLP/opus-mt-en-fr@dd7f6540' \
 *     --engine 'opus@fr->en=opus-mt/Helsinki-NLP/opus-mt-fr-en@c4aed37b' > fr.json
 *
 *   npx tsx src/qa-set-packet-cli.ts --language yo \
 *     --review ../../docs/certification/review-packets/review-yo.csv \
 *     --answer-key ../../docs/certification/review-packets/ANSWER-KEY-yo.csv \
 *     --version review-packets/2026-08-31 \
 *     --engine 'opus@en->yo=opus-mt/Helsinki-NLP/opus-mt-en-alv@<rev>' \
 *     --engine 'opus@yo->en=opus-mt/Helsinki-NLP/opus-mt-yo-en@<rev>' \
 *     --engine 'm2m100@*=m2m100/facebook/m2m100_418M@<rev>' > yo.json
 *
 * `--engine TAG@DIRECTION=PROVIDER/MODEL@VERSION`. The model id may itself
 * contain a slash (Helsinki-NLP/...), so the split is on the FIRST slash and
 * the LAST at-sign. The version is what the evidence will cite as
 * modelVersion; it is not looked up anywhere, because the person publishing
 * the set is the person asserting which build was run.
 */
import { readFileSync } from 'node:fs';
import { packetToQaSetDefinition, type EngineMapping } from './qa-set-packets.js';

function parseArgs(argv: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (!flag.startsWith('--')) throw new Error(`unexpected argument ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    out.set(flag, [...(out.get(flag) ?? []), value]);
    index += 1;
  }
  return out;
}

function single(args: Map<string, string[]>, flag: string): string | undefined {
  const values = args.get(flag);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new Error(`${flag} given more than once`);
  return values[0];
}

export function parseEngineFlag(value: string): { tag: string; direction: string; provider: string; model: string; modelVersion: string } {
  const eq = value.indexOf('=');
  if (eq < 0) throw new Error(`--engine "${value}" is not TAG@DIRECTION=PROVIDER/MODEL@VERSION`);
  const left = value.slice(0, eq);
  const right = value.slice(eq + 1);
  const leftAt = left.indexOf('@');
  if (leftAt < 0) throw new Error(`--engine "${value}" names no direction (use * for any)`);
  const tag = left.slice(0, leftAt);
  const direction = left.slice(leftAt + 1);
  const slash = right.indexOf('/');
  const rightAt = right.lastIndexOf('@');
  if (slash < 0 || rightAt < slash) {
    throw new Error(`--engine "${value}" needs PROVIDER/MODEL@VERSION on the right`);
  }
  const provider = right.slice(0, slash);
  const model = right.slice(slash + 1, rightAt);
  const modelVersion = right.slice(rightAt + 1);
  if ([tag, direction, provider, model, modelVersion].some((part) => part.length === 0)) {
    throw new Error(`--engine "${value}" has an empty part`);
  }
  return { tag, direction, provider, model, modelVersion };
}

export function main(argv: readonly string[]): string {
  const args = parseArgs(argv);
  const language = single(args, '--language');
  const review = single(args, '--review');
  const version = single(args, '--version');
  if (language === undefined || review === undefined || version === undefined) {
    throw new Error('--language, --review and --version are required');
  }
  const answerKey = single(args, '--answer-key');
  const singleEngine = single(args, '--single-engine');
  const engines: Record<string, Record<string, { provider: string; model: string; modelVersion: string }>> = {};
  for (const raw of args.get('--engine') ?? []) {
    const parsed = parseEngineFlag(raw);
    const byDirection = engines[parsed.tag] ?? {};
    byDirection[parsed.direction] = {
      provider: parsed.provider,
      model: parsed.model,
      modelVersion: parsed.modelVersion,
    };
    engines[parsed.tag] = byDirection;
  }
  const result = packetToQaSetDefinition({
    language,
    version,
    sourceReference: single(args, '--source-reference') ?? review,
    reviewCsv: readFileSync(review, 'utf8'),
    ...(answerKey === undefined ? {} : { answerKeyCsv: readFileSync(answerKey, 'utf8') }),
    ...(singleEngine === undefined ? {} : { singleEngineTag: singleEngine }),
    engines: engines as EngineMapping,
  });
  if (!result.ok) {
    throw new Error(`the packet could not be read:\n  ${result.problems.join('\n  ')}`);
  }
  return JSON.stringify(result.definition, null, 2);
}

if (process.argv[1]?.endsWith('qa-set-packet-cli.ts') || process.argv[1]?.endsWith('qa-set-packet-cli.js')) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
