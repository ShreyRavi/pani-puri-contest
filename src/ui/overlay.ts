// Shared camera element (video + landmark overlay) that moves between screens.

import type { VisionResult } from '../vision/protocol';

const GOLD = '#FFB627';
const GREEN = '#4CC27A';
// Indices into the 40-point lip list sent by the worker: corners 61/291, inner 14/13.
const KEY_POINTS = [0, 10, 25, 35];

export class CameraStage {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(private video: HTMLVideoElement) {
    this.el = document.createElement('div');
    this.el.className = 'cam-stage';
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d')!;
    this.el.append(video, this.canvas);
  }

  mount(slot: Element | null): void {
    if (slot && this.el.parentElement !== slot) {
      slot.append(this.el);
      // Re-parenting pauses some browsers' video playback.
      void this.video.play().catch(() => {});
    }
  }

  draw(r: VisionResult | null): void {
    const c = this.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!r || !r.lips.length || !vw || !vh) return;

    // Same math as object-fit: cover.
    const s = Math.max(w / vw, h / vh);
    const dw = vw * s;
    const dh = vh * s;
    const ox = (w - dw) / 2;
    const oy = (h - dh) / 2;
    const pts = r.lips.map((p) => ({ x: ox + p.x * dw, y: oy + p.y * dh }));
    const lw = Math.max(3, dw / 200);

    ctx.lineWidth = lw;
    ctx.strokeStyle = GOLD;
    for (const loop of [pts.slice(0, 20), pts.slice(20)]) {
      ctx.beginPath();
      loop.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    }
    ctx.fillStyle = GREEN;
    for (const i of KEY_POINTS) {
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, lw * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (r.handNear) {
      const cx = (pts[0].x + pts[10].x) / 2;
      const cy = (pts[25].y + pts[35].y) / 2;
      const rad = Math.hypot(pts[10].x - pts[0].x, pts[10].y - pts[0].y);
      ctx.strokeStyle = GREEN;
      ctx.setLineDash([lw * 3, lw * 3]);
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
