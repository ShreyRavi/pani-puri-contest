// Is the picture too dark to track? Pure, so it can be tested.
//  - 'crowd': brightness only (no face between contestants is normal).
//  - 'setup': also flag when the face is found in under half of recent frames.

export type DarkKind = 'crowd' | 'setup';

export const DARK_LUMA = 45;

export function isTooDark(input: { samples: number; faceRate: number; luma: number }, kind: DarkKind): boolean {
  if (input.luma < DARK_LUMA) return true;
  return kind === 'setup' && input.samples > 10 && input.faceRate < 0.5;
}
