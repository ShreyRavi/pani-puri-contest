// Synthesized sounds via Web Audio: no files to load, works offline.

import type { SoundMode } from './store';

let ctx: AudioContext | null = null;

function ac(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Call from a key/click handler so the context is allowed to start. */
export function unlockAudio(): void {
  ac();
}

function tone(freq: number, dur: number, type: OscillatorType, gain: number, at = 0): void {
  const c = ac();
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

export function ding(mode: SoundMode): void {
  if (mode !== 'all') return;
  tone(1318.5, 0.35, 'sine', 0.35);
  tone(2637, 0.2, 'sine', 0.12);
}

export function beep(mode: SoundMode, final = false): void {
  if (mode === 'muted') return;
  tone(final ? 880 : 587, final ? 0.4 : 0.18, 'square', 0.12);
}

export function buzzer(mode: SoundMode): void {
  if (mode === 'muted') return;
  tone(140, 0.9, 'sawtooth', 0.3);
  tone(147, 0.9, 'sawtooth', 0.22);
}
