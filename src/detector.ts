// Pure bite detector. Feed it one frame of mouth data at a time.
//
// 'absolute' mode: a bite is the mouth opening past `open` and closing below
// `closeThreshold` within `windowMs`.
// 'relative' mode: a bite is the ratio rising past `open` AND at least `drop`
// above the trough since the last close, then falling `drop` below its peak
// within `windowMs`. This survives chewing with a half-open mouth.
// Both modes respect cooldown and the optional hand-near-mouth gate.

export type DetectorMode = 'absolute' | 'relative';

export interface DetectorConfig {
  mode: DetectorMode;
  open: number;
  close: number;
  /** relative mode: rise above trough to open, fall below peak to close */
  drop: number;
  windowMs: number;
  cooldownMs: number;
  requireHand: boolean;
  handLookbackMs: number;
}

export const DEFAULT_DETECTOR: DetectorConfig = {
  mode: 'absolute',
  open: 0.45,
  close: 0.2,
  drop: 0.15,
  windowMs: 1200,
  cooldownMs: 1500,
  requireHand: false,
  handLookbackMs: 600,
};

export interface DetectorFrame {
  /** ms timestamp (any monotonic clock) */
  t: number;
  /** mouth-open ratio, or null when no face was found */
  ratio: number | null;
  handNear: boolean;
}

export type DetectorEvent =
  | { kind: 'candidate'; t: number; openedAt: number; peak: number; hand: boolean; confidence: number }
  | {
      kind: 'ignored';
      t: number;
      openedAt: number;
      peak: number;
      hand: boolean;
      reason: 'timeout' | 'cooldown' | 'no-hand';
    };

export type DetectorPhase = 'closed' | 'open' | 'held';

export interface DetectorState {
  mode: DetectorMode;
  phase: DetectorPhase;
  peak: number | null;
  trough: number | null;
  closeLine: number;
}

export class BiteDetector {
  private cfg: DetectorConfig;
  private baseline: number | null = null;
  private phase: DetectorPhase = 'closed';
  private openedAt = 0;
  private peak = 0;
  private trough: number | null = null;
  private handAtOpen = false;
  private lastHandAt = -Infinity;
  private lastCandidateAt = -Infinity;

  constructor(cfg: Partial<DetectorConfig> = {}) {
    this.cfg = { ...DEFAULT_DETECTOR, ...cfg };
  }

  setConfig(cfg: Partial<DetectorConfig>): void {
    const prevMode = this.cfg.mode;
    this.cfg = { ...this.cfg, ...cfg };
    if (this.cfg.mode !== prevMode) {
      // Switching algorithms mid-bite would mix incompatible state; start clean.
      this.phase = 'closed';
      this.trough = null;
    }
  }

  get config(): Readonly<DetectorConfig> {
    return this.cfg;
  }

  /** Resting mouth ratio from the countdown. Raises the close line for open-mouthed resters (absolute mode). */
  setBaseline(b: number | null): void {
    this.baseline = b;
  }

  get closeThreshold(): number {
    const { open, close } = this.cfg;
    if (this.baseline == null) return close;
    return Math.min(open - 0.05, close + 0.1, Math.max(close, this.baseline + 0.05));
  }

  get state(): DetectorState {
    const active = this.phase !== 'closed';
    const closeLine =
      this.cfg.mode === 'absolute' ? this.closeThreshold : active ? this.peak - this.cfg.drop : NaN;
    return {
      mode: this.cfg.mode,
      phase: this.phase,
      peak: active ? this.peak : null,
      trough: this.trough,
      closeLine,
    };
  }

  reset(): void {
    this.phase = 'closed';
    this.peak = 0;
    this.trough = null;
    this.handAtOpen = false;
    this.lastHandAt = -Infinity;
    this.lastCandidateAt = -Infinity;
  }

  push(f: DetectorFrame): DetectorEvent | null {
    if (f.handNear) this.lastHandAt = f.t;
    if (f.ratio == null) {
      // Face lost mid-bite: abandon it rather than guess.
      this.phase = 'closed';
      this.trough = null;
      return null;
    }
    return this.cfg.mode === 'relative' ? this.pushRelative(f.t, f.ratio) : this.pushAbsolute(f.t, f.ratio);
  }

  private beginBite(t: number, r: number): void {
    this.phase = 'open';
    this.openedAt = t;
    this.peak = r;
    this.handAtOpen = t - this.lastHandAt <= this.cfg.handLookbackMs;
  }

  private handNow(t: number): boolean {
    return this.handAtOpen || t - this.lastHandAt <= this.cfg.handLookbackMs;
  }

  /** Bite closed inside the window: apply cooldown, then hand gate, then emit. */
  private finishBite(t: number, hand: boolean): DetectorEvent {
    const peak = this.peak;
    const openedAt = this.openedAt;
    if (t - this.lastCandidateAt < this.cfg.cooldownMs) {
      return { kind: 'ignored', t, openedAt, peak, hand, reason: 'cooldown' };
    }
    if (this.cfg.requireHand && !hand) {
      return { kind: 'ignored', t, openedAt, peak, hand, reason: 'no-hand' };
    }
    this.lastCandidateAt = t;
    return { kind: 'candidate', t, openedAt, peak, hand, confidence: confidence(peak, this.cfg.open, hand) };
  }

  private pushAbsolute(t: number, r: number): DetectorEvent | null {
    const close = this.closeThreshold;

    if (this.phase === 'closed') {
      if (r > this.cfg.open) this.beginBite(t, r);
      return null;
    }

    if (this.phase === 'held') {
      // Mouth stayed open past the window; wait for a real close before re-arming.
      if (r < close) this.phase = 'closed';
      return null;
    }

    // phase === 'open'
    this.peak = Math.max(this.peak, r);
    const hand = this.handNow(t);
    if (t - this.openedAt > this.cfg.windowMs) {
      this.phase = r < close ? 'closed' : 'held';
      return { kind: 'ignored', t, openedAt: this.openedAt, peak: this.peak, hand, reason: 'timeout' };
    }
    if (r >= close) return null;

    this.phase = 'closed';
    return this.finishBite(t, hand);
  }

  private pushRelative(t: number, r: number): DetectorEvent | null {
    const { open, drop } = this.cfg;

    if (this.phase === 'closed') {
      this.trough = this.trough == null ? r : Math.min(this.trough, r);
      if (r > open && r - this.trough >= drop) this.beginBite(t, r);
      return null;
    }

    this.peak = Math.max(this.peak, r);

    if (this.phase === 'held') {
      // Mouth stayed open past the window; wait for a real fall from the peak before re-arming.
      if (r <= this.peak - drop) {
        this.phase = 'closed';
        this.trough = r;
      }
      return null;
    }

    // phase === 'open'
    const hand = this.handNow(t);
    if (t - this.openedAt > this.cfg.windowMs) {
      this.phase = 'held';
      return { kind: 'ignored', t, openedAt: this.openedAt, peak: this.peak, hand, reason: 'timeout' };
    }
    if (r > this.peak - drop) return null;

    this.phase = 'closed';
    this.trough = r;
    return this.finishBite(t, hand);
  }
}

/** Heuristic 0..1 score for the referee banner: how far past the open line, plus a hand bonus. */
export function confidence(peak: number, open: number, hand: boolean): number {
  const over = Math.max(0, Math.min(1, (peak - open) / 0.35));
  const c = 0.55 + over * 0.3 + (hand ? 0.12 : 0);
  return Math.round(Math.min(0.99, c) * 100) / 100;
}

/** Mouth-open ratio: inner-lip vertical gap / mouth-corner width. */
export function mouthRatio(
  upper: { x: number; y: number },
  lower: { x: number; y: number },
  left: { x: number; y: number },
  right: { x: number; y: number },
): number {
  const w = Math.hypot(right.x - left.x, right.y - left.y);
  if (w === 0) return 0;
  return Math.hypot(lower.x - upper.x, lower.y - upper.y) / w;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
