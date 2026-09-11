import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const { name } = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
const common = { absWorkingDir: root, bundle: true, target: 'es2022', legalComments: 'none' };

await mkdir(new URL('lib/', import.meta.url), { recursive: true });

// The Host entry is copied verbatim: it has nothing to bundle, and DSH's
// package contract inspects it as the mounted module entry, so an esbuild
// rewrite (which turns named declarations into an export table) would obscure
// exactly the surface that contract reads.
await copyFile(new URL('src/host-entry.js', import.meta.url), new URL('lib/index.js', import.meta.url));

// DSH loads lazy CommonJS factories from its own module loader. React is the
// only seed this client needs, exactly like the native examples. The arrow
// property form `factory: (require) => {` is the shape DSH's bundle audit
// parses (a method shorthand is not).
await build({
  ...common,
  entryPoints: ['src/client.ts'],
  outfile: 'lib/client.js',
  platform: 'browser',
  format: 'cjs',
  external: ['react', 'react/jsx-runtime'],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {\nconst module = { exports: {} };` },
  footer: { js: 'return module.exports;\n} });' },
});

// Test-only surface: the same client source without the browser module-loader
// wrapper, so Node can import it directly. React stays external.
await build({
  ...common,
  entryPoints: ['src/client.ts'],
  outfile: 'test/.build/client.mjs',
  platform: 'node',
  format: 'esm',
  external: ['react', 'react/jsx-runtime'],
  banner: { js: `import { createRequire as __dshCreateRequire } from 'node:module';\nconst require = __dshCreateRequire(import.meta.url);` },
  footer: { js: '' },
});
