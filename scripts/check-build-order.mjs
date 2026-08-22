#!/usr/bin/env node
/**
 * Every workspace must be built AFTER the workspaces it depends on.
 *
 * This exists because a defect of exactly this shape survived every gate and
 * was found only by deploying. `services/realtime-gateway` imports
 * `@videofy-live/sip-adapter`, but the root `build` script listed sip-adapter
 * nine positions LATER. On the developer's machine that never failed: a
 * previous build had left `sip-adapter/dist` on disk, so the import resolved
 * against a stale artifact. On a clean clone -- a fresh CI runner, a new
 * contributor, a staging VPS -- the same command failed immediately.
 *
 * A green build that depends on residue from an earlier build is not a green
 * build; it is a build whose result depends on what the disk happened to be
 * holding. That is only ever discovered somewhere expensive.
 *
 * So the ordering is checked against the DECLARED dependency graph rather than
 * trusted. Adding a workspace dependency without moving the workspace now
 * fails here instead of on the next clean checkout.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const SCOPE = '@videofy-live/';

function scriptOrder(script) {
  // The enumeration is explicit and order-bearing. Parsing it is the point:
  // the file is the contract, so the check must read what actually runs.
  return script
    .split('&&')
    .map((step) => step.trim())
    .map((step) => /-w\s+(\S+)/.exec(step)?.[1])
    .filter((name) => name !== undefined && name !== null);
}

const root = JSON.parse(readFileSync('package.json', 'utf8'));

// Map package NAME -> workspace PATH, since the build script names paths and
// dependencies name packages.
//
// Resolved from the manifests directly rather than via `npm query`, which
// fails outright on this graph when any workspace link is unresolved -- and a
// guard that cannot run is worse than no guard, because it looks installed.
function expandWorkspaceGlobs(patterns) {
  const found = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) {
      found.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(`${parent}/${entry.name}/package.json`)) {
        found.push(`${parent}/${entry.name}`);
      }
    }
  }
  return found;
}

const workspaces = expandWorkspaceGlobs(root.workspaces ?? []);
const pathByName = new Map();
for (const location of workspaces) {
  const manifest = JSON.parse(readFileSync(`${location}/package.json`, 'utf8'));
  if (typeof manifest.name === 'string') pathByName.set(manifest.name, location);
}

const problems = [];

for (const scriptName of ['build', 'typecheck', 'test']) {
  const script = root.scripts?.[scriptName];
  if (typeof script !== 'string') continue;
  const order = scriptOrder(script);
  const position = new Map(order.map((name, index) => [name, index]));

  for (const workspacePath of order) {
    const name = [...pathByName].find(([, p]) => p === workspacePath)?.[0];
    if (name === undefined) continue;
    const manifest = JSON.parse(readFileSync(`${workspacePath}/package.json`, 'utf8'));
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };

    for (const dependency of Object.keys(declared)) {
      if (!dependency.startsWith(SCOPE)) continue;
      const dependencyPath = pathByName.get(dependency);
      if (dependencyPath === undefined) continue;
      // A dependency absent from the enumeration is its own bug: an
      // unenumerated workspace silently never runs.
      if (!position.has(dependencyPath)) {
        problems.push(
          `${scriptName}: ${workspacePath} depends on ${dependency}, which is not in the ${scriptName} enumeration at all`,
        );
        continue;
      }
      if (position.get(dependencyPath) > position.get(workspacePath)) {
        problems.push(
          `${scriptName}: ${workspacePath} (position ${position.get(workspacePath)}) depends on ` +
            `${dependency} at ${dependencyPath} (position ${position.get(dependencyPath)}) -- ` +
            `the dependency must come FIRST or a clean clone fails`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error('build order does not respect declared workspace dependencies:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nMove the dependency earlier in the root package.json enumeration.');
  process.exit(1);
}

console.log(`build order: ${workspaces.length} workspaces, every declared dependency built first`);
