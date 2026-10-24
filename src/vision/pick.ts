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
  /** consecutive frames a different face has been at least SWITCH_RATIO wider */
  wider: number;
  /** consecutive frames with no face at all */
  missing: number;
}

export interface PickResult {
  index: number | null;
  state: PickState;
  switched: boolean;
}

export const SWITCH_RATIO = 1.3;
export const SWITCH_FRAMES = 10;
export const RESET_FRAMES = 15;

export function pickFace(faces: PickFace[], prev: PickState | null): PickResult {
  if (faces.length === 0) {
    // Keep the last mouth so the same face is re-acquired near the same spot,
    // until it has been gone long enough that the widest face should win again.
    const missing = (prev?.missing ?? 0) + 1;
    const mouth = missing >= RESET_FRAMES ? null : (prev?.mouth ?? null);
    return { index: null, state: { mouth, wider: 0, missing }, switched: false };
  }

  let widest = 0;
  for (let i = 1; i < faces.length; i++) if (faces[i].width > faces[widest].width) widest = i;

  const last = prev?.mouth;
  if (!last) return chosen(faces, widest, 0, false);

  let nearest = 0;
  let best = Infinity;
  for (let i = 0; i < faces.length; i++) {
    const d = Math.hypot(faces[i].mouth.x - last.x, faces[i].mouth.y - last.y);
    if (d < best) {
      best = d;
      nearest = i;
    }
  }

  const challenged = widest !== nearest && faces[widest].width >= SWITCH_RATIO * faces[nearest].width;
  const wider = challenged ? (prev?.wider ?? 0) + 1 : 0;
  if (wider >= SWITCH_FRAMES) return chosen(faces, widest, 0, true);
  return chosen(faces, nearest, wider, false);
}

function chosen(faces: PickFace[], index: number, wider: number, switched: boolean): PickResult {
  const { x, y } = faces[index].mouth;
  return { index, state: { mouth: { x, y }, wider, missing: 0 }, switched };
}
