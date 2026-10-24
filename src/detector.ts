// Pure bite detector. Feed it one frame of mouth data at a time; it emits a
// candidate when the mouth opens past `open` and closes below `close` within
// `windowMs`, respecting cooldown and the optional hand-near-mouth gate.

export interface DetectorConfig {
  open: number;
  close: number;
  windowMs: number;
  cooldownMs: number;
  requireHand: boolean;
  handLookbackMs: number;
}

export const DEFAULT_DETECTOR: DetectorConfig = {
  open: 0.45,
  close: 0.2,
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
  | { kind: 'candidate'; t: number; peak: number; hand: boolean; confidence: number }
  | { kind: 'ignored'; t: number; peak: number; hand: boolean; reason: 'timeout' | 'cooldown' | 'no-hand' };

type Phase = 'closed' | 'open' | 'held';

export class BiteDetector {
  private cfg: DetectorConfig;
  private baseline: number | null = null;
  private phase: Phase = 'closed';
  private openedAt = 0;
  private peak = 0;
  private handAtOpen = false;
  private lastHandAt = -Infinity;
  private lastCandidateAt = -Infinity;

  constructor(cfg: Partial<DetectorConfig> = {}) {
    this.cfg = { ...DEFAULT_DETECTOR, ...cfg };
  }

  setConfig(cfg: Partial<DetectorConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  get config(): Readonly<DetectorConfig> {
    return this.cfg;
  }

  /** Resting mouth ratio from the countdown. Raises the close line for open-mouthed resters. */
  setBaseline(b: number | null): void {
    this.baseline = b;
  }

  get closeThreshold(): number {
    const c = this.cfg.close;
    return this.baseline == null ? c : Math.min(this.cfg.open - 0.05, Math.max(c, this.baseline + 0.05));
  }

  reset(): void {
    this.phase = 'closed';
    this.peak = 0;
    this.lastHandAt = -Infinity;
    this.lastCandidateAt = -Infinity;
  }

  push(f: DetectorFrame): DetectorEvent | null {
    if (f.handNear) this.lastHandAt = f.t;
    if (f.ratio == null) {
      // Face lost mid-bite: abandon it rather than guess.
      this.phase = 'closed';
      return null;
    }
    const r = f.ratio;
    const close = this.closeThreshold;

    if (this.phase === 'closed') {
      if (r > this.cfg.open) {
        this.phase = 'open';
        this.openedAt = f.t;
        this.peak = r;
        this.handAtOpen = f.t - this.lastHandAt <= this.cfg.handLookbackMs;
      }
      return null;
    }

    if (this.phase === 'held') {
      // Mouth stayed open past the window; wait for a real close before re-arming.
      if (r < close) this.phase = 'closed';
      return null;
    }

    // phase === 'open'
    this.peak = Math.max(this.peak, r);
    const hand = this.handAtOpen || f.t - this.lastHandAt <= this.cfg.handLookbackMs;
    if (f.t - this.openedAt > this.cfg.windowMs) {
      this.phase = r < close ? 'closed' : 'held';
      return { kind: 'ignored', t: f.t, peak: this.peak, hand, reason: 'timeout' };
    }
    if (r >= close) return null;

    this.phase = 'closed';
    const peak = this.peak;
    if (f.t - this.lastCandidateAt < this.cfg.cooldownMs) {
      return { kind: 'ignored', t: f.t, peak, hand, reason: 'cooldown' };
    }
    if (this.cfg.requireHand && !hand) {
      return { kind: 'ignored', t: f.t, peak, hand, reason: 'no-hand' };
    }
    this.lastCandidateAt = f.t;
    return { kind: 'candidate', t: f.t, peak, hand, confidence: confidence(peak, this.cfg.open, hand) };
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
