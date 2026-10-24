// Pure round state machine. Every transition takes `now` (wall-clock ms) so a
// persisted round can be restored after a refresh and tested without timers.
//
// IDLE -> ARMING (3-2-1) -> LIVE <-> PAUSED -> BUZZER (grace) -> RESULT -> IDLE

export type Phase = 'idle' | 'arming' | 'live' | 'paused' | 'buzzer' | 'result';
export type CountMode = 'auto' | 'hybrid' | 'manual';

export const ARMING_MS = 3000;
export const GRACE_MS = 1500;
export const RESULT_IDLE_MS = 20000;

export interface Pending {
  at: number;
  peak: number;
  confidence: number;
  hand: boolean;
}

export interface RoundState {
  phase: Phase;
  name: string;
  durationMs: number;
  count: number;
  rejected: number;
  armingEndsAt: number;
  endsAt: number;
  /** remaining ms while paused */
  pausedRemaining: number;
  graceEndsAt: number;
  resultAt: number;
  pending: Pending | null;
  /** last confirmed puri: count and round-clock remaining ms */
  last: { count: number; remaining: number } | null;
  /** id of the saved leaderboard entry once the round reaches RESULT */
  resultId: string | null;
}

export const IDLE: RoundState = {
  phase: 'idle',
  name: '',
  durationMs: 60000,
  count: 0,
  rejected: 0,
  armingEndsAt: 0,
  endsAt: 0,
  pausedRemaining: 0,
  graceEndsAt: 0,
  resultAt: 0,
  pending: null,
  last: null,
  resultId: null,
};

export function start(name: string, durationMs: number, now: number): RoundState {
  return { ...IDLE, phase: 'arming', name: name.trim(), durationMs, armingEndsAt: now + ARMING_MS };
}

export function remaining(s: RoundState, now: number): number {
  switch (s.phase) {
    case 'arming':
      return s.durationMs;
    case 'live':
      return Math.max(0, s.endsAt - now);
    case 'paused':
      return s.pausedRemaining;
    default:
      return 0;
  }
}

/** Seconds left on the 3-2-1, as an integer 3..1, or 0 once done. */
export function armingCount(s: RoundState, now: number): number {
  return s.phase === 'arming' ? Math.max(0, Math.ceil((s.armingEndsAt - now) / 1000)) : 0;
}

/** Advance time-driven transitions. Loops so a long gap (refresh) lands in the right phase. */
export function tick(s: RoundState, now: number, autoConfirmMs = 0): RoundState {
  for (;;) {
    const next = step(s, now, autoConfirmMs);
    if (next === s) return s;
    s = next;
  }
}

function step(s: RoundState, now: number, autoConfirmMs: number): RoundState {
  if (s.phase === 'arming' && now >= s.armingEndsAt) {
    return { ...s, phase: 'live', endsAt: s.armingEndsAt + s.durationMs };
  }
  if ((s.phase === 'live' || s.phase === 'buzzer') && s.pending && autoConfirmMs > 0 && now >= s.pending.at + autoConfirmMs) {
    return confirm(s, s.pending.at + autoConfirmMs);
  }
  if (s.phase === 'live' && now >= s.endsAt) {
    // Only a pending candidate earns the grace window; otherwise straight to the result.
    return s.pending
      ? { ...s, phase: 'buzzer', graceEndsAt: s.endsAt + GRACE_MS }
      : { ...s, phase: 'result', resultAt: s.endsAt };
  }
  if (s.phase === 'buzzer' && (now >= s.graceEndsAt || !s.pending)) {
    return { ...s, phase: 'result', pending: null, resultAt: Math.min(now, s.graceEndsAt) };
  }
  return s;
}

export function candidate(s: RoundState, c: Pending, mode: CountMode, now: number): RoundState {
  if (s.phase !== 'live' || mode === 'manual') return s;
  if (mode === 'auto') return bump(s, 1, now);
  return { ...s, pending: c };
}

export function confirm(s: RoundState, now: number): RoundState {
  if (!s.pending || (s.phase !== 'live' && s.phase !== 'buzzer')) return s;
  return { ...bump(s, 1, now), pending: null };
}

export function reject(s: RoundState): RoundState {
  if (!s.pending) return s;
  return { ...s, pending: null, rejected: s.rejected + 1 };
}

/** Manual +1 / -1. Works in every in-round phase and on the result screen (Fix score). */
export function adjust(s: RoundState, delta: number, now: number): RoundState {
  if (s.phase === 'idle' || s.phase === 'arming') return s;
  return bump(s, delta, now);
}

function bump(s: RoundState, delta: number, now: number): RoundState {
  const count = Math.max(0, s.count + delta);
  const last = delta > 0 ? { count, remaining: remaining(s, now) } : s.last;
  return { ...s, count, last };
}

export function togglePause(s: RoundState, now: number): RoundState {
  if (s.phase === 'live') return { ...s, phase: 'paused', pausedRemaining: Math.max(0, s.endsAt - now), pending: null };
  if (s.phase === 'paused') return { ...s, phase: 'live', endsAt: now + s.pausedRemaining };
  return s;
}

/** Esc: end the round early (keeps the count) or cancel the countdown. */
export function end(s: RoundState, now: number): RoundState {
  if (s.phase === 'arming') return IDLE;
  if (s.phase === 'live' || s.phase === 'paused' || s.phase === 'buzzer') {
    return { ...s, phase: 'result', pending: null, resultAt: now };
  }
  return s;
}

export function shouldReturnToIdle(s: RoundState, now: number): boolean {
  return s.phase === 'result' && now - s.resultAt >= RESULT_IDLE_MS;
}

export function isInRound(s: RoundState): boolean {
  return s.phase === 'arming' || s.phase === 'live' || s.phase === 'paused' || s.phase === 'buzzer';
}
