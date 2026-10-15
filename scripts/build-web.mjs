// Bundles the window's UI (src/) into dist/ with esbuild.
// node scripts/build-web.mjs           one build, minified
// node scripts/build-web.mjs --watch   rebuilds on every change, for development

import * as esbuild from 'esbuild';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');

// The language guide comes from the interpreter's repo. When it's checked out next to
// this one (or JLB_DOCS points at its docs folder), bring src/docs up to date with it.
const docsFrom = process.env.JLB_DOCS || '../jlb-rust/docs';
if (existsSync(docsFrom)) {
  let changed = 0;
  for (const name of await readdir(docsFrom)) {
    if (!name.endsWith('.md')) continue;
    const text = await readFile(join(docsFrom, name), 'utf8');
    const to = join('src/docs', name);
    const old = existsSync(to) ? await readFile(to, 'utf8') : null;
    if (old !== text) {
      await writeFile(to, text);
      changed++;
    }
  }
  if (changed) console.log(`Updated ${changed} guide page${changed > 1 ? 's' : ''} from ${docsFrom}`);
}

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
