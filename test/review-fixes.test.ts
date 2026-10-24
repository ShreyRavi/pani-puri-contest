import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BiteDetector } from '../src/detector';
import { renderServiceWorker } from '../src/build/precache';
import * as R from '../src/round';
import { normalizeRound } from '../src/store';
import { cameraCause } from '../src/vision/client';

const P: R.Pending = { at: 0, openedAt: 0, peak: 0.6, confidence: 0.9, hand: true };
const bite = (t: number, openedAt = t - 300): R.Pending => ({ ...P, at: t, openedAt });
const liveAt = (opts: R.StartOptions = {}) => R.tick(R.start('A', 60000, 0, opts), 3000); // live 3000..63000

describe('camera error mapping', () => {
  const e = (name: string) => Object.assign(new Error(name), { name });
  it.each([
    ['NotAllowedError', 'blocked'],
    ['SecurityError', 'blocked'],
    ['NotReadableError', 'busy'],
    ['AbortError', 'busy'],
    ['NotFoundError', 'no-camera'],
    ['OverconstrainedError', 'no-camera'],
    ['Weird', 'no-camera'],
  ])('%s -> %s', (name, cause) => expect(cameraCause(e(name))).toBe(cause));
});

describe('real sw.js template', () => {
  const tpl = readFileSync('public/sw.js', 'utf8');
  it('renders with build and model hashes and a real list', () => {
    const out = renderServiceWorker(tpl, ['./', './assets/a.js', './mediapipe/face_landmarker.task'], 'f', 'm');
    expect(out).toContain('const PRECACHE = [');
    expect(out).not.toMatch(/__BUILD__|__MODELS__|self\.__PRECACHE__/);
  });
  it('keeps the model cache name when only app files change', () => {
    const a = renderServiceWorker(tpl, ['./', './assets/a.js'], 'x', 'models-1');
    const b = renderServiceWorker(tpl, ['./', './assets/b.js'], 'y', 'models-1');
    const models = (s: string) => s.match(/const MODELS = '([0-9a-f]+)'/)![1];
    const build = (s: string) => s.match(/const BUILD = '([0-9a-f]+)'/)![1];
    expect(models(a)).toBe(models(b));
    expect(build(a)).not.toBe(build(b));
  });
  it('throws when a placeholder is missing', () => {
    expect(() => renderServiceWorker("const BUILD = '__BUILD__';", ['./'])).toThrow(/placeholder/);
  });
});

describe('detector mode switch and clamps', () => {
  it('switching mode mid-bite abandons the bite', () => {
    const d = new BiteDetector({ mode: 'absolute' });
    d.push({ t: 0, ratio: 0.05, handNear: false });
    d.push({ t: 100, ratio: 0.6, handNear: false });
    expect(d.state.phase).toBe('open');
    d.setConfig({ mode: 'relative' });
    expect(d.state).toMatchObject({ phase: 'closed', trough: null });
    expect(d.push({ t: 200, ratio: 0.1, handNear: false })).toBeNull();
  });
  it('reset clears an absolute bite in progress', () => {
    const d = new BiteDetector({ mode: 'absolute' });
    d.push({ t: 0, ratio: 0.6, handNear: false });
    d.reset();
    expect(d.push({ t: 100, ratio: 0.1, handNear: false })).toBeNull();
  });
  it('never lets a close line sit above the open line, even with no baseline', () => {
    const d = new BiteDetector({ mode: 'absolute', open: 0.3, close: 0.35 });
    expect(d.closeThreshold).toBeCloseTo(0.25);
  });
});

describe('round cells (state-machine review)', () => {
  it('confirm while paused starts the next due clock from the pause and shifts on resume', () => {
    let s = liveAt({ autoConfirmMs: 2000 });
    s = R.candidate(s, bite(5000), 'hybrid', 5000);
    s = R.candidate(s, bite(5200), 'hybrid', 5200);
    s = R.togglePause(s, 5500);
    s = R.confirm(s, 6000);
    expect(s.dueAt).toBe(7500);
    s = R.togglePause(s, 10000);
    expect(s.dueAt).toBe(12000);
  });

  it('auto-confirms during the buzzer when the due time falls after zero', () => {
    let s = R.candidate(liveAt({ autoConfirmMs: 2000 }), bite(62000), 'hybrid', 62000); // due 64000
    s = R.tick(s, 63500);
    expect(s).toMatchObject({ phase: 'buzzer', count: 0 });
    s = R.tick(s, 64000);
    expect(s.count).toBe(1);
  });

  it('rejecting the last waiting bite in the buzzer reaches the result after the detect window', () => {
    let s = R.tick(R.candidate(liveAt(), bite(62500), 'hybrid', 62500), 63000);
    s = R.reject(s, 63200);
    expect(R.tick(s, 64000).phase).toBe('buzzer');
    expect(R.tick(s, 64500)).toMatchObject({ phase: 'result', rejected: 1 });
  });

  it('Esc from a buzzer pause ends with leftovers not counted', () => {
    let s = R.tick(R.candidate(liveAt(), bite(62500), 'hybrid', 62500), 63000);
    s = R.togglePause(s, 63100);
    s = R.end(s, 64000);
    expect(s).toMatchObject({ phase: 'result', notCounted: 1 });
  });

  it('candidates are not accepted while paused (detection is off)', () => {
    const s = R.togglePause(liveAt(), 5000);
    expect(R.candidate(s, bite(5100, 4900), 'hybrid', 5100).queue).toHaveLength(0);
  });

  it('runningUntil per phase', () => {
    expect(R.runningUntil(R.start('A', 60000, 0), 0)).toBe(63000);
    expect(R.runningUntil(liveAt(), 0)).toBe(63000);
    expect(R.runningUntil(R.tick(liveAt(), 63000), 0)).toBe(73000);
    expect(R.runningUntil(R.togglePause(liveAt(), 5000), 7000)).toBe(7000);
    expect(R.runningUntil(R.IDLE, 0)).toBe(Infinity);
  });

  it('auto undo clears a stale last-puri line', () => {
    let s = R.candidate(liveAt(), bite(5000), 'auto', 5000);
    s = R.reject(s, 5100, 'auto');
    expect(s.last).toBeNull();
  });
});

describe('legacy load guard', () => {
  it('old paused rounds resume as live', () => {
    expect(normalizeRound({ ...R.IDLE, phase: 'paused', pausedRemaining: 20000, pausedFrom: undefined }).pausedFrom).toBe('live');
  });
  it('an existing queue wins over a legacy pending', () => {
    const q = [{ at: 1, openedAt: 1, peak: 0.5, confidence: 0.8, hand: false }];
    expect(normalizeRound({ ...R.IDLE, queue: q, pending: { at: 9, peak: 0.6, confidence: 0.9, hand: true } }).queue).toEqual(q);
  });
});

describe('cycle-2 fixes', () => {
  it('a soft reset (face switch / recovery) keeps the cooldown so a chew right after a bite does not count', () => {
    const d = new BiteDetector({ mode: 'absolute', cooldownMs: 1500 });
    const seq = (t0: number) => [d.push({ t: t0, ratio: 0.05, handNear: false }), d.push({ t: t0 + 100, ratio: 0.6, handNear: false }), d.push({ t: t0 + 400, ratio: 0.1, handNear: false })];
    expect(seq(0).filter(Boolean).map((e) => e!.kind)).toEqual(['candidate']);
    d.reset({ keepCooldown: true });
    expect(seq(500).filter(Boolean).map((e) => (e!.kind === 'ignored' ? e!.reason : e!.kind))).toEqual(['cooldown']);
  });
});
