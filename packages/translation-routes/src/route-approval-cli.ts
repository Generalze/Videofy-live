#!/usr/bin/env node
/** @author masterzee001 */
/**
 * THE COMMAND A PERSON RUNS TO APPROVE A TRANSLATION ROUTE, AND THE ONE THEY
 * RUN AT TWO IN THE MORNING TO TURN IT OFF AGAIN.
 *
 *   npm run routes:approve -- approve --source en --target fr --scope messaging ...
 *   npm run routes:approve -- revoke  --source en --target fr --all --approver "..."
 *   npm run routes:approve -- show
 *
 * WHY A COMMAND AND NOT A PAGE. A page for an act this consequential deserves
 * its own design pass, and it would have to solve who may press the button
 * before it solved anything else. A command answers that by inheriting it: you
 * need the repository, the deployment's document and a shell on the box. What
 * the command has that a page would have to be given is an audit line written
 * into the document itself, in the same commit or the same deploy as the
 * change, where the next reader will find it without being told to look.
 *
 * EVERY FLAG IS SOMETHING A GATE DEMANDS. There is no flag here that exists to
 * be convenient. If the list looks long, that is the bar being visible: the
 * refusal prints the same list, so a person who runs this wrong learns what
 * approving a route actually costs instead of learning that it failed.
 *
 * IT REFUSES BY DEFAULT. An unknown flag, a missing value, an unreadable
 * document, a promotion that would produce a document the validator rejects --
 * all of them stop before a byte is written, with a non-zero exit code and the
 * field named.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { resolveDocumentSource, type LoadOptions } from './document-file.js';
import { writeRouteDocumentAtomically } from './document-write.js';
import {
  promoteRoute,
  revokeRoute,
  type DocumentDecision,
  type LicenceFinding,
  type PromotionRequest,
  type RevocationRequest,
} from './promotion.js';
import {
  SERVICE_SCOPES,
  isServiceScope,
  type CommercialUse,
  type RouteReviewEvidence,
  type ServiceScope,
} from './route-record.js';
import { parseRouteDocument } from './validate.js';

const REVIEW_FLAGS: Readonly<Record<string, keyof RouteReviewEvidence>> = {
  '--review-engine': 'engine',
  '--review-model': 'model',
  '--review-model-version': 'modelVersion',
  '--review-corpus-hash': 'corpusHash',
  '--review-corpus-version': 'corpusVersion',
  '--review-evaluator': 'evaluator',
  '--review-assessed-at': 'assessedAt',
  '--review-method': 'method',
  '--review-score': 'score',
  '--review-scale': 'scale',
  '--review-reference': 'evidenceReference',
};

const VALUE_FLAGS = new Set([
  '--source',
  '--target',
  '--scope',
  '--approver',
  '--at',
  '--document',
  '--licence',
  '--licence-commercial-use',
  '--licence-evidence',
  '--overturn-refusal',
  '--reason',
  ...Object.keys(REVIEW_FLAGS),
]);

const BARE_FLAGS = new Set(['--all', '--refuse', '--dry-run', '--help', '-h']);

interface Parsed {
  readonly command: string;
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
}

function parseArguments(argv: readonly string[]): Parsed | string {
  const [command, ...rest] = argv;
  if (command === undefined) return 'no command given.';
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (BARE_FLAGS.has(token)) {
      flags.add(token);
      continue;
    }
    if (!VALUE_FLAGS.has(token)) {
      return `unknown flag "${token}". Nothing was read and nothing was written.`;
    }
    const value = rest[index + 1];
    // A flag whose value is the next flag is a shell quoting mistake, and
    // swallowing it would silently approve a route against the string
    // "--approver". Refuse.
    if (value === undefined || value.startsWith('--')) {
      return `"${token}" needs a value.`;
    }
    index += 1;
    const existing = values.get(token);
    if (existing === undefined) values.set(token, [value]);
    else existing.push(value);
  }
  return { command, values, flags };
}

function single(parsed: Parsed, flag: string): string | undefined {
  return parsed.values.get(flag)?.[0];
}

function collectScopes(parsed: Parsed): ServiceScope[] | string {
  const raw = parsed.values.get('--scope') ?? [];
  const scopes: ServiceScope[] = [];
  for (const value of raw) {
    if (!isServiceScope(value)) {
      return `"${value}" is not a service scope. Use one or more of ${SERVICE_SCOPES.join(', ')}.`;
    }
    if (!scopes.includes(value)) scopes.push(value);
  }
  return scopes;
}

/**
 * The review block, assembled only if ANY of its flags were given. Giving none
 * means "the document already records a passed review"; giving some means the
 * promoter is recording one now, and a partial block is refused by
 * `promoteRoute` with each missing field named.
 */
function collectReviewEvidence(parsed: Parsed): RouteReviewEvidence | undefined | string {
  const supplied = Object.keys(REVIEW_FLAGS).filter((flag) => parsed.values.has(flag));
  if (supplied.length === 0) return undefined;
  const score = single(parsed, '--review-score');
  const parsedScore = score === undefined ? Number.NaN : Number(score);
  if (!Number.isFinite(parsedScore)) {
    return '--review-score must be a number, on the scale --review-scale names.';
  }
  const text = (flag: string): string => single(parsed, flag) ?? '';
  return {
    engine: text('--review-engine'),
    model: text('--review-model'),
    modelVersion: text('--review-model-version'),
    corpusHash: text('--review-corpus-hash'),
    corpusVersion: text('--review-corpus-version'),
    evaluator: text('--review-evaluator'),
    assessedAt: text('--review-assessed-at'),
    method: text('--review-method'),
    score: parsedScore,
    scale: text('--review-scale'),
    evidenceReference: text('--review-reference'),
  };
}

function collectLicence(parsed: Parsed): LicenceFinding | undefined | string {
  const use = single(parsed, '--licence-commercial-use');
  const evidence = single(parsed, '--licence-evidence');
  const identifier = single(parsed, '--licence');
  if (use === undefined && evidence === undefined && identifier === undefined) return undefined;
  if (use === undefined || evidence === undefined) {
    return 'a licence finding needs both --licence-commercial-use and --licence-evidence; a claim without its source is a guess.';
  }
  if (use !== 'permitted' && use !== 'restricted' && use !== 'unknown') {
    return '--licence-commercial-use must be permitted, restricted or unknown.';
  }
  const finding: LicenceFinding = { commercialUse: use as CommercialUse, evidence };
  return identifier === undefined ? finding : { ...finding, licence: identifier };
}

function report(decision: DocumentDecision): void {
  if (decision.ok) return;
  process.stderr.write('REFUSED. Nothing was written.\n\n');
  for (const problem of decision.problems) {
    process.stderr.write(problem.path === '' ? `  ${problem.message}\n` : `  ${problem.path}\n    ${problem.message}\n`);
  }
  process.stderr.write('\n');
}

const USAGE = `translation route approval

  approve  --source <tag> --target <tag> --scope <scope> [--scope <scope>]
           --approver <name> [--at <iso>]
           [--review-engine ... --review-model ... --review-model-version ...
            --review-corpus-hash ... --review-corpus-version ...
            --review-evaluator ... --review-assessed-at <iso>
            --review-method ... --review-score <n> --review-scale ...
            --review-reference ...]
           [--licence <id>] [--licence-commercial-use permitted|restricted|unknown]
           [--licence-evidence <where it was read>]
           [--overturn-refusal <reason>] [--document <path>] [--dry-run]

  revoke   --source <tag> --target <tag> (--scope <scope> ... | --all)
           --approver <name> [--at <iso>] [--reason <why>] [--refuse]
           [--document <path>] [--dry-run]

  show     [--document <path>]

Scopes: ${SERVICE_SCOPES.join(', ')}. Approval for one is never approval for
another. Revocation demands no evidence and is always allowed.
`;

function showDocument(document: unknown): number {
  const parsed = parseRouteDocument(document);
  if (!parsed.ok) {
    process.stderr.write('This document does not validate, so no service will load it:\n\n');
    for (const problem of parsed.problems) {
      process.stderr.write(`  ${problem.path}\n    ${problem.message}\n`);
    }
    return 1;
  }
  for (const route of parsed.document.routes) {
    const approved = SERVICE_SCOPES.filter((scope) => route.serviceScopes[scope] === 'approved');
    process.stdout.write(
      `${route.sourceLanguage}->${route.targetLanguage}  ${route.provider}  ` +
        `review=${route.humanReviewStatus}  licence=${route.licenceStatus.commercialUse}  ` +
        `${approved.length === 0 ? 'NO APPROVED SCOPE' : `approved: ${approved.join(', ')}`}\n`,
    );
  }
  return 0;
}

export function runRouteApprovalCli(argv: readonly string[]): number {
  const parsed = parseArguments(argv);
  if (typeof parsed === 'string') {
    process.stderr.write(`REFUSED. ${parsed}\n\n${USAGE}`);
    return 1;
  }
  if (parsed.command === 'help' || parsed.flags.has('--help') || parsed.flags.has('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!['approve', 'revoke', 'show'].includes(parsed.command)) {
    process.stderr.write(`REFUSED. "${parsed.command}" is not a command.\n\n${USAGE}`);
    return 1;
  }

  const explicit = single(parsed, '--document');
  const loadOptions: LoadOptions = explicit === undefined ? {} : { path: explicit };
  const source = resolveDocumentSource(loadOptions);
  let originalText: string;
  try {
    originalText = readFileSync(source.path, 'utf8');
  } catch (error) {
    // The PATH is printed only when the caller typed it. When it came from the
    // environment the variable NAME is named and its value never is.
    process.stderr.write(
      `REFUSED. The route document could not be read (${source.origin}): ` +
        `${(error as Error).message}\n`,
    );
    return 1;
  }
  let document: unknown;
  try {
    document = JSON.parse(originalText) as unknown;
  } catch (error) {
    process.stderr.write(`REFUSED. The route document is not valid JSON: ${(error as Error).message}\n`);
    return 1;
  }

  if (parsed.command === 'show') return showDocument(document);

  const sourceLanguage = single(parsed, '--source');
  const targetLanguage = single(parsed, '--target');
  const approver = single(parsed, '--approver');
  if (sourceLanguage === undefined || targetLanguage === undefined || approver === undefined) {
    process.stderr.write(
      'REFUSED. --source, --target and --approver are required. A decision nobody signed is ' +
        `not auditable.\n\n${USAGE}`,
    );
    return 1;
  }
  const decidedAt = single(parsed, '--at') ?? new Date().toISOString();
  const scopes = collectScopes(parsed);
  if (typeof scopes === 'string') {
    process.stderr.write(`REFUSED. ${scopes}\n`);
    return 1;
  }

  let decision: DocumentDecision;
  if (parsed.command === 'approve') {
    const review = collectReviewEvidence(parsed);
    if (typeof review === 'string') {
      process.stderr.write(`REFUSED. ${review}\n`);
      return 1;
    }
    const licence = collectLicence(parsed);
    if (typeof licence === 'string') {
      process.stderr.write(`REFUSED. ${licence}\n`);
      return 1;
    }
    const overturn = single(parsed, '--overturn-refusal');
    let request: PromotionRequest = {
      sourceLanguage,
      targetLanguage,
      scopes,
      approver,
      decidedAt,
    };
    if (review !== undefined) request = { ...request, reviewEvidence: review };
    if (licence !== undefined) request = { ...request, licence };
    if (overturn !== undefined) request = { ...request, overturnRefusalReason: overturn };
    decision = promoteRoute(document, request);
  } else {
    if (scopes.length === 0 && !parsed.flags.has('--all')) {
      process.stderr.write(
        'REFUSED. Say which scopes to withdraw with --scope, or --all to withdraw every one. ' +
          'Guessing at the blast radius of a revocation is not this tool\'s job.\n',
      );
      return 1;
    }
    const reason = single(parsed, '--reason');
    let request: RevocationRequest = {
      sourceLanguage,
      targetLanguage,
      scopes: parsed.flags.has('--all') ? [] : scopes,
      approver,
      decidedAt,
    };
    if (reason !== undefined) request = { ...request, reason };
    if (parsed.flags.has('--refuse')) request = { ...request, markRefused: true };
    decision = revokeRoute(document, request);
  }

  if (!decision.ok) {
    report(decision);
    return 1;
  }
  if (!decision.changed) {
    process.stdout.write(`${decision.summary}\n`);
    return 0;
  }
  if (parsed.flags.has('--dry-run')) {
    process.stdout.write(`DRY RUN, nothing written. Would be true: ${decision.summary}\n`);
    return 0;
  }

  const written = writeRouteDocumentAtomically(source.path, decision.document, originalText);
  if (!written.ok) {
    report({ ok: false, problems: written.problems });
    return 1;
  }
  process.stdout.write(
    `${decision.summary}\nWritten and re-validated (${String(written.bytesWritten)} bytes). ` +
      'Every service that reads this document must be restarted before it takes effect.\n',
  );
  return 0;
}

/*
 * Only when invoked as a command, so importing this in a test runs nothing.
 * Compared as file URLs rather than as paths: on Windows the two differ in
 * separator and drive-letter case, and a string comparison there would either
 * never fire or fire on an import.
 */
const invokedAs = process.argv[1];
if (invokedAs !== undefined && pathToFileURL(invokedAs).href === import.meta.url) {
  process.exitCode = runRouteApprovalCli(process.argv.slice(2));
}
