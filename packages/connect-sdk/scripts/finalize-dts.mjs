/** @owner masterzee001 */
/**
 * Make dist/index.d.ts stand alone.
 *
 * The dts bundling step inlines every @videofy-live/* declaration but leaves
 * one `import { z } from 'zod'` behind (zod's types are path-mapped in
 * tsconfig to dodge its .d.cts layout, and the resolver treats path-mapped
 * modules as external). A public package must not require zod's TYPES any
 * more than its runtime, so that single import is replaced with a minimal
 * local shim of the four type-level constructs the contract aliases use:
 * ZodString, ZodEnum, ZodBranded and infer. The shim reproduces zod's type
 * algebra exactly for those constructs, so every inferred alias (CallMode,
 * LanguageTag, PublicCallId, ...) resolves to the same shape it has inside
 * the workspace.
 *
 * Fails loudly if the emitted file drifts from these expectations — a new
 * zod construct reaching the public surface must be a deliberate decision,
 * not a silent widening.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dtsPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.d.ts');
const source = readFileSync(dtsPath, 'utf8');

const ZOD_IMPORT = "import { z } from 'zod';";
if (!source.includes(ZOD_IMPORT)) {
  throw new Error('finalize-dts: expected exactly one zod type import in dist/index.d.ts');
}

const KNOWN_MEMBERS = new Set(['ZodString', 'ZodEnum', 'ZodBranded', 'infer']);
const usedMembers = new Set(
  [...source.matchAll(/\bz\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((match) => match[1]),
);
for (const member of usedMembers) {
  if (!KNOWN_MEMBERS.has(member)) {
    throw new Error(
      `finalize-dts: unshimmed zod construct z.${member} reached the public declarations`,
    );
  }
}

const shim = `/**
 * Minimal local stand-in for the zod TYPE constructs the bundled contract
 * declarations reference. Type-level only; reproduces zod's inference for
 * exactly these constructs so the aliases below keep their workspace shapes.
 */
declare namespace z {
  const BRAND: unique symbol;
  type BRAND<T extends string | number | symbol> = { [BRAND]: { [K in T]: true } };
  interface ZodType<Output> {
    readonly _output: Output;
  }
  interface ZodString extends ZodType<string> {}
  interface ZodEnum<T extends [string, ...string[]]> extends ZodType<T[number]> {}
  interface ZodBranded<T extends ZodType<unknown>, B extends string | number | symbol>
    extends ZodType<T['_output'] & BRAND<B>> {}
  type infer<T extends ZodType<unknown>> = T['_output'];
}`;

const finalized = source.replace(ZOD_IMPORT, shim);

const leftoverImports = [...finalized.matchAll(/^import\s.+$/gm)].map((match) => match[0]);
if (leftoverImports.length > 0) {
  throw new Error(
    `finalize-dts: dist/index.d.ts still imports external modules: ${leftoverImports.join('; ')}`,
  );
}

writeFileSync(dtsPath, finalized);
console.log('finalize-dts: dist/index.d.ts is standalone');
