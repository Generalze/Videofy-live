#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Refuse source that prints a credential.
 *
 * Founder ruling (LOCKED, 29 Aug 2026): "ensure no token, token prefix,
 * decoded token body, account identifier derived from a token, or
 * authorization header is ever printed."
 *
 * A log line is the one place a secret escapes every other control: it is
 * shipped, indexed, retained and readable by far more people than can read
 * the database. This guard looks at every logging call in the tree and
 * refuses a SMALL set of high-precision shapes:
 *
 *   console.log(token)                      a bare credential identifier
 *   logger.info('x', { token })             shorthand property of one
 *   logger.info('x', { token: session.token })
 *   console.log(`... ${sessionToken} ...`)  interpolated into the message
 *   Log.i(TAG, "... $token ...")            Kotlin interpolation
 *   console.log(token.slice(0, 8))          a "diagnostic" prefix
 *   logger.warn(req.header('authorization'))
 *   console.log(JSON.stringify(credential))
 *
 * Length and presence are fine: `{ tokenLength: token.length }` and
 * `{ token: token !== undefined }` pass. Recall is deliberately traded for
 * precision — a guard that cries wolf gets a blanket allowlist and then
 * guards nothing.
 *
 * A legitimate site (a test asserting a token is NOT in some output, say)
 * carries the marker on the call's first line or the line before it:
 *
 *   // token-logging: allowed (<reason>)
 *
 * Output is file:line only. The offending line is never echoed, because if
 * the guard is right the line contains the thing that must not be printed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();

/** The lanes scanned. Kotlin is walked directly: android/ is gitignored. */
const SCOPES = [
  { dir: 'services', nested: 'src', extensions: ['.ts', '.tsx'] },
  { dir: 'packages', nested: 'src', extensions: ['.ts', '.tsx'] },
  { dir: 'apps', nested: 'src', extensions: ['.ts', '.tsx'] },
  { dir: 'scripts', nested: null, extensions: ['.mjs'] },
  { dir: join('apps', 'mobile', 'modules'), nested: null, extensions: ['.kt'] },
];

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

const ALLOW_MARKER = /\/\/\s*token-logging:\s*allowed\s*\(/;

/** Names that are a credential wherever they appear. */
const SENSITIVE_NAMES = new Set([
  'token',
  'sessionToken',
  'accessToken',
  'refreshToken',
  'joinToken',
  'connectToken',
  'pushToken',
  'deviceToken',
  'expoPushToken',
  'fcmToken',
  'ringToken',
  'resetToken',
  'inviteToken',
  'bearer',
  'bearerToken',
  'authorization',
  'authHeader',
  'authorizationHeader',
  'credential',
  'credentials',
  'ringCredential',
  'apiKey',
  'api_key',
  'secret',
  'sessionSecret',
  'clientSecret',
  'password',
  'verificationCode',
  'otp',
]);

/** `hasToken`, `noCredential`, `isSecret` describe a fact, not a value. */
const FACT_PREFIX = /^(has|is|no|with|without|needs|missing|wants|requires|should|can|allow|use|expects|valid|invalid|bad|same)[A-Z_]/;

function isSensitiveName(name) {
  if (SENSITIVE_NAMES.has(name)) return true;
  if (!/(Token|Secret|Credential)$/.test(name)) return false;
  return !FACT_PREFIX.test(name);
}

/** Where a log call starts. Kotlin's android.util.Log is the single-letter set. */
const LOG_CALL =
  /\b(?:console|logger|log|Log|this\.logger|this\.log|process\.(?:stdout|stderr))\.(?:log|info|warn|error|debug|trace|verbose|write|d|i|w|e|v|wtf)\s*\(/g;

/**
 * The end of the argument list that starts just after `open`, or -1.
 *
 * Strings, template literals (with nested `${}`), and comments are skipped so
 * a parenthesis inside a message does not run the span into the next
 * statement — where an innocent identifier would become a false positive.
 */
function argumentSpanEnd(text, open) {
  let depth = 1;
  let index = open;
  const stack = [];
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    const mode = stack[stack.length - 1];

    if (mode === 'line-comment') {
      if (character === '\n') stack.pop();
      index += 1;
      continue;
    }
    if (mode === 'block-comment') {
      if (character === '*' && next === '/') {
        stack.pop();
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (mode === "'" || mode === '"') {
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character === mode || character === '\n') stack.pop();
      index += 1;
      continue;
    }
    if (mode === '`') {
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character === '`') {
        stack.pop();
        index += 1;
        continue;
      }
      if (character === '$' && next === '{') {
        stack.push('template-expression');
        stack.push(0);
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    // Code, either at the top level or inside a `${ }` of a template.
    if (character === '/' && next === '/') {
      stack.push('line-comment');
      index += 2;
      continue;
    }
    if (character === '/' && next === '*') {
      stack.push('block-comment');
      index += 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      stack.push(character);
      index += 1;
      continue;
    }
    if (typeof mode === 'number') {
      if (character === '{') stack[stack.length - 1] = mode + 1;
      else if (character === '}') {
        if (mode === 0) {
          stack.pop();
          stack.pop();
        } else stack[stack.length - 1] = mode - 1;
      }
      index += 1;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/** Top-level comma split of an argument list, honouring brackets and strings. */
function splitArguments(span) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < span.length; index += 1) {
    const character = span[index];
    if (quote !== null) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(span.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(span.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

const MEMBER = /^(?:[A-Za-z_$][\w$]*\??\.)*([A-Za-z_$][\w$]*)$/;

/** `token`, `session.token`, `req.headers.authorization` — the value itself. */
function isSensitiveExpression(expression) {
  const trimmed = expression.trim().replace(/!$/, '');
  const member = MEMBER.exec(trimmed);
  return member !== null && isSensitiveName(member[1]);
}

const HEADER_READ =
  /\b(?:headers?\s*\(\s*['"]authorization['"]\s*\)|headers\s*\.\s*authorization\b|headers\s*\[\s*['"]authorization['"]\s*\]|headers\s*\.\s*get\s*\(\s*['"]authorization['"]\s*\)|handshake\s*\.\s*auth\b)/;

const SLICED = /\b((?:[A-Za-z_$][\w$]*\??\.)*[A-Za-z_$][\w$]*)\s*\.\s*(?:slice|substring|substr)\s*\(/g;

const STRINGIFIED = /\bJSON\s*\.\s*stringify\s*\(\s*((?:[A-Za-z_$][\w$]*\??\.)*[A-Za-z_$][\w$]*)\s*\)/g;

const INTERPOLATED = /\$\{\s*((?:[A-Za-z_$][\w$]*\??\.)*[A-Za-z_$][\w$]*)\s*\}/g;

/** Kotlin: `$token` and `${credential.token}` inside a string. */
const KOTLIN_INTERPOLATED = /\$(?:\{\s*((?:[A-Za-z_][\w]*\??\.)*[A-Za-z_][\w]*)\s*\}|([A-Za-z_][\w]*))/g;

const SHORTHAND = /[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g;

const KEYED = /\b([A-Za-z_$][\w$]*)\s*:\s*((?:[A-Za-z_$][\w$]*\??\.)*[A-Za-z_$][\w$]*)\s*(?=[,}])/g;

function spanIsALeak(span, kotlin) {
  for (const argument of splitArguments(span)) {
    if (isSensitiveExpression(argument)) return true;
  }
  if (HEADER_READ.test(span)) return true;

  for (const match of span.matchAll(SLICED)) {
    if (isSensitiveExpression(match[1])) return true;
  }
  for (const match of span.matchAll(STRINGIFIED)) {
    if (isSensitiveExpression(match[1])) return true;
  }
  for (const match of span.matchAll(INTERPOLATED)) {
    if (isSensitiveExpression(match[1])) return true;
  }
  if (kotlin) {
    for (const match of span.matchAll(KOTLIN_INTERPOLATED)) {
      if (isSensitiveExpression(match[1] ?? match[2])) return true;
    }
  }
  for (const match of span.matchAll(SHORTHAND)) {
    if (isSensitiveName(match[1])) return true;
  }
  for (const match of span.matchAll(KEYED)) {
    // `{ token: token.length }` and `{ token: token !== undefined }` are
    // excluded by the lookahead: the value must END at the comma or brace.
    if (isSensitiveName(match[1]) && isSensitiveExpression(match[2])) return true;
  }
  return false;
}

/**
 * The same text with every comment blanked to spaces (newlines kept, so line
 * numbers hold). A call shape quoted in a comment — this file's own header,
 * for one — is documentation, not a print.
 */
function blankComments(text) {
  const out = text.split('');
  const stack = [];
  let index = 0;
  const blank = (from, to) => {
    for (let at = from; at < to; at += 1) if (out[at] !== '\n') out[at] = ' ';
  };
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    const mode = stack[stack.length - 1];
    if (mode === "'" || mode === '"') {
      if (character === '\\') index += 2;
      else {
        if (character === mode || character === '\n') stack.pop();
        index += 1;
      }
      continue;
    }
    if (mode === '`') {
      if (character === '\\') index += 2;
      else if (character === '`') {
        stack.pop();
        index += 1;
      } else if (character === '$' && next === '{') {
        stack.push(0);
        index += 2;
      } else index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      const stop = end === -1 ? text.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      stack.push(character);
      index += 1;
      continue;
    }
    if (typeof mode === 'number') {
      if (character === '{') stack[stack.length - 1] = mode + 1;
      else if (character === '}') {
        if (mode === 0) stack.pop();
        else stack[stack.length - 1] = mode - 1;
      }
    }
    index += 1;
  }
  return out.join('');
}

function lineAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text[index] === '\n') line += 1;
  return line;
}

function allowed(lines, line) {
  const here = lines[line - 1] ?? '';
  const before = lines[line - 2] ?? '';
  return ALLOW_MARKER.test(here) || ALLOW_MARKER.test(before);
}

function scan(path, source) {
  const kotlin = path.endsWith('.kt');
  const lines = source.split('\n');
  const text = blankComments(source);
  const findings = [];
  for (const match of text.matchAll(LOG_CALL)) {
    const open = match.index + match[0].length;
    const close = argumentSpanEnd(text, open);
    if (close === -1) continue;
    const span = text.slice(open, close);
    if (!spanIsALeak(span, kotlin)) continue;
    const line = lineAt(text, match.index);
    if (allowed(lines, line)) continue;
    findings.push(line);
  }
  return findings;
}

function* walk(directory, extensions) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full, extensions);
    else if (extensions.some((extension) => entry.name.endsWith(extension))) yield full;
  }
}

function* files() {
  for (const scope of SCOPES) {
    const base = join(ROOT, scope.dir);
    let exists = false;
    try {
      exists = statSync(base).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) continue;
    if (scope.nested === null) {
      yield* walk(base, scope.extensions);
      continue;
    }
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      yield* walk(join(base, entry.name, scope.nested), scope.extensions);
    }
  }
}

const findings = [];
let scanned = 0;
for (const path of files()) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;
  const shown = relative(ROOT, path).split(sep).join('/');
  for (const line of scan(path, text)) findings.push(`${shown}:${line}`);
}

if (findings.length > 0) {
  console.error(`token logging: ${findings.length} log call(s) print a credential\n`);
  for (const finding of findings.slice(0, 40)) console.error(`  ${finding}`);
  if (findings.length > 40) console.error(`  ... and ${findings.length - 40} more`);
  console.error(
    '\nLog the LENGTH or the PRESENCE, never the value or a prefix of it. A site\n' +
      'that must print one (a test asserting a token is absent, say) carries\n' +
      '  // token-logging: allowed (<reason>)\n' +
      'on the line of the call or the line before it.',
  );
  process.exit(1);
}

console.log(`token logging: ${scanned} files, no log call prints a credential`);
