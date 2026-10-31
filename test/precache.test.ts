import { describe, expect, it } from 'vitest';
import {
  buildHashInput,
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

  it('leaves the /demo page and its video to the network (the stall never pre-downloads the video)', () => {
    const l = buildPrecacheList([...DIST, 'demo.html', 'media/pani-puri-demo.mp4', 'media/pani-puri-demo.jpg']);
    expect(l).not.toContain('./demo.html');
    expect(l.some((p) => p.startsWith('./media/'))).toBe(false);
    expect(l).toContain('./mediapipe/face_landmarker.task'); // 'media/' must not catch 'mediapipe/'
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

describe('buildHashInput', () => {
  const tpl = "const BUILD = '__BUILD__'; const PRECACHE = self.__PRECACHE__ || ['./']; const isModel = (p) => p.includes('/mediapipe/');";

  it('changes when the list, template or file contents change', () => {
    const list = ['./', './assets/a-1.js'];
    expect(buildHashInput(list, tpl)).not.toBe(buildHashInput(['./', './assets/a-2.js'], tpl));
    expect(buildHashInput(list, tpl)).not.toBe(buildHashInput(list, tpl + '\n'));
    expect(buildHashInput(list, tpl, 'a:1')).not.toBe(buildHashInput(list, tpl, 'a:2'));
  });

  it('ignores list order', () => {
    const list = ['./', './assets/a-1.js'];
    expect(buildHashInput(list, tpl)).toBe(buildHashInput([...list].reverse(), tpl));
  });

  it('renders a real array and the given cache names', () => {
    const out = renderServiceWorker(tpl, ['./', './assets/a-1.js'], 'abcdef123456', 'm');
    expect(out).not.toContain('__PRECACHE__');
    expect(out).not.toContain('__BUILD__');
    expect(out).toContain('"./assets/a-1.js"');
    expect(out).toContain("const BUILD = 'abcdef123456'");
  });

  it("refuses a template that stopped routing '/mediapipe/' to the model cache", () => {
    const old = "const BUILD = '__BUILD__'; const PRECACHE = self.__PRECACHE__ || ['./']; const isModel = (p) => p.includes('/models/');";
    expect(() => renderServiceWorker(old, ['./'], 'b', 'm')).toThrow(/mediapipe/);
  });
});
