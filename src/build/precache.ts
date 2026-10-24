// Pure helpers for the build-time service-worker precache manifest.
// No Node imports, so it type-checks under the browser tsconfig and is
// trivially unit-testable; vite.config.ts does the filesystem walk.

/** Expression in public/sw.js replaced by the real precache array. */
export const PRECACHE_PLACEHOLDER = "self.__PRECACHE__ || ['./']";
/** Token in public/sw.js replaced by the build hash. */
export const BUILD_PLACEHOLDER = '__BUILD__';
/** Optional token in public/sw.js replaced by the model-files hash (stable across app deploys). */
export const MODELS_PLACEHOLDER = '__MODELS__';

/** Normalize a dist-relative path to the './...' form (forward slashes). */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '');
  return `./${s}`;
}

function excluded(p: string): boolean {
  const s = p.slice(2); // drop './'
  if (s === '') return true; // './' is added explicitly
  if (s === 'sw.js') return true;
  if (s.endsWith('.map')) return true;
  if (s === 'index.html') return true; // served as './'
  const base = s.slice(s.lastIndexOf('/') + 1);
  if (base.startsWith('.')) return true; // .DS_Store and friends
  return false;
}

/**
 * Build the sorted, de-duplicated precache list from dist-relative file
 * paths. Always starts with './'.
 */
export function buildPrecacheList(files: readonly string[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    const n = normalizePath(f);
    if (!excluded(n)) set.add(n);
  }
  return ['./', ...[...set].sort()];
}

/** FNV-1a 32-bit, hex. Short and deterministic; not cryptographic. */
function fnv1a(str: string, seed = 0x811c9dc5): string {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Short hash (12 hex chars) of the sorted precache list, the sw template and a file-content fingerprint. */
export function buildHash(list: readonly string[], template: string, fingerprint = ''): string {
  const input = JSON.stringify([...list].sort()) + '\n' + template + '\n' + fingerprint;
  return fnv1a(input) + fnv1a(input, 0x050c5d1f).slice(0, 4);
}

/**
 * Fill the sw.js template. `fingerprint` should change when any precached file's bytes
 * change (content hashes of fixed-name model files), so a new cache name is issued.
 */
export function renderServiceWorker(template: string, list: readonly string[], fingerprint = '', modelFingerprint = ''): string {
  if (!template.includes(PRECACHE_PLACEHOLDER) || !template.includes(BUILD_PLACEHOLDER)) {
    throw new Error('sw.js template is missing the __PRECACHE__ or __BUILD__ placeholder');
  }
  const hash = buildHash(list, template, fingerprint);
  return template
    .split(PRECACHE_PLACEHOLDER)
    .join(JSON.stringify(list, null, 2))
    .split(BUILD_PLACEHOLDER)
    .join(hash)
    .split(MODELS_PLACEHOLDER)
    .join(buildHash([], 'models', modelFingerprint));
}
