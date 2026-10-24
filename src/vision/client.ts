// Main-thread side of the vision pipeline: camera capture, frame pump to the
// worker (one frame in flight), and latency/fps/darkness stats.

import type { FromWorker, ToWorker, VisionResult } from './protocol';

export const FRAME_W = 640;
export const FRAME_H = 480;

type Listener = (r: VisionResult) => void;

export type VisionStatus =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'ready'; delegate: 'GPU' | 'CPU' }
  | { state: 'error'; message: string };

export class Vision {
  readonly video: HTMLVideoElement;
  status: VisionStatus = { state: 'off' };
  hands = false;
  onStatus: (s: VisionStatus) => void = () => {};

  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private inFlight = false;
  private listeners = new Set<Listener>();
  private latencies: number[] = [];
  private frameTimes: number[] = [];
  private faceHistory: Array<{ t: number; found: boolean }> = [];
  private lastLuma = 128;
  private pumping = false;
  private delegate: 'GPU' | 'CPU' | null = null;

  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('aria-hidden', 'true');
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: VisionStatus): void {
    this.status = s;
    this.onStatus(s);
  }

  async start(deviceId: string): Promise<void> {
    this.setStatus({ state: 'starting' });
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: FRAME_W },
          height: { ideal: FRAME_H },
          frameRate: { ideal: 30 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
        },
      });
    } catch (err) {
      this.setStatus({ state: 'error', message: cameraError(err) });
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});

    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
      this.worker.onerror = (e) => this.setStatus({ state: 'error', message: e.message || 'Vision worker crashed' });
      this.send({ type: 'init', base: import.meta.env.BASE_URL, hands: this.hands });
    } else if (this.delegate) {
      // Camera switched; worker already warm.
      this.setStatus({ state: 'ready', delegate: this.delegate });
    }
    if (!this.pumping) {
      this.pumping = true;
      this.schedule();
    }
  }

  async cameras(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  currentDeviceId(): string {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? '';
  }

  private send(m: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(m, transfer);
  }

  private handle(m: FromWorker): void {
    if (m.type === 'ready') {
      this.delegate = m.delegate;
      this.setStatus({ state: 'ready', delegate: m.delegate });
      return;
    }
    if (m.type === 'error') {
      this.inFlight = false;
      if (this.status.state !== 'ready') this.setStatus({ state: 'error', message: m.message });
      else console.warn('vision:', m.message);
      return;
    }
    this.inFlight = false;
    const now = performance.now();
    push(this.latencies, now - m.t, 100);
    push(this.frameTimes, now, 60);
    this.faceHistory.push({ t: now, found: m.faceFound });
    while (this.faceHistory.length && now - this.faceHistory[0].t > 2000) this.faceHistory.shift();
    this.lastLuma = m.luma;
    for (const fn of this.listeners) fn(m);
  }

  private schedule(): void {
    const v = this.video;
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback((_n, meta) => this.capture(meta.captureTime));
    else requestAnimationFrame(() => this.capture());
  }

  private capture(captureTime?: number): void {
    this.schedule();
    const v = this.video;
    if (this.inFlight || this.status.state !== 'ready' || v.readyState < 2) return;
    // Keep the camera's aspect ratio at 640px wide so landmarks aren't stretched.
    // captureTime is the sensor timestamp when the browser exposes it; otherwise now.
    const t = captureTime && captureTime > 0 ? captureTime : performance.now();
    this.inFlight = true;
    createImageBitmap(v, { resizeWidth: FRAME_W, resizeHeight: Math.round((FRAME_W * v.videoHeight) / v.videoWidth) || FRAME_H })
      .then((bitmap) => this.send({ type: 'frame', bitmap, t, hands: this.hands }, [bitmap]))
      .catch(() => {
        this.inFlight = false;
      });
  }

  /** p50/p95 of camera-capture to result-on-main-thread, ms. */
  latency(): { p50: number; p95: number } {
    const s = [...this.latencies].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
    return { p50: q(0.5), p95: q(0.95) };
  }

  fps(): number {
    const f = this.frameTimes;
    return f.length > 1 ? ((f.length - 1) * 1000) / (f[f.length - 1] - f[0]) : 0;
  }

  /** Face found in under half the frames of the last 2s, or the picture is dim. */
  tooDark(): boolean {
    const h = this.faceHistory;
    const rate = h.length ? h.filter((x) => x.found).length / h.length : 1;
    return (h.length > 10 && rate < 0.5) || this.lastLuma < 45;
  }
}

function push(arr: number[], v: number, max: number): void {
  arr.push(v);
  if (arr.length > max) arr.shift();
}

function cameraError(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError') return 'Camera blocked. Allow camera access for this page in the browser.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found. Plug in the webcam and pick it in Setup.';
  if (name === 'NotReadableError') return 'Camera is busy in another app. Close Zoom/FaceTime and retry.';
  return `Camera error: ${String(err)}`;
}
