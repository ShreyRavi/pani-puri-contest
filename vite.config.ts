import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import { buildPrecacheList, renderServiceWorker } from './src/build/precache.ts';

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

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
      const files = (await walk(outDir)).map((f) => relative(outDir, f));
      const list = buildPrecacheList(files);
      // Fixed-name files (models, wasm) change bytes without changing names: fold content hashes in.
      const digests = await Promise.all(
        list.slice(1).map(async (p) => `${p}:${createHash('sha1').update(await readFile(join(outDir, p))).digest('hex')}`),
      );
      const modelDigests = digests.filter((d) => d.includes('/mediapipe/'));
      await writeFile(join(outDir, 'sw.js'), renderServiceWorker(template, list, digests.join('|'), modelDigests.join('|')));
      config.logger.info(`[precache] dist/sw.js: ${list.length} entries`);
    },
  };
}

export default defineConfig({
  plugins: [precacheManifest()],
  worker: { format: 'es' },
  test: { environment: 'node', include: ['test/**/*.test.ts'], exclude: ['.claude/**', 'node_modules/**', 'dist/**'] },
});
