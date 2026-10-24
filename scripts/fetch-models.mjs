// Vendors MediaPipe WASM + model files into public/mediapipe so the app never
// touches a CDN at runtime. Safe to re-run; skips files that already exist.
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'mediapipe');

const MODELS = {
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

// Only the ES-module build is needed: it is the one that loads inside a module worker.
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
await rm(join(out, 'wasm'), { recursive: true, force: true });
await mkdir(join(out, 'wasm'), { recursive: true });
for (const f of ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']) {
  await cp(join(wasmSrc, f), join(out, 'wasm', f));
}
console.log('fetch-models: copied wasm');

for (const [name, url] of Object.entries(MODELS)) {
  const dest = join(out, name);
  if (await exists(dest)) {
    console.log(`fetch-models: ${name} already present`);
    continue;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch-models: ${url} -> ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`fetch-models: downloaded ${name}`);
}
