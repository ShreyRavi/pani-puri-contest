import { describe, expect, it } from 'vitest';
import * as R from '../src/round';

const P: R.Pending = { at: 0, openedAt: 0, peak: 0.6, confidence: 0.9, hand: true };
const bite = (t: number, openedAt = t - 300): R.Pending => ({ ...P, at: t, openedAt });

function liveAt(now = 0, durationMs = 60000, opts: R.StartOptions = {}): R.RoundState {
  return R.tick(R.start('Priya', durationMs, now, opts), now + R.ARMING_MS);
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
    s = R.candidate(s, bite(5000), 'hybrid', 5000);
    expect(s.count).toBe(0);
    expect(s.queue).toHaveLength(1);
    s = R.confirm(s, 5100);
    expect(s.count).toBe(1);
    expect(s.queue).toHaveLength(0);
    s = R.reject(R.candidate(s, bite(6000), 'hybrid', 6000), 6100);
    expect(s).toMatchObject({ count: 1, rejected: 1, queue: [] });
  });

  it('auto mode counts immediately, manual mode ignores the camera', () => {
    expect(R.candidate(liveAt(), bite(5000), 'auto', 5000).count).toBe(1);
    expect(R.candidate(liveAt(), bite(5000), 'manual', 5000)).toEqual(liveAt());
  });

  it('auto-confirms a pending candidate after the configured delay', () => {
    let s = R.candidate(liveAt(0, 60000, { autoConfirmMs: 2000 }), bite(5000), 'hybrid', 5000);
    expect(R.tick(s, 6000).count).toBe(0);
    s = R.tick(s, 7000);
    expect(s).toMatchObject({ count: 1, queue: [] });
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

  // Intentional change (O10, R9): zero always enters BUZZER for the detect window.
  it('enters the buzzer phase at zero and reaches the result after the detect window', () => {
    let s = R.tick(liveAt(0), 63000);
    expect(s.phase).toBe('buzzer');
    s = R.tick(s, 63000 + R.DEFAULT_DETECT_MS);
    expect(s.phase).toBe('result');
  });

  // Intentional change (O15): BUZZER lasts the full detect window even if the queue empties early.
  it('lets the referee confirm a waiting bite after the buzzer, then waits out the detect window', () => {
    let s = R.candidate(liveAt(0), bite(62500), 'hybrid', 62500);
    s = R.tick(s, 63000);
    expect(s.phase).toBe('buzzer');
    s = R.confirm(s, 63500);
    expect(s.count).toBe(1);
    expect(R.tick(s, 63600).phase).toBe('buzzer');
    expect(R.tick(s, 64500).phase).toBe('result');
  });

  // Intentional change (O15, DD4, DD10): leftovers are held until the 10 s cap, then not counted.
  it('holds an undecided bite until the cap, then marks it not counted', () => {
    let s = R.candidate(liveAt(0), bite(62500), 'hybrid', 62500);
    s = R.tick(s, 70000);
    expect(s.phase).toBe('buzzer');
    s = R.tick(s, 73000);
    expect(s).toMatchObject({ phase: 'result', count: 0, notCounted: 1, queue: [] });
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

describe('bite queue (R1, O4, DD10)', () => {
  it('queues two bites; Space and X act on the oldest', () => {
    let s = liveAt();
    s = R.candidate(s, { ...bite(5000), peak: 0.5 }, 'hybrid', 5000);
    s = R.candidate(s, { ...bite(5600), peak: 0.7 }, 'hybrid', 5600);
    expect(s.queue.map((b) => b.peak)).toEqual([0.5, 0.7]);
    s = R.reject(s, 6000);
    expect(s.queue.map((b) => b.peak)).toEqual([0.7]);
    s = R.confirm(s, 6100);
    expect(s).toMatchObject({ count: 1, rejected: 1, queue: [] });
  });

  // Intentional change (O15, DD10): overflow is not counted, not rejected.
  it('a 4th bite drops the oldest as not counted', () => {
    let s = liveAt();
    for (const t of [5000, 5500, 6000, 6500]) s = R.candidate(s, bite(t), 'hybrid', t);
    expect(s.queue.map((b) => b.at)).toEqual([5500, 6000, 6500]);
    expect(s).toMatchObject({ notCounted: 1, rejected: 0 });
  });

  it('Esc end turns waiting bites into not counted (R11)', () => {
    let s = R.candidate(R.candidate(liveAt(), bite(5000), 'hybrid', 5000), bite(5500), 'hybrid', 5500);
    s = R.end(s, 6000);
    expect(s).toMatchObject({ phase: 'result', notCounted: 2, queue: [] });
  });

  it('camera loss flushes the queue to not counted (O16)', () => {
    const s = R.goOffline(R.candidate(liveAt(), bite(5000), 'hybrid', 5000));
    expect(s).toMatchObject({ notCounted: 1, queue: [], dueAt: 0 });
  });
});

describe('auto-confirm timing (O14)', () => {
  const opts = { autoConfirmMs: 2000 };

  it('starts the next bite clock when it becomes the oldest', () => {
    let s = liveAt(0, 60000, opts);
    s = R.candidate(s, bite(5000), 'hybrid', 5000); // due 7000
    s = R.candidate(s, bite(5500), 'hybrid', 5500); // waits
    s = R.tick(s, 7000);
    expect(s).toMatchObject({ count: 1, dueAt: 9000 });
    expect(R.tick(s, 8999).count).toBe(1);
    expect(R.tick(s, 9000).count).toBe(2);
  });

  it('pause freezes the due time and resume shifts it', () => {
    let s = R.candidate(liveAt(0, 60000, opts), bite(5000), 'hybrid', 5000); // due 7000
    s = R.togglePause(s, 6000);
    expect(R.tick(s, 30000).count).toBe(0);
    s = R.togglePause(s, 30000); // shifted by 24000
    expect(s.dueAt).toBe(31000);
    expect(R.tick(s, 30999).count).toBe(0);
    expect(R.tick(s, 31000).count).toBe(1);
  });

  it('at the cap, leftovers auto-confirm when auto-confirm is on', () => {
    let s = liveAt(0, 60000, { autoConfirmMs: 5000 });
    for (const t of [62000, 62200, 62400]) s = R.candidate(s, bite(t), 'hybrid', t);
    s = R.tick(s, 80000);
    expect(s).toMatchObject({ phase: 'result', count: 3, notCounted: 0 });
  });
});

describe('after the buzzer (O10, O19, O20, DD4)', () => {
  it('accepts bites opened before zero during the detect window only', () => {
    let s = R.tick(liveAt(0), 63000);
    expect(R.candidate(s, bite(63400, 62900), 'hybrid', 63400).queue).toHaveLength(1);
    expect(R.candidate(s, bite(63400, 63100), 'hybrid', 63400).queue).toHaveLength(0);
    s = R.tick(s, 63000 + R.DEFAULT_DETECT_MS - 1);
    expect(R.candidate(s, bite(64600, 62900), 'hybrid', 64600).queue).toHaveLength(0);
  });

  it('derives the detect window from the bite window', () => {
    let s = R.tick(liveAt(0, 60000, { windowMs: 2500 }), 63000);
    expect(s.detectUntil).toBe(63000 + 2800);
    expect(R.candidate(s, bite(65500, 62950), 'hybrid', 65500).queue).toHaveLength(1);
  });

  it('pause works during the hold and shifts detect window and cap', () => {
    let s = R.candidate(liveAt(0), bite(62500), 'hybrid', 62500);
    s = R.tick(s, 64000);
    s = R.togglePause(s, 64000);
    expect(s).toMatchObject({ phase: 'paused', pausedFrom: 'buzzer' });
    expect(R.tick(s, 90000).phase).toBe('paused');
    s = R.togglePause(s, 90000);
    expect(s).toMatchObject({ phase: 'buzzer', capAt: 73000 + 26000 });
    expect(R.confirm(s, 90100).count).toBe(1);
  });

  it('Space still works while paused', () => {
    let s = R.togglePause(R.candidate(liveAt(), bite(5000), 'hybrid', 5000), 5500);
    s = R.confirm(s, 6000);
    expect(s).toMatchObject({ phase: 'paused', count: 1, queue: [] });
  });
});

describe('auto undo (O5, DD9)', () => {
  it('X with nothing waiting undoes the last auto count, one level only', () => {
    let s = R.candidate(liveAt(), bite(5000), 'auto', 5000);
    s = R.candidate(s, bite(6000), 'auto', 6000);
    expect(s).toMatchObject({ count: 2, undoable: true });
    s = R.reject(s, 6500, 'auto');
    expect(s).toMatchObject({ count: 1, rejected: 1, undoable: false });
    expect(R.reject(s, 6600, 'auto')).toEqual(s);
  });

  it('a manual change clears undo', () => {
    let s = R.candidate(liveAt(), bite(5000), 'auto', 5000);
    s = R.adjust(s, 1, 5100);
    expect(R.reject(s, 5200, 'auto').count).toBe(2);
  });
});

describe('buzzer trigger (DD3)', () => {
  it('fires once on leaving the running clock, including a multi-step refresh jump', () => {
    const live = liveAt(0);
    expect(R.buzzerDue(live, R.tick(live, 63000))).toBe(true);
    expect(R.buzzerDue(live, R.tick(live, 999999))).toBe(true);
    const buzz = R.tick(live, 63000);
    expect(R.buzzerDue(buzz, R.tick(buzz, 70000))).toBe(false);
    expect(R.buzzerDue(live, R.end(live, 10000))).toBe(true);
    expect(R.buzzerDue(R.start('A', 60000, 0), R.end(R.start('A', 60000, 0), 10))).toBe(false);
  });
});

// State-matrix cells found untested in the /ship review (round machine × paused/buzzer).
describe('paused and buzzer edge cells', () => {
  it('X while paused rejects the oldest bite and starts the next clock only after resume', () => {
    let s = liveAt(0, 60000, { autoConfirmMs: 2000 });
    s = R.candidate(s, bite(5000), 'hybrid', 5000);
    s = R.candidate(s, bite(5200), 'hybrid', 5200);
    s = R.togglePause(s, 5500);
    s = R.reject(s, 6000);
    expect(s).toMatchObject({ phase: 'paused', rejected: 1, count: 0 });
    expect(s.queue).toHaveLength(1);
    expect(R.tick(s, 30000).count).toBe(0); // frozen while paused
    const resumed = R.togglePause(s, 10000);
    expect(R.tick(resumed, 10000 + 1999).count).toBe(0);
    expect(R.tick(resumed, 10000 + 2001).count).toBe(1);
  });

  it('camera loss while paused flushes waiting bites to not counted and stays paused', () => {
    const s = R.goOffline(R.togglePause(R.candidate(liveAt(), bite(5000), 'hybrid', 5000), 5500));
    expect(s).toMatchObject({ phase: 'paused', notCounted: 1, queue: [], dueAt: 0 });
  });

  it('a 4th bite in the post-buzzer detect window drops the oldest as not counted', () => {
    let s = liveAt(0); // live 3000..63000
    for (const t of [62000, 62300, 62600]) s = R.candidate(s, bite(t), 'hybrid', t);
    s = R.tick(s, 63100);
    expect(s.phase).toBe('buzzer');
    s = R.candidate(s, bite(63200, 62900), 'hybrid', 63200); // mouth opened before zero
    expect(s).toMatchObject({ phase: 'buzzer', notCounted: 1, rejected: 0 });
    expect(s.queue.map((b) => b.at)).toEqual([62300, 62600, 63200]);
  });

  it('Esc during the buzzer hold ends with the waiting bite not counted', () => {
    let s = R.tick(R.candidate(liveAt(), bite(62500), 'hybrid', 62500), 63100);
    expect(s.phase).toBe('buzzer');
    s = R.end(s, 64000);
    expect(s).toMatchObject({ phase: 'result', notCounted: 1, queue: [], resultAt: 64000 });
  });

  it('camera loss in the buzzer flushes the queue and the result follows the detect window', () => {
    let s = R.tick(R.candidate(liveAt(), bite(62500), 'hybrid', 62500), 63100);
    s = R.goOffline(s);
    expect(s).toMatchObject({ phase: 'buzzer', notCounted: 1, queue: [] });
    expect(R.tick(s, 63000 + R.DEFAULT_DETECT_MS + 1).phase).toBe('result');
  });
});
