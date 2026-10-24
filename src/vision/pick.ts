// Sticky face picker: with several faces in frame, keep following the same
// contestant instead of jumping to whoever is momentarily biggest. Pure, so it
// runs in the worker and in tests.

export interface PickPoint {
  x: number;
  y: number;
}

export interface PickFace {
  /** face width in px (landmarks 234 to 454) */
  width: number;
  /** mouth center in px */
  mouth: PickPoint;
}

export interface PickState {
  /** mouth of the tracked face on the last frame it was seen; null = nothing tracked */
  mouth: PickPoint | null;
  /** width of the tracked face on the last frame it was seen */
  width: number;
  /** consecutive frames a different face has been at least SWITCH_RATIO wider */
  wider: number;
  /** consecutive frames without the tracked face */
  missing: number;
}

export interface PickResult {
  index: number | null;
  state: PickState;
  /** the tracked person changed (wider takeover, or re-acquired after a reset) */
  switched: boolean;
}

export const SWITCH_RATIO = 1.3;
export const SWITCH_FRAMES = 10;
export const RESET_FRAMES = 15;
/** A face whose mouth is farther than this many tracked-face widths from the last mouth is someone else. */
export const MAX_JUMP = 0.5;

export function pickFace(faces: PickFace[], prev: PickState | null): PickResult {
  const last = prev?.mouth ?? null;

  let widest = -1;
  for (let i = 0; i < faces.length; i++) if (widest < 0 || faces[i].width > faces[widest].width) widest = i;

  if (!last) {
    if (widest < 0) return { index: null, state: { mouth: null, width: 0, wider: 0, missing: (prev?.missing ?? 0) + 1 }, switched: false };
    // Nothing tracked: lock onto the closest (widest) face. After a reset that is a new person.
    return chosen(faces, widest, 0, prev !== null);
  }

  let nearest = -1;
  let best = Infinity;
  for (let i = 0; i < faces.length; i++) {
    const d = Math.hypot(faces[i].mouth.x - last.x, faces[i].mouth.y - last.y);
    if (d < best) {
      best = d;
      nearest = i;
    }
  }

  // The tracked face is not in this frame (occluded or turned away): never hand the lock to a
  // bystander. Keep the last position until it has been gone long enough to reset.
  if (nearest < 0 || best > MAX_JUMP * (prev?.width || faces[nearest].width)) {
    const missing = (prev?.missing ?? 0) + 1;
    const reset = missing >= RESET_FRAMES;
    return {
      index: null,
      state: { mouth: reset ? null : last, width: reset ? 0 : prev?.width ?? 0, wider: 0, missing },
      switched: false,
    };
  }

  const challenged = widest !== nearest && faces[widest].width >= SWITCH_RATIO * faces[nearest].width;
  const wider = challenged ? (prev?.wider ?? 0) + 1 : 0;
  if (wider >= SWITCH_FRAMES) return chosen(faces, widest, 0, true);
  return chosen(faces, nearest, wider, false);
}

function chosen(faces: PickFace[], index: number, wider: number, switched: boolean): PickResult {
  const { x, y } = faces[index].mouth;
  return { index, state: { mouth: { x, y }, width: faces[index].width, wider, missing: 0 }, switched };
}
