import { describe, expect, it } from 'vitest';
import * as R from '../src/round';

const P: R.Pending = { at: 0, peak: 0.6, confidence: 0.9, hand: true };

function liveAt(now = 0, durationMs = 60000): R.RoundState {
  return R.tick(R.start('Priya', durationMs, now), now + R.ARMING_MS);
}

describe('round machine', () => {
  it('arms for 3s then goes live with the full duration', () => {
    const s = R.start('  Priya ', 60000, 1000);
    expect(s.name).toBe('Priya');
    expect(R.armingCount(s, 1000)).toBe(3);
    expect(R.armingCount(s, 2500)).toBe(2);
    const live = R.tick(s, 4000);
    expect(live.phase).toBe('live');
    expect(R.remaining(live, 4000)).toBe(60000);
  });

  it('hybrid candidates wait for the referee; Space counts, X rejects', () => {
    let s = liveAt();
    s = R.candidate(s, P, 'hybrid', 5000);
    expect(s.count).toBe(0);
    expect(s.pending).not.toBeNull();
    s = R.confirm(s, 5100);
    expect(s.count).toBe(1);
    expect(s.pending).toBeNull();
    s = R.reject(R.candidate(s, P, 'hybrid', 6000));
    expect(s).toMatchObject({ count: 1, rejected: 1, pending: null });
  });

  it('auto mode counts immediately, manual mode ignores the camera', () => {
    expect(R.candidate(liveAt(), P, 'auto', 5000).count).toBe(1);
    expect(R.candidate(liveAt(), P, 'manual', 5000)).toEqual(liveAt());
  });

  it('auto-confirms a pending candidate after the configured delay', () => {
    let s = R.candidate(liveAt(), { ...P, at: 5000 }, 'hybrid', 5000);
    expect(R.tick(s, 6000, 2000).count).toBe(0);
    s = R.tick(s, 7000, 2000);
    expect(s).toMatchObject({ count: 1, pending: null });
  });

  it('manual adjust never goes below zero', () => {
    let s = R.adjust(liveAt(), -1, 4000);
    expect(s.count).toBe(0);
    s = R.adjust(R.adjust(s, 1, 4000), 1, 4000);
    expect(s.count).toBe(2);
  });

  it('pause freezes the clock and resume restores it', () => {
    let s = liveAt(0); // live from 3000, ends 63000
    s = R.togglePause(s, 13000);
    expect(s.phase).toBe('paused');
    expect(R.remaining(s, 40000)).toBe(50000);
    s = R.togglePause(s, 40000);
    expect(s.phase).toBe('live');
    expect(R.remaining(s, 41000)).toBe(49000);
  });

  it('goes straight to result at zero with nothing pending', () => {
    const s = R.tick(liveAt(0), 63000);
    expect(s.phase).toBe('result');
  });

  it('gives a pending candidate a 1.5s grace window after the buzzer', () => {
    let s = R.candidate(liveAt(0), P, 'hybrid', 62500);
    s = R.tick(s, 63000);
    expect(s.phase).toBe('buzzer');
    s = R.confirm(s, 63500);
    expect(s.count).toBe(1);
    s = R.tick(s, 63600);
    expect(s.phase).toBe('result');
  });

  it('drops an unconfirmed candidate when the grace window lapses', () => {
    let s = R.candidate(liveAt(0), P, 'hybrid', 62500);
    s = R.tick(s, 70000);
    expect(s).toMatchObject({ phase: 'result', count: 0, pending: null });
  });

  it('recovers correctly after a long gap (refresh mid-round)', () => {
    const saved = JSON.parse(JSON.stringify(R.adjust(liveAt(0), 1, 10000))) as R.RoundState;
    expect(R.tick(saved, 30000)).toMatchObject({ phase: 'live', count: 1 });
    expect(R.remaining(R.tick(saved, 30000), 30000)).toBe(33000);
    expect(R.tick(R.start('A', 60000, 0), 999999).phase).toBe('result');
  });

  it('Esc cancels arming, ends a live round with the count kept', () => {
    expect(R.end(R.start('A', 60000, 0), 100)).toEqual(R.IDLE);
    const s = R.end(R.adjust(liveAt(0), 1, 5000), 6000);
    expect(s).toMatchObject({ phase: 'result', count: 1, resultAt: 6000 });
  });

  it('returns to idle 20s after the result', () => {
    const s = R.end(liveAt(0), 6000);
    expect(R.shouldReturnToIdle(s, 25999)).toBe(false);
    expect(R.shouldReturnToIdle(s, 26000)).toBe(true);
  });

  it('records the last confirmed puri with the clock time', () => {
    const s = R.adjust(liveAt(0), 1, 18000);
    expect(s.last).toEqual({ count: 1, remaining: 45000 });
  });
});
