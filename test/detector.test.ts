import { describe, expect, it } from 'vitest';
import { BiteDetector, median, mouthRatio, type DetectorEvent } from '../src/detector';

// Feed [t, ratio, handNear?] samples, collect events.
function run(d: BiteDetector, samples: Array<[number, number | null, boolean?]>): DetectorEvent[] {
  const out: DetectorEvent[] = [];
  for (const [t, ratio, handNear = false] of samples) {
    const e = d.push({ t, ratio, handNear });
    if (e) out.push(e);
  }
  return out;
}

const bite = (t0: number): Array<[number, number]> => [
  [t0, 0.05],
  [t0 + 100, 0.5],
  [t0 + 300, 0.6],
  [t0 + 600, 0.1],
];

describe('BiteDetector', () => {
  it('emits a candidate for open then close within the window', () => {
    const ev = run(new BiteDetector({ mode: 'absolute' }), bite(0));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'candidate', peak: 0.6, t: 600 });
  });

  it('ignores an open that does not close within 1.2s, and does not re-fire while held', () => {
    const ev = run(new BiteDetector({ mode: 'absolute' }), [
      [0, 0.05],
      [100, 0.5],
      [1400, 0.5],
      [1500, 0.55],
      [1600, 0.1],
    ]);
    expect(ev).toEqual([expect.objectContaining({ kind: 'ignored', reason: 'timeout' })]);
  });

  it('re-arms after a held mouth finally closes', () => {
    const d = new BiteDetector({ mode: 'absolute' });
    run(d, [[0, 0.5], [1400, 0.5], [1500, 0.1]]);
    expect(run(d, bite(5000))).toEqual([expect.objectContaining({ kind: 'candidate' })]);
  });

  it('enforces the cooldown between candidates', () => {
    const d = new BiteDetector({ mode: 'absolute', cooldownMs: 1500 });
    const ev = run(d, [...bite(0), ...bite(700), ...bite(2200)]);
    expect(ev.map((e) => (e.kind === 'candidate' ? 'c' : e.reason))).toEqual(['c', 'cooldown', 'c']);
  });

  it('requires a hand near the mouth in the 600ms before the open when gated', () => {
    const d = new BiteDetector({ mode: 'absolute', requireHand: true });
    expect(run(d, bite(0))).toEqual([expect.objectContaining({ kind: 'ignored', reason: 'no-hand' })]);
    const withHand: Array<[number, number, boolean]> = [
      [9500, 0.05, true],
      [10000, 0.05, false],
      [10050, 0.5, false],
      [10400, 0.1, false],
    ];
    expect(run(d, withHand)).toEqual([expect.objectContaining({ kind: 'candidate', hand: true })]);
  });

  it('rejects a hand seen longer than 600ms before the open', () => {
    const d = new BiteDetector({ mode: 'absolute', requireHand: true });
    const ev = run(d, [
      [0, 0.05, true],
      [700, 0.05],
      [750, 0.5],
      [1000, 0.1],
    ]);
    expect(ev[0]).toMatchObject({ reason: 'no-hand' });
  });

  it('raises the close line when the resting baseline is above it', () => {
    const d = new BiteDetector({ mode: 'absolute' });
    d.setBaseline(0.3);
    // capped at close + 0.10 = 0.30 (was 0.35 before the cap)
    expect(d.closeThreshold).toBeCloseTo(0.3);
    // closes to 0.28: below 0.30 but above default 0.20
    expect(run(d, [[0, 0.3], [100, 0.6], [400, 0.28]])).toHaveLength(1);
  });

  it('never lets the baseline push close above open', () => {
    const d = new BiteDetector({ mode: 'absolute' });
    d.setBaseline(0.5);
    expect(d.closeThreshold).toBeLessThan(d.config.open);
  });

  it('abandons a bite when the face is lost', () => {
    const ev = run(new BiteDetector({ mode: 'absolute' }), [[0, 0.5], [100, null], [200, 0.1]]);
    expect(ev).toEqual([]);
  });

  it('caps a high baseline at close + 0.10', () => {
    const d = new BiteDetector({ mode: 'absolute' });
    d.setBaseline(0.5);
    expect(d.closeThreshold).toBeCloseTo(0.3);
  });

  it('reports openedAt on candidates and ignored events', () => {
    const d = new BiteDetector({ mode: 'absolute' });
    expect(run(d, bite(0))[0]).toMatchObject({ kind: 'candidate', openedAt: 100, t: 600 });
    expect(run(d, [[5000, 0.05], [5100, 0.5], [6400, 0.5]])[0]).toMatchObject({
      kind: 'ignored',
      reason: 'timeout',
      openedAt: 5100,
    });
  });

  it('defaults to absolute mode and reports closeThreshold as the close line', () => {
    const d = new BiteDetector();
    expect(d.config.mode).toBe('absolute');
    expect(d.state).toMatchObject({ mode: 'absolute', phase: 'closed', closeLine: 0.2 });
  });
});

describe('BiteDetector (relative mode)', () => {
  const rel = (cfg: Partial<ConstructorParameters<typeof BiteDetector>[0]> = {}) =>
    new BiteDetector({ mode: 'relative', ...cfg });

  // Bite while chewing: hovers ~0.3, peaks ~0.6, falls back to ~0.3.
  const chewBite = (t0: number): Array<[number, number]> => [
    [t0, 0.28],
    [t0 + 100, 0.33],
    [t0 + 200, 0.5],
    [t0 + 300, 0.6],
    [t0 + 500, 0.4],
    [t0 + 600, 0.3],
  ];
  const chew = (t0: number, t1: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let t = t0, i = 0; t < t1; t += 100, i++) out.push([t, i % 2 ? 0.35 : 0.25]);
    return out;
  };

  it('counts one candidate per bite while chewing with a half-open mouth', () => {
    const d = rel();
    const ev = run(d, [...chewBite(0), ...chew(700, 2000), ...chewBite(2000), ...chew(2700, 4000), ...chewBite(4000)]);
    expect(ev.map((e) => e.kind)).toEqual(['candidate', 'candidate', 'candidate']);
    expect(ev[0]).toMatchObject({ openedAt: 200, t: 500, peak: 0.6 });
    // absolute mode never sees a close below 0.20 here, so it gets stuck
    const abs = run(new BiteDetector({ mode: 'absolute' }), [...chewBite(0), ...chew(700, 2000), ...chewBite(2000)]);
    expect(abs.filter((e) => e.kind === 'candidate')).toHaveLength(0);
  });

  it('times out a held-open mouth once, then re-arms after a drop from the peak', () => {
    const d = rel();
    const ev = run(d, [
      [0, 0.1],
      [100, 0.6],
      [800, 0.62],
      [1400, 0.6],
      [1600, 0.65],
      [1800, 0.55],
    ]);
    expect(ev).toEqual([expect.objectContaining({ kind: 'ignored', reason: 'timeout', openedAt: 100 })]);
    expect(d.state.phase).toBe('held');
    expect(d.state.closeLine).toBeCloseTo(0.5);
    run(d, [[2000, 0.4]]); // 0.65 - 0.15 = 0.50 -> closes
    expect(d.state).toMatchObject({ phase: 'closed', trough: 0.4 });
    expect(run(d, chewBite(5000))).toEqual([expect.objectContaining({ kind: 'candidate' })]);
  });

  it('does not open on a rise above open that is less than drop above the trough', () => {
    const d = rel();
    const ev = run(d, [
      [0, 0.38],
      [100, 0.47],
      [200, 0.5],
      [300, 0.3],
    ]);
    expect(ev).toEqual([]);
    expect(d.state.phase).toBe('closed');
    expect(d.state.trough).toBeCloseTo(0.3);
  });

  it('enforces the cooldown', () => {
    const d = rel({ cooldownMs: 1500 });
    const ev = run(d, [...chewBite(0), ...chewBite(700), ...chewBite(2200)]);
    expect(ev.map((e) => (e.kind === 'candidate' ? 'c' : e.reason))).toEqual(['c', 'cooldown', 'c']);
  });

  it('applies the hand gate', () => {
    const d = rel({ requireHand: true });
    expect(run(d, chewBite(0))).toEqual([expect.objectContaining({ kind: 'ignored', reason: 'no-hand' })]);
    const withHand: Array<[number, number, boolean]> = [
      [9800, 0.3, true],
      [10000, 0.3, false],
      [10100, 0.55, false],
      [10300, 0.35, false],
    ];
    expect(run(d, withHand)).toEqual([expect.objectContaining({ kind: 'candidate', hand: true, openedAt: 10100 })]);
  });

  it('abandons a bite when the face is lost and reseeds the trough', () => {
    const d = rel();
    expect(run(d, [[0, 0.1], [100, 0.6], [200, null]])).toEqual([]);
    expect(d.state).toMatchObject({ phase: 'closed', trough: null });
    // first ratio after loss seeds the trough, so 0.6 -> 0.3 is not a close
    expect(run(d, [[300, 0.6], [400, 0.3]])).toEqual([]);
    expect(d.state.trough).toBeCloseTo(0.3);
  });

  it('reports phase, peak, trough and closeLine through the state getter', () => {
    const d = rel();
    expect(d.state).toMatchObject({ mode: 'relative', phase: 'closed', peak: null, trough: null });
    expect(d.state.closeLine).toBeNaN();
    run(d, [[0, 0.2], [100, 0.5], [200, 0.7]]);
    expect(d.state).toMatchObject({ phase: 'open', peak: 0.7, trough: 0.2 });
    expect(d.state.closeLine).toBeCloseTo(0.55);
    run(d, [[300, 0.5]]);
    expect(d.state).toMatchObject({ phase: 'closed', peak: null, trough: 0.5 });
    expect(d.state.closeLine).toBeNaN();
  });

  it('reset clears phase, peak, trough and cooldown', () => {
    const d = rel({ cooldownMs: 5000 });
    run(d, [...chewBite(0), [700, 0.1], [800, 0.6]]);
    expect(d.state.phase).toBe('open');
    d.reset();
    expect(d.state).toMatchObject({ phase: 'closed', peak: null, trough: null });
    expect(run(d, chewBite(1000))).toEqual([expect.objectContaining({ kind: 'candidate' })]);
  });

  it('setConfig switches mode and drop', () => {
    const d = new BiteDetector({ mode: 'absolute' });
    d.setConfig({ mode: 'relative', drop: 0.3 });
    expect(d.config).toMatchObject({ mode: 'relative', drop: 0.3 });
    // a 0.25 rise is no longer enough
    expect(run(d, [[0, 0.3], [100, 0.55], [200, 0.2]])).toEqual([]);
  });
});

describe('helpers', () => {
  it('mouthRatio is gap over width', () => {
    expect(mouthRatio({ x: 0, y: 0 }, { x: 0, y: 5 }, { x: -5, y: 0 }, { x: 5, y: 0 })).toBeCloseTo(0.5);
  });
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
