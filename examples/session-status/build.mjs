import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const { name } = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
const common = { absWorkingDir: root, bundle: true, target: 'es2022', legalComments: 'none' };

await build({
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  platform: 'node',
  format: 'esm',
});

// DSH 0.1.5-rc.2 loads lazy CommonJS factories. React comes from its seed table.
await build({
  ...common,
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  platform: 'browser',
  format: 'cjs',
  external: ['react', 'react/jsx-runtime'],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory(require) {\nconst module = { exports: {} };` },
  footer: { js: 'return module.exports;\n} });' },
});
