// When a new deploy may take over. Activating the new service worker deletes the old build's cache, so the
// page must be able to reload right away: promote and reload share this one rule.

import type { Phase } from './round';

export interface UpdateContext {
  phase: Phase;
  setupOpen: boolean;
  dialogOpen: boolean;
  /** end of a pending Discard / Re-run undo offer, or null */
  undoUntil: number | null;
  /** anything typed in the name field */
  name: string;
  /** a sticky notice the referee has not dismissed yet */
  noticeShown: boolean;
}

/** True while an update would interrupt the referee: a round or its result, an undo, Setup, a name, a notice. */
export function updateBlocked(c: UpdateContext, now: number): boolean {
  return (
    c.phase !== 'idle' ||
    c.setupOpen ||
    c.dialogOpen ||
    (c.undoUntil != null && now <= c.undoUntil) ||
    c.name.trim() !== '' ||
    c.noticeShown
  );
}
