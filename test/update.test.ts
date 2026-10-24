// Value: protects=a new deploy activates and reloads only when nothing on screen would be lost, and an expired undo
//   never blocks it; fails_when=promote and reload diverge, or a stale undo keeps updates off all night; why_new=the
//   busy rules had no test; seam=none; no_claim=a real service-worker handover (e2e covers offline only)
import { describe, expect, it } from 'vitest';
import { updateBlocked, type UpdateContext } from '../src/update';

const idle: UpdateContext = { phase: 'idle', setupOpen: false, dialogOpen: false, undoUntil: null, name: '', noticeShown: false };

describe('updateBlocked', () => {
  it('lets an update through at an empty sign-up screen', () => {
    expect(updateBlocked(idle, 1000)).toBe(false);
  });

  it.each([
    ['arming', { phase: 'arming' }],
    ['live', { phase: 'live' }],
    ['paused', { phase: 'paused' }],
    ['buzzer', { phase: 'buzzer' }],
    ['result reveal', { phase: 'result' }],
    ['Setup open', { setupOpen: true }],
    ['score dialog open', { dialogOpen: true }],
    ['a name being typed', { name: 'Pri' }],
    ['a sticky notice', { noticeShown: true }],
    ['a live undo offer', { undoUntil: 5000 }],
  ] as const)('holds it during %s', (_label, patch) => {
    expect(updateBlocked({ ...idle, ...patch } as UpdateContext, 1000)).toBe(true);
  });

  it('ignores an undo offer that has expired', () => {
    expect(updateBlocked({ ...idle, undoUntil: 900 }, 1000)).toBe(false);
  });

  it('treats a whitespace-only name as empty', () => {
    expect(updateBlocked({ ...idle, name: '   ' }, 1000)).toBe(false);
  });
});
