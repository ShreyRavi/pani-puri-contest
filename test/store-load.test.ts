import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  });
});

const liveRound = (count: number) => ({ phase: 'live', name: 'Priya', count, durationMs: 60000, endsAt: 1000, savedAt: 1000, queue: [] });

describe('store load (O12 + review fix)', () => {
  it('discards a stale round with nothing counted and reports it once', async () => {
    mem.set('ppc.round.v1', JSON.stringify(liveRound(0)));
    const S = await import('../src/store');
    S.recoverSavedRound();
    expect(S.getRound().phase).toBe('idle');
    expect(S.takeExpired()).toMatchObject({ name: 'Priya', savedAt: 1000, saved: 0 });
    expect(S.takeExpired()).toBeNull();
    expect(S.allResults()).toHaveLength(0);
    expect(JSON.parse(mem.get('ppc.round.v1')!).phase).toBe('idle');
  });

  // Value: protects=loading the store module writes nothing (a second, locked-out tab must not touch the owner's board);
  //   fails_when=stale-round recovery runs at import again; why_new=every other case calls recoverSavedRound itself;
  //   seam=none; no_claim=the tab lock itself (e2e)
  it('writes nothing until recoverSavedRound is called', async () => {
    const saved = JSON.stringify(liveRound(7));
    mem.set('ppc.round.v1', saved);
    const S = await import('../src/store');
    expect(mem.get('ppc.round.v1')).toBe(saved);
    expect(mem.has('ppc.results.v1')).toBe(false);
    expect(S.allResults()).toHaveLength(0);
    S.recoverSavedRound();
    expect(S.allResults()).toHaveLength(1);
  });

  it('saves a stale round that has a count instead of losing the score', async () => {
    mem.set('ppc.round.v1', JSON.stringify({ ...liveRound(7), rejected: 1, queue: [{ at: 1, openedAt: 1, peak: 0.6, confidence: 0.9, hand: true }] }));
    const S = await import('../src/store');
    S.recoverSavedRound();
    expect(S.getRound().phase).toBe('idle');
    expect(S.allResults()).toEqual([expect.objectContaining({ name: 'Priya', score: 7, rejected: 1, notCounted: 1, seconds: 60 })]);
    expect(S.takeExpired()).toMatchObject({ name: 'Priya', saved: 7 });
  });

  it('survives corrupt saved results', async () => {
    mem.set('ppc.results.v1', JSON.stringify({ not: 'an array' }));
    let S = await import('../src/store');
    expect(S.allResults()).toEqual([]);
    vi.resetModules();
    mem.set('ppc.results.v1', JSON.stringify([null, 'x', { id: 'a', name: 'A', score: 3, at: 1 }]));
    S = await import('../src/store');
    expect(S.allResults().map((r) => r.name)).toEqual(['A']);
  });

  it('restoreResult puts a removed entry back once, with its id', async () => {
    const S = await import('../src/store');
    S.recoverSavedRound();
    const r = S.addResult({ name: 'A', score: 3, rejected: 0, notCounted: 0, seconds: 60, at: 1 });
    const removed = S.removeResult(r.id)!;
    expect(removed.id).toBe(r.id);
    S.restoreResult(removed);
    S.restoreResult(removed);
    expect(S.allResults().filter((x) => x.id === r.id)).toHaveLength(1);
  });
});

describe('stale save ticks first (cycle-2 fix)', () => {
  it('counts bites that would have auto-confirmed before the round ended', async () => {
    mem.set('ppc.round.v1', JSON.stringify({ phase: 'live', name: 'Ria', count: 2, durationMs: 60000, endsAt: 63000, savedAt: 60000, autoConfirmMs: 1000, dueAt: 61000, queue: [{ at: 60000, openedAt: 59800, peak: 0.6, confidence: 0.9, hand: true }] }));
    const S = await import('../src/store');
    S.recoverSavedRound();
    expect(S.allResults()).toEqual([expect.objectContaining({ name: 'Ria', score: 3, notCounted: 0 })]);
  });
});

describe('stale save replays the post-buzzer hold (cycle-3 fix)', () => {
  it('auto-confirms a bite due after zero, as an open tab would', async () => {
    mem.set('ppc.round.v1', JSON.stringify({ phase: 'live', name: 'Dev', count: 1, durationMs: 60000, endsAt: 63000, savedAt: 62000, autoConfirmMs: 2000, dueAt: 64000, detectMs: 1500, queue: [{ at: 62000, openedAt: 61800, peak: 0.6, confidence: 0.9, hand: true }] }));
    const S = await import('../src/store');
    S.recoverSavedRound();
    expect(S.allResults()).toEqual([expect.objectContaining({ name: 'Dev', score: 2, notCounted: 0 })]);
  });
});
