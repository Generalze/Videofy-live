/** @author masterzee001 */
/**
 * A bundled image, as Metro would hand it back: an opaque source id.
 *
 * ui/c7.tsx reaches the launcher logo with `require('../../assets/splash-icon.png')`,
 * which is a CommonJS require and not an import, so the module aliases in
 * vitest.config.ts never see it -- node's own loader does, and it parses the
 * PNG as JavaScript and fails at the first byte. This registers a loader for
 * the extension that hands back a number, the way Metro does. Nothing renders
 * it; a rendered test only ever sees that an Image was asked for.
 */
import Module from 'node:module';

interface LoaderRegistry {
  _extensions: Record<string, (module: { exports: unknown }, filename: string) => void>;
}

(Module as unknown as LoaderRegistry)._extensions['.png'] = (module) => {
  module.exports = 1;
};
