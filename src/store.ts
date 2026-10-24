// App state persisted to localStorage: settings, every finished round, and the
// in-progress round so a refresh mid-round recovers.

import { DEFAULT_DETECTOR } from './detector';
import { IDLE, type CountMode, type RoundState } from './round';

export type SoundMode = 'all' | 'buzzer' | 'muted';

export interface Settings {
  cameraId: string;
  roundSeconds: number;
  mode: CountMode;
  autoConfirmSeconds: number;
  sound: SoundMode;
  open: number;
  close: number;
  cooldownSeconds: number;
  requireHand: boolean;
}

export interface Result {
  id: string;
  name: string;
  score: number;
  rejected: number;
  seconds: number;
  at: number;
}

export const DEFAULT_SETTINGS: Settings = {
  cameraId: '',
  roundSeconds: 60,
  mode: 'hybrid',
  autoConfirmSeconds: 0,
  sound: 'all',
  open: DEFAULT_DETECTOR.open,
  close: DEFAULT_DETECTOR.close,
  cooldownSeconds: DEFAULT_DETECTOR.cooldownMs / 1000,
  requireHand: false,
};

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

export const settings: Settings = { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(KEYS.settings, {}) };
let results: Result[] = read<Result[]>(KEYS.results, []);
let round: RoundState = { ...IDLE, ...read<Partial<RoundState>>(KEYS.round, {}) };

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
  write(KEYS.round, round);
}

export function allResults(): readonly Result[] {
  return results;
}

/** Highest score first; ties go to whoever got there first. */
export function ranked(list: readonly Result[] = results): Result[] {
  return [...list].sort((a, b) => b.score - a.score || a.at - b.at);
}

export function rankOf(id: string): number {
  return ranked().findIndex((r) => r.id === id) + 1;
}

export function addResult(r: Omit<Result, 'id'>): Result {
  const full = { ...r, id: `${r.at.toString(36)}-${Math.random().toString(36).slice(2, 7)}` };
  results = [...results, full];
  write(KEYS.results, results);
  return full;
}

export function updateResult(id: string, patch: Partial<Result>): void {
  results = results.map((r) => (r.id === id ? { ...r, ...patch } : r));
  write(KEYS.results, results);
}

export function removeResult(id: string): void {
  results = results.filter((r) => r.id !== id);
  write(KEYS.results, results);
}

export function clearResults(): void {
  results = [];
  write(KEYS.results, results);
}

export function resultsCsv(): string {
  const esc = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = ranked().map((r, i) =>
    [i + 1, r.name, r.score, r.rejected, r.seconds, new Date(r.at).toISOString()].map(esc).join(','),
  );
  return ['rank,name,puris,rejected,seconds,finished_at', ...rows].join('\n');
}
