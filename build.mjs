import { build } from 'esbuild';
await build({
  entryPoints: ['src/bridge.mjs'], outfile: 'dist/bridge.mjs', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', legalComments: 'inline',
  banner: { js: 'import { createRequire as __foundocsCreateRequire } from "node:module"; const require = __foundocsCreateRequire(import.meta.url);' },
});
