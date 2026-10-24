import { describe, expect, it } from 'vitest';
import { isTooDark } from '../src/vision/health';
import { pickFace, type PickFace, type PickState } from '../src/vision/pick';

const face = (x: number, y: number, width: number): PickFace => ({ width, mouth: { x, y } });

// Feed frames in order, return each frame's result.
function run(frames: PickFace[][], prev: PickState | null = null) {
  const out: ReturnType<typeof pickFace>[] = [];
  let state = prev;
  for (const f of frames) {
    const r = pickFace(f, state);
    state = r.state;
    out.push(r);
  }
  return out;
}

describe('pickFace', () => {
  it('picks the widest face on the first frame', () => {
    const r = pickFace([face(100, 200, 120), face(400, 200, 180), face(550, 220, 90)], null);
    expect(r.index).toBe(1);
    expect(r.switched).toBe(false);
    expect(r.state.mouth).toEqual({ x: 400, y: 200 });
  });

  it('sticks to the tracked face when two similar faces move slightly', () => {
    // Left face starts slightly wider so it is picked; then the right one becomes
    // slightly wider (under 30%) and the order in the array flips around.
    const frames: PickFace[][] = [[face(150, 240, 160), face(450, 240, 150)]];
    for (let i = 1; i < 30; i++) {
      const left = face(150 + (i % 3) * 4, 240 - (i % 2) * 3, 150);
      const right = face(450 - (i % 3) * 4, 240 + (i % 2) * 3, 180);
      frames.push(i % 2 ? [right, left] : [left, right]);
    }
    const out = run(frames);
    out.forEach((r, i) => {
      const chosen = frames[i][r.index!];
      expect(chosen.mouth.x).toBeLessThan(300);
      expect(r.switched).toBe(false);
    });
  });

  it('switches only after 10 consecutive frames of a 30%+ wider face', () => {
    const tracked = face(150, 240, 100);
    const big = face(450, 240, 140); // 40% wider
    const first = pickFace([tracked], null);

    // 9 frames wider, then one frame where it is not, resets the count.
    let state = first.state;
    for (let i = 0; i < 9; i++) {
      const r = pickFace([tracked, big], state);
      expect(r.index).toBe(0);
      state = r.state;
    }
    state = pickFace([tracked, face(450, 240, 125)], state).state; // only 25% wider
    for (let i = 0; i < 9; i++) {
      const r = pickFace([tracked, big], state);
      expect(r.index).toBe(0);
      expect(r.switched).toBe(false);
      state = r.state;
    }
    const tenth = pickFace([tracked, big], state);
    expect(tenth.index).toBe(1);
    expect(tenth.switched).toBe(true);

    // Now tracking the big face; no further switch.
    const after = pickFace([tracked, big], tenth.state);
    expect(after.index).toBe(1);
    expect(after.switched).toBe(false);
  });

  it('returns null for an empty frame and re-acquires near the same spot', () => {
    const first = pickFace([face(150, 240, 100), face(450, 240, 120)], null);
    expect(first.index).toBe(1);
    let state = first.state;
    for (let i = 0; i < 5; i++) {
      const r = pickFace([], state);
      expect(r.index).toBeNull();
      expect(r.switched).toBe(false);
      state = r.state;
    }
    expect(state.mouth).toEqual({ x: 450, y: 240 });
    // The other face is now wider, but the tracked one comes back near its old spot.
    const back = pickFace([face(140, 240, 150), face(455, 245, 120)], state);
    expect(back.index).toBe(1);
  });

  it('handles an empty first frame', () => {
    const r = pickFace([], null);
    expect(r.index).toBeNull();
    expect(pickFace([face(10, 10, 50), face(300, 10, 90)], r.state).index).toBe(1);
  });

  it('resets after 15 empty frames so the widest face wins', () => {
    const first = pickFace([face(150, 240, 100), face(450, 240, 120)], null);
    const empties = run(Array.from({ length: 15 }, () => []), first.state);
    const state = empties[empties.length - 1].state;
    expect(state.mouth).toBeNull();
    expect(pickFace([face(150, 240, 150), face(450, 240, 120)], state).index).toBe(0);

    // 14 empty frames is not enough.
    const fewer = run(Array.from({ length: 14 }, () => []), first.state);
    expect(pickFace([face(150, 240, 150), face(450, 240, 120)], fewer[13].state).index).toBe(1);
  });
});

describe('isTooDark', () => {
  it('crowd: only luma counts', () => {
    expect(isTooDark({ samples: 60, faceRate: 0, luma: 120 }, 'crowd')).toBe(false);
    expect(isTooDark({ samples: 60, faceRate: 1, luma: 44 }, 'crowd')).toBe(true);
    expect(isTooDark({ samples: 60, faceRate: 1, luma: 45 }, 'crowd')).toBe(false);
  });

  it('setup: low face rate with enough samples, or low luma', () => {
    expect(isTooDark({ samples: 11, faceRate: 0.4, luma: 120 }, 'setup')).toBe(true);
    expect(isTooDark({ samples: 10, faceRate: 0.4, luma: 120 }, 'setup')).toBe(false);
    expect(isTooDark({ samples: 60, faceRate: 0.5, luma: 120 }, 'setup')).toBe(false);
    expect(isTooDark({ samples: 0, faceRate: 1, luma: 30 }, 'setup')).toBe(true);
  });
});
