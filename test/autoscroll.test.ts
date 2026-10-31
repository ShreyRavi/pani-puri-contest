// Value: protects=the passive leaderboard scroll (hold top, glide down ~1 row/s, hold, glide up), the host's trackpad
//   taking over for 15 s, a short board never moving, and the result screen centring the contestant's row; fails_when=
//   the phase timings, manual pause or focus maths change; why_new=new module; seam=a fake scroll box (no layout in
//   node); no_claim=real browser smoothness (e2e covers the DOM wiring)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoScroll, HOLD_BOTTOM_MS, HOLD_FOCUS_MS, HOLD_TOP_MS, MANUAL_PAUSE_MS, PAGE_MS } from '../src/ui/autoscroll';

const ROW = 56; // 48px row + 8px gap
let reduced = false;

function box(rows: number, visibleRows = 9, me: object | null = null) {
  const listeners: Record<string, () => void> = {};
  const classes = new Set<string>();
  const row = { offsetHeight: 48, parentElement: {} };
  const el = {
    scrollHeight: rows * ROW,
    clientHeight: visibleRows * ROW,
    scrollTop: 0,
    offsetParent: {} as object | null,
    classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)), remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)) },
    querySelector: (sel: string) => (sel === '.me' ? me : row),
    addEventListener: (type: string, fn: () => void) => (listeners[type] = fn),
  };
  return { el, classes, wheel: () => listeners.wheel() };
}

/** Run the scroller frame by frame (16 ms) for `ms`. */
function run(s: AutoScroll, from: number, ms: number): number {
  let t = from;
  for (const end = from + ms; t < end; t += 16) s.tick(t);
  return t;
}

beforeEach(() => {
  reduced = false;
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced; } }));
  vi.stubGlobal('getComputedStyle', () => ({ rowGap: '8px' }));
  vi.stubGlobal('performance', { now: () => 0 });
});

describe('passive leaderboard scroll', () => {
  it('a board that fits never moves', () => {
    const b = box(9);
    const s = new AutoScroll(b.el as unknown as HTMLElement);
    run(s, 0, 60_000);
    expect(b.el.scrollTop).toBe(0);
    expect(b.classes.has('more')).toBe(false);
  });

  it('holds on the top, glides down about a row a second, holds, glides back up', () => {
    const b = box(20); // 11 rows below the fold: 616 px
    const s = new AutoScroll(b.el as unknown as HTMLElement);
    let t = run(s, 0, HOLD_TOP_MS - 100);
    expect(b.el.scrollTop).toBe(0);
    expect(b.classes.has('more')).toBe(true);
    t = run(s, t, 5100);
    expect(b.el.scrollTop).toBeGreaterThan(4 * ROW);
    expect(b.el.scrollTop).toBeLessThan(6 * ROW);
    t = run(s, t, 7000); // reached the bottom
    expect(b.el.scrollTop).toBe(11 * ROW);
    expect(b.classes.has('more')).toBe(false);
    t = run(s, t, HOLD_BOTTOM_MS - 1000);
    expect(b.el.scrollTop).toBe(11 * ROW);
    t = run(s, t, 1000 + 3500); // glides up at 4x
    expect(b.el.scrollTop).toBe(0);
    run(s, t, HOLD_TOP_MS - 3000); // and holds on the top again
    expect(b.el.scrollTop).toBe(0);
  });

  it('a trackpad scroll by the host pauses it for 15 s, then it carries on from there', () => {
    const b = box(20);
    const s = new AutoScroll(b.el as unknown as HTMLElement);
    const wheelAt = (t: number) => {
      vi.stubGlobal('performance', { now: () => t });
      b.wheel();
    };
    let t = run(s, 0, 1000);
    wheelAt(t);
    b.el.scrollTop = 3 * ROW; // the host scrolled
    t = run(s, t, MANUAL_PAUSE_MS - 500);
    expect(b.el.scrollTop).toBe(3 * ROW);
    wheelAt(t); // touched again: the 15 s start over
    t = run(s, t, MANUAL_PAUSE_MS - 500);
    expect(b.el.scrollTop).toBe(3 * ROW);
    run(s, t, 2000);
    expect(b.el.scrollTop).toBeGreaterThan(3 * ROW);
  });

  it('a focus asked for while the result screen is still hidden waits for it to show', () => {
    const b = box(20, 9, { offsetTop: 14 * ROW, offsetHeight: 48 });
    b.el.offsetParent = null;
    const s = new AutoScroll(b.el as unknown as HTMLElement);
    s.focus();
    let t = run(s, 0, 500);
    b.el.offsetParent = {};
    run(s, t, 3000);
    expect(b.el.scrollTop).toBeGreaterThan(5 * ROW);
  });

  it('a hidden screen starts again from the top', () => {
    const b = box(20);
    const s = new AutoScroll(b.el as unknown as HTMLElement);
    let t = run(s, 0, HOLD_TOP_MS + 3000);
    expect(b.el.scrollTop).toBeGreaterThan(0);
    b.el.offsetParent = null;
    t = run(s, t, 100);
    b.el.offsetParent = {};
    run(s, t, HOLD_TOP_MS - 500);
    expect(b.el.scrollTop).toBe(0);
  });

  it("the result screen centres the contestant's row, holds on it, then carries on", () => {
    const b = box(20, 9, { offsetTop: 14 * ROW, offsetHeight: 48 });
    const s = new AutoScroll(b.el as unknown as HTMLElement);
    s.focus();
    let t = run(s, 0, 3000);
    const centred = 14 * ROW - (9 * ROW - 48) / 2;
    expect(b.el.scrollTop).toBeCloseTo(centred, 0);
    t = run(s, t, HOLD_FOCUS_MS - 1000);
    expect(b.el.scrollTop).toBeCloseTo(centred, 0);
    run(s, t, 3000);
    expect(b.el.scrollTop).toBeGreaterThan(centred);
  });

  it('a row that already shows from the top needs no scroll', () => {
    const b = box(20, 9, { offsetTop: 3 * ROW, offsetHeight: 48 });
    const s = new AutoScroll(b.el as unknown as HTMLElement);
    s.focus();
    run(s, 0, HOLD_FOCUS_MS - 500);
    expect(b.el.scrollTop).toBe(0);
  });

  it('reduced motion pages instead of gliding', () => {
    reduced = true;
    const b = box(30);
    const s = new AutoScroll(b.el as unknown as HTMLElement);
    let t = run(s, 0, HOLD_TOP_MS + 1000);
    expect(b.el.scrollTop).toBe(0);
    t = run(s, t, PAGE_MS);
    expect(b.el.scrollTop).toBe(8 * ROW); // one page, keeping a row of overlap
  });
});
