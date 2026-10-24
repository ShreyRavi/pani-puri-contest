import { describe, expect, it } from 'vitest';
import {
  buildHash,
  buildPrecacheList,
  normalizePath,
  renderServiceWorker,
} from '../src/build/precache';

const DIST = [
  'index.html',
  'sw.js',
  'assets/index-abc123.js',
  'assets/index-abc123.js.map',
  'assets/index-def456.css',
  'assets/rubik-latin-400-normal-xyz.woff2',
  'assets/detector.worker-111.js',
  'mediapipe/face_landmarker.task',
  'mediapipe/hand_landmarker.task',
  'mediapipe/wasm/vision_wasm_module_internal.js',
  'mediapipe/wasm/vision_wasm_module_internal.wasm',
  '.DS_Store',
];

describe('buildPrecacheList', () => {
  const list = buildPrecacheList(DIST);

  it("includes './' first and the mediapipe files", () => {
    expect(list[0]).toBe('./');
    expect(list).toContain('./mediapipe/face_landmarker.task');
    expect(list).toContain('./mediapipe/hand_landmarker.task');
    expect(list).toContain('./mediapipe/wasm/vision_wasm_module_internal.js');
    expect(list).toContain('./mediapipe/wasm/vision_wasm_module_internal.wasm');
    expect(list).toContain('./assets/index-abc123.js');
    expect(list).toContain('./assets/index-def456.css');
    expect(list).toContain('./assets/rubik-latin-400-normal-xyz.woff2');
  });

  it('excludes sw.js, source maps and dotfiles', () => {
    expect(list).not.toContain('./sw.js');
    expect(list.some((p) => p.endsWith('.map'))).toBe(false);
    expect(list).not.toContain('./.DS_Store');
    expect(list).not.toContain('./index.html');
  });

  it("normalizes paths to './...'", () => {
    expect(normalizePath('assets\\a.js')).toBe('./assets/a.js');
    expect(normalizePath('/assets/a.js')).toBe('./assets/a.js');
    expect(normalizePath('./assets/a.js')).toBe('./assets/a.js');
    const l = buildPrecacheList(['assets\\x.js', '/assets/y.css', './assets/x.js']);
    expect(l).toEqual(['./', './assets/x.js', './assets/y.css']);
    expect(list.every((p) => p.startsWith('./'))).toBe(true);
  });
});

describe('buildHash', () => {
  const tpl = "const BUILD = '__BUILD__'; const PRECACHE = self.__PRECACHE__ || ['./'];";

  it('changes when the list changes', () => {
    const a = buildHash(['./', './assets/a-1.js'], tpl);
    const b = buildHash(['./', './assets/a-2.js'], tpl);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it('changes when the template changes, stable otherwise', () => {
    const list = ['./', './assets/a-1.js'];
    expect(buildHash(list, tpl)).toBe(buildHash([...list].reverse(), tpl));
    expect(buildHash(list, tpl)).not.toBe(buildHash(list, tpl + '\n'));
  });

  it('renders a real array and hashed cache name', () => {
    const out = renderServiceWorker(tpl, ['./', './assets/a-1.js']);
    expect(out).not.toContain('__PRECACHE__');
    expect(out).not.toContain('__BUILD__');
    expect(out).toContain('"./assets/a-1.js"');
    expect(out).toMatch(/const BUILD = '[0-9a-f]{12}'/);
  });
});
