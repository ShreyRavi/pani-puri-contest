import { describe, expect, it } from 'vitest';
import { chaseLine } from '../src/ui/board';
import { rankOf, shortOfBoard, type Result } from '../src/store';

const res = (name: string, score: number, at: number): Result => ({ id: `${name}-${at}`, name, score, rejected: 0, notCounted: 0, seconds: 60, at });

describe('chase line', () => {
  it('invites the first contestant of the night', () => {
    expect(chaseLine([], 0)).toBe('First on the board tonight');
    expect(chaseLine([], 3)).toBe('Leading the board!');
  });

  it('names the next person to pass, honoring the earlier-wins tiebreak', () => {
    const board = [res('Arjun', 12, 1), res('Meera', 9, 2), res('Ravi', 9, 3)];
    expect(chaseLine(board, 5)).toBe('5 more to pass Ravi');
    // Tying Ravi is not passing him: the earlier score wins.
    expect(chaseLine(board, 9)).toBe('1 more to pass Ravi');
    expect(chaseLine(board, 10)).toBe('3 more to pass Arjun');
    expect(chaseLine(board, 12)).toBe('1 more to pass Arjun');
    expect(chaseLine(board, 13)).toBe('Leading the board!');
  });
});

describe('board placement (DD11)', () => {
  const ten = Array.from({ length: 10 }, (_, i) => res(`P${i}`, 20 - i, i)); // scores 20..11

  it('is 0 short when the board has room', () => {
    const me = res('Me', 0, 99);
    expect(shortOfBoard(0, me.id, [...ten.slice(0, 9), me])).toBe(0);
  });

  it('needs one more than the 10th score, since ties go to the earlier finisher', () => {
    const me = res('Me', 11, 99);
    const all = [...ten, me];
    expect(rankOf(me.id, all)).toBe(11);
    expect(shortOfBoard(11, me.id, all)).toBe(1);
    expect(shortOfBoard(4, me.id, all)).toBe(8);
  });

  it('is 0 once the score is on the board', () => {
    const me = res('Me', 15, 99);
    const all = [...ten, me];
    expect(rankOf(me.id, all)).toBeLessThanOrEqual(10);
    expect(shortOfBoard(15, me.id, all)).toBe(0);
  });
});
