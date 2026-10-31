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

/** Media served straight from the network: the service worker neither precaches nor intercepts it (see public/sw.js). */
export const ONLINE_ONLY_DIR = 'media/';

function excluded(p: string): boolean {
  const s = p.slice(2); // drop './'
  if (s === '') return true; // './' is added explicitly
  if (s === 'sw.js') return true;
  if (s.endsWith('.map')) return true;
  if (s === 'index.html') return true; // served as './'
  // The /demo page and its video are online-only: the stall never pre-downloads the ~12 MB video.
  if (s === 'demo.html' || s.startsWith(ONLINE_ONLY_DIR)) return true;
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

/** Path segment that marks model files; public/sw.js routes the same segment to its long-lived cache. */
export const MODEL_DIR = '/mediapipe/';

/** What the build hashes into the cache name: the sorted precache list, the sw template and a file-content fingerprint. */
export function buildHashInput(list: readonly string[], template: string, fingerprint = ''): string {
  return JSON.stringify([...list].sort()) + '\n' + template + '\n' + fingerprint;
}

/** What the build hashes into the model cache name: only the model files' digests, so app deploys keep the ~24 MB cache. */
export function modelHashInput(digests: readonly string[]): string {
  return digests.filter((d) => d.includes(MODEL_DIR)).join('|');
}

/**
 * Fill the sw.js template with the precache list, the build hash and the model-files hash
 * (both computed by the build from buildHashInput / model content digests).
 */
export function renderServiceWorker(template: string, list: readonly string[], buildHash: string, modelsHash: string): string {
  if (!template.includes(PRECACHE_PLACEHOLDER) || !template.includes(BUILD_PLACEHOLDER)) {
    throw new Error('sw.js template is missing the __PRECACHE__ or __BUILD__ placeholder');
  }
  if (!template.includes(`'${MODEL_DIR}'`)) throw new Error(`sw.js template no longer routes '${MODEL_DIR}' to the model cache`);
  return template
    .split(PRECACHE_PLACEHOLDER)
    .join(JSON.stringify(list, null, 2))
    .split(BUILD_PLACEHOLDER)
    .join(buildHash)
    .split(MODELS_PLACEHOLDER)
    .join(modelsHash);
}
