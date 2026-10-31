import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import { SECURITY_HEADERS } from './src/build/csp.ts';
import { buildHashInput, buildPrecacheList, modelHashInput, renderServiceWorker } from './src/build/precache.ts';

const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex');

/** The commit this build is made from, shown in Setup: Vercel's own git metadata, else the local checkout. */
function commitHash(): string {
  const vercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (vercel) return vercel.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return ''; // a ZIP download has no git history: Setup shows the version alone
  }
}
const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Build-only: after the bundle is written (and public/ has been copied
 * verbatim), overwrite dist/sw.js with public/sw.js filled in with the full
 * precache list and a content-hashed cache name.
 */
function precacheManifest(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'ppc-precache-manifest',
    apply: 'build',
    configResolved(c) {
      config = c;
    },
    async closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const template = await readFile(resolve(config.publicDir, 'sw.js'), 'utf8');
      const files = (await readdir(outDir, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => relative(outDir, join(e.parentPath, e.name)));
      const list = buildPrecacheList(files);
      // Fixed-name files (models, wasm) change bytes without changing names: fold content hashes in.
      const digests = await Promise.all(
        list.slice(1).map(async (p) => `${p}:${sha1(await readFile(join(outDir, p)))}`),
      );
      const buildHash = sha1(buildHashInput(list, template, digests.join('|'))).slice(0, 12);
      const modelsHash = sha1(modelHashInput(digests)).slice(0, 12);
      await writeFile(join(outDir, 'sw.js'), renderServiceWorker(template, list, buildHash, modelsHash));
      config.logger.info(`[precache] dist/sw.js: ${list.length} entries`);
    },
  };
}

export default defineConfig({
  plugins: [precacheManifest()],
  worker: { format: 'es' },
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __COMMIT__: JSON.stringify(commitHash()) },
  // Two pages: the stall app, and /demo (the shareable how-it-works page; vercel.json routes /demo to it).
  build: { rollupOptions: { input: { main: 'index.html', demo: 'demo.html' } } },
  preview: { headers: SECURITY_HEADERS },
  test: { environment: 'node', include: ['test/**/*.test.ts'], exclude: ['.claude/**', 'node_modules/**', 'dist/**'] },
});
