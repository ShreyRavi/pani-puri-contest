// Passive leaderboard scroll: once the board is longer than its box, it holds on the top, glides
// down to the last contestant, holds, glides back up, and repeats. A trackpad/wheel scroll by the
// host takes over until the board has been left alone for MANUAL_PAUSE_MS.

export const HOLD_TOP_MS = 8000;
export const HOLD_BOTTOM_MS = 4000;
export const HOLD_FOCUS_MS = 6000;
export const MANUAL_PAUSE_MS = 15000;
/** Reduced motion: page instead of gliding, one page per this long. */
export const PAGE_MS = 5000;
const ROWS_PER_SEC = 1;
const UP_FACTOR = 4;

type Phase = 'top' | 'down' | 'bottom' | 'up' | 'focus' | 'hold' | 'manual';

export class AutoScroll {
  private phase: Phase = 'top';
  private since = 0;
  private pos = 0;
  private last = 0;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private readonly el: HTMLElement) {
    el.addEventListener('wheel', () => this.go('manual', performance.now()), { passive: true });
  }

  /** Result screen: bring the highlighted (`.me`) row into view, hold on it, then carry on scrolling. */
  focus(): void {
    this.go('focus', performance.now());
  }

  /** Call once per animation frame. */
  tick(now: number): void {
    const dt = this.last ? Math.min(100, now - this.last) : 0;
    this.last = now;
    const el = this.el;
    // A hidden screen has no size: start from the top when it shows again (a pending focus waits for it).
    if (el.offsetParent === null) {
      if (this.phase !== 'focus') this.restart(now);
      return;
    }
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 1) {
      this.restart(now); // the board fits: nothing to scroll
      return;
    }
    const elapsed = now - this.since;
    const speed = this.rowStep() * ROWS_PER_SEC; // px per second
    const page = Math.max(this.rowStep(), el.clientHeight - this.rowStep());
    const reduced = this.reduced.matches;
    this.pos = Math.min(this.pos, max);

    switch (this.phase) {
      case 'manual':
        this.pos = el.scrollTop;
        if (elapsed >= MANUAL_PAUSE_MS) this.go(this.pos >= max - 1 ? 'bottom' : 'down', now);
        break;
      case 'top':
        if (elapsed >= HOLD_TOP_MS) this.go('down', now);
        break;
      case 'down':
        if (reduced) {
          if (elapsed >= PAGE_MS) {
            this.pos = Math.min(max, this.pos + page);
            this.since = now;
          }
        } else this.pos = Math.min(max, this.pos + (speed * dt) / 1000);
        if (this.pos >= max) this.go('bottom', now);
        break;
      case 'bottom':
        if (elapsed >= HOLD_BOTTOM_MS) this.go('up', now);
        break;
      case 'up':
        this.pos = reduced ? 0 : Math.max(0, this.pos - (speed * UP_FACTOR * dt) / 1000);
        if (this.pos <= 0) this.go('top', now);
        break;
      case 'focus': {
        const target = this.focusTarget(max);
        const stepPx = (speed * UP_FACTOR * dt) / 1000;
        this.pos = reduced || Math.abs(target - this.pos) <= stepPx ? target : this.pos + Math.sign(target - this.pos) * stepPx;
        if (this.pos === target) this.go('hold', now);
        break;
      }
      case 'hold':
        if (elapsed >= HOLD_FOCUS_MS) this.go(this.pos >= max - 1 ? 'bottom' : 'down', now);
        break;
    }
    if (this.phase !== 'manual') el.scrollTop = this.pos;
    // Soft fades at the edges say "more below" / "more above".
    el.classList.toggle('more', this.pos < max - 1);
    el.classList.toggle('up', this.pos > 1);
  }

  private restart(now: number): void {
    if (this.phase !== 'top') this.go('top', now);
    this.pos = 0;
    this.el.scrollTop = 0;
    this.el.classList.remove('more', 'up');
  }

  private go(phase: Phase, now: number): void {
    this.phase = phase;
    this.since = now;
  }

  /** Scroll position that centres the focused row, or 0 when it already shows from the top. */
  private focusTarget(max: number): number {
    // Looked up each frame: the board re-renders its rows whenever a score changes. A pinned #1 has no row here.
    const row = this.el.querySelector<HTMLElement>('.me');
    if (!row) return 0;
    if (row.offsetTop + row.offsetHeight <= this.el.clientHeight) return 0;
    return Math.max(0, Math.min(max, row.offsetTop - (this.el.clientHeight - row.offsetHeight) / 2));
  }

  /** One row plus the gap below it, measured from the rendered list. */
  private rowStep(): number {
    const row = this.el.querySelector('li');
    const list = row?.parentElement;
    if (!row || !list) return 60;
    return row.offsetHeight + (parseFloat(getComputedStyle(list).rowGap) || 0);
  }
}
