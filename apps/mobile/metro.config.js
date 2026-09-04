/** @author masterzee001 */
/**
 * Metro, taught about the monorepo.
 *
 * WHY THIS FILE IS NOT OPTIONAL. Metro is not Node: it does not walk up
 * directories looking for `node_modules`, and it does not follow symlinks by
 * default. A default Expo config inside an npm workspace therefore resolves
 * nothing above `apps/mobile` -- every `@videofy-live/*` import fails with
 * "Unable to resolve module", which reads like a missing dependency rather
 * than a bundler that was never told where to look.
 *
 * TWO SETTINGS DO THE WORK:
 *
 *   watchFolders      the workspace root, so a change in `call-client-core` is
 *                     picked up without restarting the bundler. Without it,
 *                     edits to shared packages appear to do nothing.
 *   nodeModulesPaths  BOTH the app's own node_modules and the root's, in that
 *                     order. npm hoists most dependencies to the root but
 *                     leaves conflicting versions nested, and the app's copy
 *                     must win when both exist.
 *
 * ONE COPY OF REACT, ALWAYS. `resolver.resolveRequest` is not used here, but
 * the ordering above is what prevents the classic monorepo failure: the app
 * loading React 19 while a hoisted package loads React 18, producing hook
 * errors that name neither package.
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

/*
 * Workspace packages are symlinks. Metro has followed them since 0.73 but only
 * with this enabled, and the failure without it is silent: the import resolves
 * to a stale build rather than erroring.
 */
config.resolver.unstable_enableSymlinks = true;

/*
 * HIERARCHICAL LOOKUP STAYS ON, and turning it off cost a debugging round.
 *
 * `disableHierarchicalLookup` is offered in a lot of monorepo recipes and it is
 * wrong here. It stops Metro walking into NESTED node_modules, so resolution is
 * limited to exactly the directories listed above -- and npm does not put
 * everything there. `expo` ships `expo-modules-core` inside its own
 * `node_modules` whenever a version conflict prevents hoisting, and with the
 * flag set Metro reported it "could not be found within the project", naming
 * only the two paths it had been restricted to.
 *
 * `nodeModulesPaths` ADDS places to look. It does not need anything switched
 * off to work, and switching that off removes the fallback npm relies on.
 */

module.exports = config;
