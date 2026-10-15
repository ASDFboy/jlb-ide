// Bundles the window's UI (src/) into dist/ with esbuild.
// node scripts/build-web.mjs           one build, minified
// node scripts/build-web.mjs --watch   rebuilds on every change, for development

import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
await mkdir('dist', { recursive: true });
await copyFile('src/index.html', 'dist/index.html');
await copyFile('scripts/icon.svg', 'dist/icon.svg');

const options = {
  entryPoints: { app: 'src/main.js' },
  bundle: true,
  format: 'esm',
  target: ['chrome105', 'safari15'],
  outdir: 'dist',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  loader: { '.md': 'text', '.woff2': 'file', '.woff': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
