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
    const ev = run(new BiteDetector(), bite(0));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'candidate', peak: 0.6, t: 600 });
  });

  it('ignores an open that does not close within 1.2s, and does not re-fire while held', () => {
    const ev = run(new BiteDetector(), [
      [0, 0.05],
      [100, 0.5],
      [1400, 0.5],
      [1500, 0.55],
      [1600, 0.1],
    ]);
    expect(ev).toEqual([expect.objectContaining({ kind: 'ignored', reason: 'timeout' })]);
  });

  it('re-arms after a held mouth finally closes', () => {
    const d = new BiteDetector();
    run(d, [[0, 0.5], [1400, 0.5], [1500, 0.1]]);
    expect(run(d, bite(5000))).toEqual([expect.objectContaining({ kind: 'candidate' })]);
  });

  it('enforces the cooldown between candidates', () => {
    const d = new BiteDetector({ cooldownMs: 1500 });
    const ev = run(d, [...bite(0), ...bite(700), ...bite(2200)]);
    expect(ev.map((e) => (e.kind === 'candidate' ? 'c' : e.reason))).toEqual(['c', 'cooldown', 'c']);
  });

  it('requires a hand near the mouth in the 600ms before the open when gated', () => {
    const d = new BiteDetector({ requireHand: true });
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
    const d = new BiteDetector({ requireHand: true });
    const ev = run(d, [
      [0, 0.05, true],
      [700, 0.05],
      [750, 0.5],
      [1000, 0.1],
    ]);
    expect(ev[0]).toMatchObject({ reason: 'no-hand' });
  });

  it('raises the close line when the resting baseline is above it', () => {
    const d = new BiteDetector();
    d.setBaseline(0.3);
    expect(d.closeThreshold).toBeCloseTo(0.35);
    // closes to 0.32: below 0.35 but above default 0.20
    expect(run(d, [[0, 0.3], [100, 0.6], [400, 0.32]])).toHaveLength(1);
  });

  it('never lets the baseline push close above open', () => {
    const d = new BiteDetector();
    d.setBaseline(0.5);
    expect(d.closeThreshold).toBeLessThan(d.config.open);
  });

  it('abandons a bite when the face is lost', () => {
    const ev = run(new BiteDetector(), [[0, 0.5], [100, null], [200, 0.1]]);
    expect(ev).toEqual([]);
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
