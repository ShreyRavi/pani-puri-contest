// Pure round state machine. Every transition takes `now` (wall-clock ms) so a
// persisted round can be restored after a refresh and tested without timers.
//
// IDLE -> ARMING (3-2-1) -> LIVE <-> PAUSED -> BUZZER (detect, then hold) -> RESULT -> IDLE
//                                      BUZZER <-> PAUSED
//
// Waiting bites (hybrid mode) live in a FIFO `queue` of at most MAX_QUEUE. Only
// the oldest has an auto-confirm clock (`dueAt`); pausing freezes it.
//
// After 0:00 the round stays in BUZZER: bites whose mouth opened before zero are
// still accepted until `detectUntil` (bite window + latency margin), then the
// round holds until the queue is decided, capped at CAP_MS after zero.

import { DEFAULT_DETECTOR } from './detector';

export type Phase = 'idle' | 'arming' | 'live' | 'paused' | 'buzzer' | 'result';
export type CountMode = 'auto' | 'hybrid' | 'manual';

export const ARMING_MS = 3000;
export const CAP_MS = 10000;
export const LATENCY_MARGIN_MS = 300;
/** Fallback detect window: the detector's default bite window + the latency margin. */
export const DEFAULT_DETECT_MS = DEFAULT_DETECTOR.windowMs + LATENCY_MARGIN_MS;
export const MAX_QUEUE = 3;
export const RESULT_IDLE_MS = 20000;

export interface Pending {
  /** wall-clock ms when the candidate reached the round */
  at: number;
  /** wall-clock ms when the mouth crossed the open line */
  openedAt: number;
  peak: number;
  confidence: number;
  hand: boolean;
}

export interface RoundState {
  phase: Phase;
  name: string;
  durationMs: number;
  /** post-buzzer detect window: bite window + latency margin */
  detectMs: number;
  /** 0 = off */
  autoConfirmMs: number;
  count: number;
  /** decided "not a puri" by the referee (X, or Auto-mode undo) */
  rejected: number;
  /** spotted but never decided: queue overflow, grace cap, Esc end, camera loss */
  notCounted: number;
  armingEndsAt: number;
  endsAt: number;
  detectUntil: number;
  capAt: number;
  /** remaining round ms while paused from LIVE */
  pausedRemaining: number;
  pausedAt: number;
  pausedFrom: 'live' | 'buzzer' | null;
  resultAt: number;
  queue: Pending[];
  /** auto-confirm deadline for queue[0]; 0 when none */
  dueAt: number;
  /** last confirmed puri: count and round-clock remaining ms */
  last: { count: number; remaining: number } | null;
  /** the latest count came from an auto candidate and can be undone with X */
  undoable: boolean;
  /** id of the saved leaderboard entry once the round reaches RESULT */
  resultId: string | null;
}

export const IDLE: RoundState = {
  phase: 'idle',
  name: '',
  durationMs: 60000,
  detectMs: DEFAULT_DETECT_MS,
  autoConfirmMs: 0,
  count: 0,
  rejected: 0,
  notCounted: 0,
  armingEndsAt: 0,
  endsAt: 0,
  detectUntil: 0,
  capAt: 0,
  pausedRemaining: 0,
  pausedAt: 0,
  pausedFrom: null,
  resultAt: 0,
  queue: [],
  dueAt: 0,
  last: null,
  undoable: false,
  resultId: null,
};

export interface StartOptions {
  /** detector bite window; the post-buzzer detect window is this + LATENCY_MARGIN_MS */
  windowMs?: number;
  autoConfirmMs?: number;
}

export function start(name: string, durationMs: number, now: number, opts: StartOptions = {}): RoundState {
  return {
    ...IDLE,
    phase: 'arming',
    name: name.trim(),
    durationMs,
    detectMs: opts.windowMs != null ? opts.windowMs + LATENCY_MARGIN_MS : DEFAULT_DETECT_MS,
    autoConfirmMs: opts.autoConfirmMs ?? 0,
    armingEndsAt: now + ARMING_MS,
  };
}

export function remaining(s: RoundState, now: number): number {
  switch (s.phase) {
    case 'arming':
      return s.durationMs;
    case 'live':
      return Math.max(0, s.endsAt - now);
    case 'paused':
      return s.pausedFrom === 'live' ? s.pausedRemaining : 0;
    default:
      return 0;
  }
}

/** Seconds left on the 3-2-1, as an integer 3..1, or 0 once done. */
export function armingCount(s: RoundState, now: number): number {
  return s.phase === 'arming' ? Math.max(0, Math.ceil((s.armingEndsAt - now) / 1000)) : 0;
}

/** Advance time-driven transitions. Loops so a long gap (refresh) lands in the right phase. */
export function tick(s: RoundState, now: number): RoundState {
  for (;;) {
    const next = step(s, now);
    if (next === s) return s;
    s = next;
  }
}

function step(s: RoundState, now: number): RoundState {
  if (s.phase === 'arming' && now >= s.armingEndsAt) {
    return { ...s, phase: 'live', endsAt: s.armingEndsAt + s.durationMs };
  }
  const deciding = s.phase === 'live' || s.phase === 'buzzer';
  if (deciding && s.queue.length && s.dueAt > 0 && now >= s.dueAt) {
    // Never auto-confirm past the end of the phase the bite belongs to.
    const limit = s.phase === 'live' ? s.endsAt : s.capAt;
    if (s.dueAt <= limit) return confirm(s, s.dueAt);
  }
  if (s.phase === 'live' && now >= s.endsAt) {
    return { ...s, phase: 'buzzer', detectUntil: s.endsAt + s.detectMs, capAt: s.endsAt + CAP_MS };
  }
  if (s.phase === 'buzzer') {
    if (now >= s.capAt) {
      // Cap: auto-confirm leftovers when auto-confirm is on, else they were never decided.
      const n = s.queue.length;
      const decided = s.autoConfirmMs > 0 ? bump(s, n, s.capAt, false) : { ...s, notCounted: s.notCounted + n };
      return { ...decided, phase: 'result', queue: [], dueAt: 0, resultAt: s.capAt };
    }
    if (now >= s.detectUntil && !s.queue.length) {
      return { ...s, phase: 'result', dueAt: 0, resultAt: Math.max(s.detectUntil, Math.min(now, s.capAt)) };
    }
  }
  return s;
}

/** Can a candidate whose mouth opened at `openedAt` still enter this round at `now`? */
export function accepts(s: RoundState, openedAt: number, now: number): boolean {
  if (s.phase === 'live') {
    // A mouth that opened during the 3-2-1 is not a bite of this round.
    if (openedAt < s.armingEndsAt) return false; // GO; endsAt moves with pauses, armingEndsAt does not
    // Past 0:00 but not yet ticked to the buzzer (the frame loop hasn't run): same rule as the buzzer.
    if (now >= s.endsAt) return openedAt < s.endsAt && now < s.endsAt + s.detectMs;
    return true;
  }
  if (s.phase === 'buzzer') return now < s.detectUntil && openedAt < s.endsAt;
  return false;
}

export function candidate(s: RoundState, c: Pending, mode: CountMode, now: number): RoundState {
  if (mode === 'manual' || !accepts(s, c.openedAt, now)) return s;
  if (mode === 'auto') return bump(s, 1, now, true);
  let queue = [...s.queue, c];
  let notCounted = s.notCounted;
  let dueAt = s.dueAt;
  if (queue.length > MAX_QUEUE) {
    queue = queue.slice(1);
    notCounted += 1;
    dueAt = due(s, now);
  } else if (s.queue.length === 0) {
    dueAt = due(s, now);
  }
  return { ...s, queue, notCounted, dueAt };
}

/** Auto-confirm deadline for a bite that becomes the oldest at `now`. Frozen while paused. */
function due(s: RoundState, now: number): number {
  if (s.autoConfirmMs <= 0) return 0;
  const clock = s.phase === 'paused' ? s.pausedAt : now;
  return clock + s.autoConfirmMs;
}

function canDecide(s: RoundState): boolean {
  return s.phase === 'live' || s.phase === 'buzzer' || s.phase === 'paused';
}

/** Space: count the oldest waiting bite. */
export function confirm(s: RoundState, now: number): RoundState {
  if (!s.queue.length || !canDecide(s)) return s;
  const queue = s.queue.slice(1);
  const counted = bump(s, 1, now, false);
  return { ...counted, queue, dueAt: queue.length ? due(s, now) : 0 };
}

/** X: reject the oldest waiting bite; in Auto mode with nothing waiting, undo the last auto count. */
export function reject(s: RoundState, now: number, mode: CountMode = 'hybrid'): RoundState {
  if (!canDecide(s)) return s;
  if (s.queue.length) {
    const queue = s.queue.slice(1);
    return { ...s, queue, rejected: s.rejected + 1, dueAt: queue.length ? due(s, now) : 0 };
  }
  if (mode === 'auto' && s.undoable && s.count > 0) {
    const count = s.count - 1;
    const last = s.last && s.last.count > count ? null : s.last;
    return { ...s, count, last, rejected: s.rejected + 1, undoable: false };
  }
  return s;
}

/** Manual +1 / -1. Works in every in-round phase and on the result screen (Fix score). */
export function adjust(s: RoundState, delta: number, now: number): RoundState {
  if (s.phase === 'idle' || s.phase === 'arming') return s;
  return bump(s, delta, now, false);
}

function bump(s: RoundState, delta: number, now: number, fromAuto: boolean): RoundState {
  const count = Math.max(0, s.count + delta);
  const last = delta > 0 ? { count, remaining: remaining(s, now) } : s.last;
  return { ...s, count, last, undoable: fromAuto && delta > 0 };
}

/** P: freeze whatever clock is running (round timer in LIVE, detect window and cap in BUZZER). */
export function togglePause(s: RoundState, now: number): RoundState {
  if (s.phase === 'live') {
    return { ...s, phase: 'paused', pausedFrom: 'live', pausedAt: now, pausedRemaining: Math.max(0, s.endsAt - now) };
  }
  if (s.phase === 'buzzer') {
    return { ...s, phase: 'paused', pausedFrom: 'buzzer', pausedAt: now };
  }
  if (s.phase === 'paused') {
    const shift = Math.max(0, now - s.pausedAt);
    const dueAt = s.dueAt > 0 ? s.dueAt + shift : 0;
    if (s.pausedFrom === 'buzzer') {
      return { ...s, phase: 'buzzer', pausedFrom: null, dueAt, detectUntil: s.detectUntil + shift, capAt: s.capAt + shift };
    }
    return { ...s, phase: 'live', pausedFrom: null, dueAt, endsAt: now + s.pausedRemaining };
  }
  return s;
}

/** Esc: end the round early (keeps the count; undecided bites become not counted) or cancel the countdown. */
export function end(s: RoundState, now: number): RoundState {
  if (s.phase === 'arming') return IDLE;
  if (s.phase === 'live' || s.phase === 'paused' || s.phase === 'buzzer') {
    return { ...s, phase: 'result', notCounted: s.notCounted + s.queue.length, queue: [], dueAt: 0, resultAt: now };
  }
  return s;
}

/** Camera lost: nothing on screen can show waiting bites, so they become not counted. */
export function goOffline(s: RoundState): RoundState {
  if (!s.queue.length) return s;
  return { ...s, notCounted: s.notCounted + s.queue.length, queue: [], dueAt: 0 };
}

/** True once per round, on the commit that leaves the running clock (0:00 or an early end). */
export function buzzerDue(before: RoundState, next: RoundState): boolean {
  const wasRunning = before.phase === 'live' || (before.phase === 'paused' && before.pausedFrom === 'live');
  const stillRunning = next.phase === 'live' || (next.phase === 'paused' && next.pausedFrom === 'live');
  return wasRunning && !stillRunning && next.phase !== 'idle';
}

export function shouldReturnToIdle(s: RoundState, now: number): boolean {
  return s.phase === 'result' && now - s.resultAt >= RESULT_IDLE_MS;
}

export function isInRound(s: RoundState): boolean {
  return s.phase === 'arming' || s.phase === 'live' || s.phase === 'paused' || s.phase === 'buzzer';
}

/** Latest wall-clock moment the round could still legitimately be running, for staleness checks. */
export function runningUntil(s: RoundState, savedAt: number): number {
  switch (s.phase) {
    case 'arming':
      return s.armingEndsAt + s.durationMs;
    case 'live':
      return s.endsAt;
    case 'buzzer':
      return s.capAt;
    case 'paused':
      return savedAt || s.pausedAt || s.endsAt;
    default:
      return Infinity;
  }
}
