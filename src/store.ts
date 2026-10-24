// App state persisted to localStorage: settings, every finished round, and the
// in-progress round so a refresh mid-round recovers.

import { DEFAULT_DETECTOR, type DetectorMode } from './detector';
import { CAP_MS, end, IDLE, isInRound, runningUntil, tick, type CountMode, type Pending, type RoundState } from './round';

export type SoundMode = 'all' | 'buzzer' | 'muted';
export type DetectionMode = DetectorMode;

export interface Settings {
  cameraId: string;
  roundSeconds: number;
  mode: CountMode;
  autoConfirmSeconds: number;
  sound: SoundMode;
  detection: DetectionMode;
  open: number;
  close: number;
  drop: number;
  windowSeconds: number;
  cooldownSeconds: number;
  requireHand: boolean;
  eventLine: string;
}

export interface Result {
  id: string;
  name: string;
  score: number;
  rejected: number;
  notCounted: number;
  seconds: number;
  at: number;
}

export const DEFAULT_SETTINGS: Settings = {
  cameraId: '',
  roundSeconds: 60,
  mode: 'hybrid',
  autoConfirmSeconds: 0,
  sound: 'all',
  detection: 'absolute',
  open: DEFAULT_DETECTOR.open,
  close: DEFAULT_DETECTOR.close,
  drop: DEFAULT_DETECTOR.drop,
  windowSeconds: DEFAULT_DETECTOR.windowMs / 1000,
  cooldownSeconds: DEFAULT_DETECTOR.cooldownMs / 1000,
  requireHand: false,
  eventLine: 'Stall No. 7 · Carnival Corner',
};

/** A saved round older than this past its end is discarded instead of replayed (O12). */
export const STALE_ROUND_MS = 5 * 60 * 1000;

const KEYS = { settings: 'ppc.settings.v1', results: 'ppc.results.v1', round: 'ppc.round.v1' } as const;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the night goes on, the board just won't survive a refresh.
  }
}

/** Load guard for rounds saved by older builds (R9): single `pending` becomes `queue`, new fields get defaults. */
export function normalizeRound(raw: unknown): RoundState & { savedAt: number } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const { pending, savedAt, ...rest } = r as { pending?: Pending | null; savedAt?: number } & Record<string, unknown>;
  const s = { ...IDLE, ...(rest as Partial<RoundState>) };
  if (!Array.isArray(s.queue)) s.queue = [];
  if (pending && !s.queue.length) s.queue = [{ ...pending, openedAt: pending.openedAt ?? pending.at }];
  if (s.phase === 'buzzer') {
    if (!s.detectUntil) s.detectUntil = s.endsAt + s.detectMs;
    if (!s.capAt) s.capAt = s.endsAt + CAP_MS;
  }
  if (s.phase === 'paused' && !s.pausedFrom) s.pausedFrom = 'live';
  return { ...s, savedAt: typeof savedAt === 'number' ? savedAt : s.endsAt };
}

/** True when an in-round save is too old to resume meaningfully. */
export function isStale(s: RoundState, savedAt: number, now: number): boolean {
  return isInRound(s) && now - runningUntil(s, savedAt) > STALE_ROUND_MS;
}

export function normalizeResult(r: Partial<Result>): Result {
  return {
    // Stable fallback id so a legacy entry keeps its identity across reloads.
    id: r.id ? String(r.id) : `legacy-${Number(r.at) || 0}-${String(r.name ?? '')}`,
    name: String(r.name ?? ''),
    score: Number(r.score) || 0,
    rejected: Number(r.rejected) || 0,
    notCounted: Number(r.notCounted) || 0,
    seconds: Number(r.seconds) || 60,
    at: Number(r.at) || 0,
  };
}

export const settings: Settings = { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(KEYS.settings, {}) };
const rawResults = read<unknown>(KEYS.results, []);
let results: Result[] = (Array.isArray(rawResults) ? rawResults : [])
  .filter((r): r is Partial<Result> => !!r && typeof r === 'object' && !Array.isArray(r))
  .map(normalizeResult)
  .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i);
let round: RoundState = IDLE;
let expired: { name: string; savedAt: number; saved: number } | null = null;

{
  const loaded = normalizeRound(read<unknown>(KEYS.round, {}));
  const { savedAt, ...r } = loaded;
  if (isStale(r, savedAt, Date.now())) {
    // Too old to resume. Keep a real score (crash, long pause); drop empty rounds (O12 + review).
    // Replay what an open tab would have done (auto-confirms, phase changes) before closing it.
    // tick to Infinity runs through the post-buzzer hold and cap; paused rounds stay frozen.
    const ended = end(tick(r, Infinity), runningUntil(r, savedAt));
    if (ended.count > 0) {
      addResult({
        name: ended.name,
        score: ended.count,
        rejected: ended.rejected,
        notCounted: ended.notCounted,
        seconds: Math.round(ended.durationMs / 1000),
        at: Math.min(Date.now(), ended.resultAt || savedAt),
      });
    }
    expired = { name: r.name, savedAt, saved: ended.count };
    write(KEYS.round, IDLE);
  } else {
    round = r;
  }
}

/** The expired stale round (saved score or 0), once, for the sticky notice (DD8). */
export function takeExpired(): { name: string; savedAt: number; saved: number } | null {
  const e = expired;
  expired = null;
  return e;
}

export function saveSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  write(KEYS.settings, settings);
}

export function getRound(): RoundState {
  return round;
}

export function setRound(next: RoundState): void {
  if (next === round) return;
  round = next;
  write(KEYS.round, { ...round, savedAt: Date.now() });
}

export function allResults(): readonly Result[] {
  return results;
}

/** Highest score first; ties go to whoever got there first. */
export function ranked(list: readonly Result[] = results): Result[] {
  return [...list].sort((a, b) => b.score - a.score || a.at - b.at);
}

export function rankOf(id: string, list: readonly Result[] = results): number {
  return ranked(list).findIndex((r) => r.id === id) + 1;
}

/** Puris needed to make the top 10, honoring the earlier-wins tiebreak (DD11). */
export function shortOfBoard(score: number, id: string, list: readonly Result[] = results): number {
  const others = ranked(list.filter((r) => r.id !== id));
  const tenth = others[9];
  return tenth ? Math.max(0, tenth.score - score + 1) : 0;
}

export function addResult(r: Omit<Result, 'id'>): Result {
  const full = { ...r, id: `${r.at.toString(36)}-${Math.random().toString(36).slice(2, 7)}` };
  results = [...results, full];
  write(KEYS.results, results);
  return full;
}

/** Undo support: put a removed entry back with its original id and time (DD12). */
export function restoreResult(r: Result): void {
  if (results.some((x) => x.id === r.id)) return;
  results = [...results, r];
  write(KEYS.results, results);
}

export function updateResult(id: string, patch: Partial<Result>): void {
  results = results.map((r) => (r.id === id ? { ...r, ...patch } : r));
  write(KEYS.results, results);
}

export function removeResult(id: string): Result | null {
  const found = results.find((r) => r.id === id) ?? null;
  results = results.filter((r) => r.id !== id);
  write(KEYS.results, results);
  return found;
}

export function clearResults(): void {
  results = [];
  write(KEYS.results, results);
}

/** CSV cell: quote when needed, and neutralise spreadsheet formulas (R6). */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function resultsCsv(list: readonly Result[] = results): string {
  const rows = ranked(list).map((r, i) =>
    [i + 1, r.name, r.score, r.rejected, r.notCounted, r.seconds, new Date(r.at).toISOString()].map(csvCell).join(','),
  );
  return ['rank,name,puris,rejected,not_counted,seconds,finished_at', ...rows].join('\n');
}
