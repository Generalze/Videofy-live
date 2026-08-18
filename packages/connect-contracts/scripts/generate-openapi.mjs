/** @owner masterzee001 */
// Regenerates openapi.json from the built contract schemas. Run via
// `npm run generate:openapi` (which builds first); the drift test fails
// whenever the committed file and the schemas disagree, so contract changes
// are never silently invisible in the document.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConnectOpenApiDocument } from '../dist/openapi.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(packageRoot, 'openapi.json');
writeFileSync(target, `${JSON.stringify(buildConnectOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);

// The developer-docs copy is generated too (review finding: a manual copy
// silently rots). The package file remains the source of truth.
import { mkdirSync as docsMkdirSync, writeFileSync as docsWriteFileSync, readFileSync as docsReadFileSync } from 'node:fs';
const packageFile = new URL('../openapi.json', import.meta.url);
docsMkdirSync(new URL('../../../docs/connect/', import.meta.url), { recursive: true });
docsWriteFileSync(new URL('../../../docs/connect/openapi.json', import.meta.url), docsReadFileSync(packageFile));
console.log('wrote docs/connect/openapi.json (generated copy)');
