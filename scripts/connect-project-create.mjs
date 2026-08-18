#!/usr/bin/env node
/** @owner masterzee001 */
/**
 * Videofy Connect project provisioning (P6.5 R11).
 *
 *   npm run connect:project:create -- --name "Acme Support" \
 *     --origin https://support.acme.example [--origin ...] \
 *     [--allow-originless] [--path ./connect-projects.json]
 *
 * Generates a proj_<12> project id and a vfk_dev_<32> API key from
 * crypto.randomBytes, prints the RAW KEY EXACTLY ONCE to stdout, and stores
 * ONLY its sha256 hash (plus name, origins, originless policy, createdAt,
 * active:true) in the versioned registry file — written atomically
 * (temp-then-rename, the accounts.json construction) so a crash can never
 * truncate every project at once. The raw key is never logged and never
 * persisted; lose it and you provision a new project.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    [
      'Usage: node scripts/connect-project-create.mjs --name <name> [options]',
      '',
      '  --name <name>          Project display name (required).',
      '  --origin <origin>      Allowed browser origin, exact match, repeatable.',
      '                         No wildcards — R7 forbids them.',
      '  --allow-originless     Permit joins with no Origin header (native/dev',
      '                         clients). Default: off.',
      '  --path <file>          Registry file (default ./connect-projects.json,',
      '                         or CONNECT_PROJECTS_PATH).',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArguments(argv) {
  const options = {
    name: null,
    origins: [],
    allowOriginless: false,
    path: process.env.CONNECT_PROJECTS_PATH || './connect-projects.json',
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    switch (argument) {
      case '--name':
        options.name = argv[++index];
        break;
      case '--origin': {
        const origin = argv[++index];
        if (!origin) usage('--origin requires a value');
        if (origin.includes('*')) usage('wildcard origins are not allowed (R7)');
        let parsed;
        try {
          parsed = new URL(origin);
        } catch {
          usage(`"${origin}" is not a valid origin URL`);
        }
        const normalized = parsed.origin;
        if (normalized === 'null') usage(`"${origin}" is not a valid origin URL`);
        if (!options.origins.includes(normalized)) options.origins.push(normalized);
        break;
      }
      case '--allow-originless':
        options.allowOriginless = true;
        break;
      case '--path':
        options.path = argv[++index];
        if (!options.path) usage('--path requires a value');
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        usage(`unknown argument "${argument}"`);
    }
  }
  if (!options.name || !options.name.trim()) usage('--name is required');
  return options;
}

function loadRegistry(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, projects: [] };
    console.error(`Error: could not read ${filePath}: ${error.message}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // NEVER clobber a file we cannot understand — it may be somebody's registry.
    console.error(`Error: ${filePath} exists but is not valid JSON; refusing to overwrite it.`);
    process.exit(1);
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.projects)) {
    console.error(`Error: ${filePath} is not a version-1 Connect project registry; refusing to overwrite it.`);
    process.exit(1);
  }
  return parsed;
}

function atomicWrite(filePath, contents) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, 'utf8');
  renameSync(temporary, filePath);
}

const options = parseArguments(process.argv.slice(2));
const registryPath = resolve(options.path);
const registry = loadRegistry(registryPath);

const projectId = `proj_${randomBytes(6).toString('hex')}`; // 12 chars
const rawKey = `vfk_dev_${randomBytes(16).toString('hex')}`; // 32 chars
const keyHash = createHash('sha256').update(rawKey, 'utf8').digest('hex');

registry.projects.push({
  projectId,
  name: options.name.trim(),
  keyHash,
  allowedOrigins: options.origins,
  allowOriginless: options.allowOriginless,
  createdAt: new Date().toISOString(),
  active: true,
});

atomicWrite(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

console.log('Videofy Connect project created.');
console.log('');
console.log(`  projectId:        ${projectId}`);
console.log(`  name:             ${options.name.trim()}`);
console.log(`  allowedOrigins:   ${options.origins.length > 0 ? options.origins.join(', ') : '(none)'}`);
console.log(`  allowOriginless:  ${options.allowOriginless}`);
console.log(`  registry:         ${registryPath}`);
console.log('');
console.log('  API key (shown ONCE, stored only as a sha256 hash — save it now):');
console.log('');
console.log(`    ${rawKey}`);
console.log('');
console.log('Restart the realtime gateway to pick up the new registry.');
