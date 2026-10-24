// Main-thread side of the vision pipeline: camera capture, frame pump to the
// worker (one frame in flight), latency/fps/darkness stats, and a watchdog that
// restarts the worker and camera when frames stop after the first ready.

import { isTooDark, type DarkKind } from './health';
import type { FromWorker, ToWorker, VisionResult } from './protocol';

export const FRAME_W = 640;
export const FRAME_H = 480;

const STALL_MS = 2000;
const WATCHDOG_TICK_MS = 500;
const RETRY_MS = 5000;
/** First inference after ready can be slow (GPU shader compile); give it longer before calling it a stall. */
const FIRST_FRAME_MS = 8000;
/** Consecutive non-fatal frame errors before the worker is treated as crashed. */
const MAX_FRAME_ERRORS = 3;
/** After a camera-only recovery, how long to wait for frames before rebuilding the worker too. */
const CAMERA_ONLY_MS = 3000;
const INIT_TIMEOUT_MS = 20000;

type Listener = (r: VisionResult) => void;

export type VisionErrorCause = 'blocked' | 'no-camera' | 'busy' | 'model-failed' | 'worker-crashed' | 'stalled';

export const CAUSE_MESSAGES: Record<VisionErrorCause, string> = {
  blocked: 'Camera blocked (allow in Chrome)',
  'no-camera': 'No camera found',
  busy: 'Camera is busy in another app',
  'model-failed': 'Face model failed to load',
  'worker-crashed': 'Vision worker crashed, retrying',
  stalled: 'Camera stopped sending frames',
};

export type VisionStatus =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'loading' }
  | { state: 'ready'; delegate: 'GPU' | 'CPU' }
  | { state: 'error'; cause: VisionErrorCause; message: string };

export class Vision {
  readonly video: HTMLVideoElement;
  status: VisionStatus = { state: 'off' };
  hands = false;
  /** Sticky: true from a failure after the first ready until a result arrives again. */
  offline = false;
  onStatus: (s: VisionStatus) => void = () => {};
  /** Called once each time `offline` turns true. */
  onOffline: () => void = () => {};
  /** Called when `offline` turns back to false. */
  onRecover: () => void = () => {};

  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private deviceId = '';
  private inFlight = false;
  private listeners = new Set<Listener>();
  private latencies: number[] = [];
  private frameTimes: number[] = [];
  private faceHistory: Array<{ t: number; found: boolean }> = [];
  private lastLuma = 128;
  private delegate: 'GPU' | 'CPU' | null = null;
  private pumpGen = 0;
  private everReady = false;
  private lastResultAt = 0;
  private watchdog: number | null = null;
  private retryTimer: number | null = null;
  private retrying = false;
  private initDone: ((ok: boolean) => void) | null = null;
  private cameraGen = 0;
  private frameErrors = 0;
  private lastCause: VisionErrorCause | null = null;
  private cameraOnlyTried = false;
  /** the camera-only attempt actually reopened the camera (so a respawn is the next step) */
  private cameraOnlyOpened = false;
  private awaitingFirstFrame = false;

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

  private fail(cause: VisionErrorCause): void {
    this.lastCause = cause;
    this.setStatus({ state: 'error', cause, message: CAUSE_MESSAGES[cause] });
  }

  /** Open the camera (saved deviceId, falling back to the default) and start the pipeline. */
  async start(deviceId: string): Promise<void> {
    this.deviceId = deviceId;
    this.lastResultAt = performance.now();
    if (!this.offline) this.setStatus({ state: 'starting' }); // keep an outage's cause visible
    if (!(await this.openCamera())) return;
    this.startPump();
    this.startWatchdog();
    if (this.worker && this.delegate) {
      if (!this.offline) this.setStatus({ state: 'ready', delegate: this.delegate }); // camera switch, worker warm
      return;
    }
    if (!this.worker) {
      const ok = await this.spawnWorker();
      if (!ok && !this.everReady && this.status.state !== 'error') {
        this.killWorker();
        this.fail('model-failed'); // init hung past INIT_TIMEOUT_MS
      }
    } else {
      this.setStatus({ state: 'loading' });
    }
  }

  /** Stop everything: camera, worker, watchdog, retries. */
  stop(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.pumpGen++;
    this.killWorker();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.offline = false;
    this.everReady = false;
    this.cameraGen++;
    this.setStatus({ state: 'off' });
  }

  async cameras(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  /** The deviceId actually in use (may differ from the saved one after a fallback). */
  currentDeviceId(): string {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? '';
  }

  private async openCamera(): Promise<boolean> {
    // Only the newest call may attach a stream; older ones stop what they opened.
    const gen = ++this.cameraGen;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    let stream: MediaStream;
    try {
      stream = await getCamera(this.deviceId);
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (!this.deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) {
        if (gen === this.cameraGen) this.cameraFailed(cameraCause(err));
        return false;
      }
      try {
        stream = await getCamera(''); // saved camera gone: use the default one
      } catch (err2) {
        if (gen === this.cameraGen) this.cameraFailed(cameraCause(err2));
        return false;
      }
    }
    if (gen !== this.cameraGen) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    (this.stream as MediaStream | null)?.getTracks().forEach((t) => t.stop()); // set by an overlapping call meanwhile
    this.stream = stream;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.stream === stream) this.goOffline('stalled');
    });
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    return true;
  }

  /** Start a fresh worker; resolves true on 'ready', false on error, crash or timeout. */
  private spawnWorker(): Promise<boolean> {
    this.killWorker();
    this.frameErrors = 0;
    if (!this.offline) this.setStatus({ state: 'loading' });
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      if (this.worker === w) this.handle(e.data);
    };
    w.onerror = (e) => {
      if (this.worker === w) this.workerFailed(e.message || 'worker error');
    };
    return new Promise((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        if (this.initDone === finish) this.initDone = null;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), INIT_TIMEOUT_MS);
      this.initDone = finish;
      this.send({ type: 'init', base: import.meta.env.BASE_URL, hands: this.hands });
    });
  }

  private killWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.delegate = null;
    this.inFlight = false;
    this.initDone?.(false);
  }

  private send(m: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(m, transfer);
  }

  private handle(m: FromWorker): void {
    if (m.type === 'ready') {
      this.delegate = m.delegate;
      this.everReady = true;
      this.frameErrors = 0;
      this.awaitingFirstFrame = true;
      this.lastResultAt = performance.now();
      // While offline the error cause stays visible until frames actually flow again.
      if (!this.offline) this.setStatus({ state: 'ready', delegate: m.delegate });
      this.initDone?.(true);
      return;
    }
    if (m.type === 'error') {
      if (m.kind === 'hand') {
        // Optional model: never a crash, and not tied to the frame in flight.
        console.warn('vision (hands):', m.message);
        return;
      }
      if (m.kind === 'frame') this.inFlight = false;
      // One bad frame is noise; the stall watchdog catches a worker that stops producing.
      if (!m.fatal && ++this.frameErrors < MAX_FRAME_ERRORS) {
        console.warn('vision (frame):', m.message);
        return;
      }
      this.workerFailed(m.message);
      return;
    }
    this.inFlight = false;
    const now = performance.now();
    this.lastResultAt = now;
    this.awaitingFirstFrame = false;
    this.frameErrors = 0;
    if (this.offline) {
      this.cameraOnlyTried = false;
      this.offline = false;
      if (this.delegate) this.setStatus({ state: 'ready', delegate: this.delegate });
      if (this.retryTimer !== null) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.onRecover();
    }
    push(this.latencies, now - m.t, 100);
    push(this.frameTimes, now, 60);
    this.faceHistory.push({ t: now, found: m.faceFound });
    while (this.faceHistory.length && now - this.faceHistory[0].t > 2000) this.faceHistory.shift();
    this.lastLuma = m.luma;
    for (const fn of this.listeners) fn(m);
  }

  private workerFailed(message: string): void {
    console.warn('vision:', message);
    this.initDone?.(false);
    if (this.everReady) this.goOffline('worker-crashed');
    else {
      this.killWorker(); // a later start() must spawn a fresh worker, not wait on this one
      this.fail('model-failed');
    }
  }

  // ---------- watchdog + recovery (only after the first ready) ----------

  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = window.setInterval(() => {
      if (!this.everReady || this.offline || document.hidden) return;
      const limit = this.awaitingFirstFrame ? FIRST_FRAME_MS : STALL_MS;
      if (performance.now() - this.lastResultAt > limit) this.goOffline('stalled');
    }, WATCHDOG_TICK_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  // A hidden tab stops sending frames on purpose; restart the clock on return.
  private onVisibility = (): void => {
    if (!document.hidden) this.lastResultAt = performance.now();
  };

  /** A camera failure after the first ready is an outage (retried); before it, a setup error. */
  private cameraFailed(cause: VisionErrorCause): void {
    if (this.everReady) {
      if (this.offline) this.fail(cause);
      else this.goOffline(cause);
    } else {
      this.fail(cause);
    }
  }

  private goOffline(cause: VisionErrorCause): void {
    if (!this.everReady || this.offline) return;
    this.offline = true;
    this.fail(cause);
    this.onOffline();
    this.queueRetry(0);
  }

  private queueRetry(ms: number): void {
    if (this.retryTimer !== null || this.retrying) return;
    this.retryTimer = window.setTimeout(() => void this.retry(), ms);
  }

  /** One recovery attempt: fresh worker, re-init, restart camera. Next one RETRY_MS after this finishes. */
  private async retry(): Promise<void> {
    this.retryTimer = null;
    if (!this.offline) return;
    this.retrying = true;
    const cameraSide = this.lastCause !== 'worker-crashed' && this.lastCause !== 'model-failed';
    const warm = !!this.worker && !!this.delegate;
    let cameraOnly = false;
    try {
      // Most stalls are a bumped USB cable: reopen the camera and keep the warm model. Only
      // rebuild the worker if the camera did come back but frames still don't flow.
      if (cameraSide && warm && !(this.cameraOnlyTried && this.cameraOnlyOpened)) {
        cameraOnly = true;
        this.cameraOnlyTried = true;
        this.lastResultAt = performance.now();
        this.cameraOnlyOpened = await this.openCamera();
        if (this.cameraOnlyOpened) this.startPump();
      } else {
        this.cameraOnlyTried = false;
        this.cameraOnlyOpened = false;
        const ready = this.spawnWorker();
        const camera = await this.openCamera();
        if ((await ready) && camera) this.startPump();
      }
    } finally {
      this.retrying = false;
    }
    if (this.offline) this.queueRetry(cameraOnly ? CAMERA_ONLY_MS : RETRY_MS);
  }

  // ---------- frame pump ----------

  /** (Re)start the capture loop; any older loop stops at its next tick. */
  private startPump(): void {
    this.schedule(++this.pumpGen);
  }

  private schedule(gen: number): void {
    const v = this.video;
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback((_n, meta) => this.capture(gen, meta.captureTime));
    else requestAnimationFrame(() => this.capture(gen));
  }

  private capture(gen: number, captureTime?: number): void {
    if (gen !== this.pumpGen) return;
    this.schedule(gen);
    const v = this.video;
    if (this.inFlight || !this.worker || !this.delegate || v.readyState < 2) return;
    // Keep the camera's aspect ratio at 640px wide so landmarks aren't stretched.
    // captureTime is the sensor timestamp when the browser exposes it; otherwise now.
    const t = captureTime && captureTime > 0 ? captureTime : performance.now();
    this.inFlight = true;
    createImageBitmap(v, { resizeWidth: FRAME_W, resizeHeight: Math.round((FRAME_W * v.videoHeight) / v.videoWidth) || FRAME_H })
      .then((bitmap) => {
        if (gen === this.pumpGen && this.worker) this.send({ type: 'frame', bitmap, t, hands: this.hands }, [bitmap]);
        else {
          bitmap.close();
          this.inFlight = false;
        }
      })
      .catch(() => {
        this.inFlight = false;
      });
  }

  // ---------- stats ----------

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

  /** 'crowd': picture is dim. 'setup': dim, or face found in under half the frames of the last 2s. */
  tooDark(kind: DarkKind = 'setup'): boolean {
    const h = this.faceHistory;
    const faceRate = h.length ? h.filter((x) => x.found).length / h.length : 1;
    return isTooDark({ samples: h.length, faceRate, luma: this.lastLuma }, kind);
  }
}

function getCamera(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: FRAME_W },
      height: { ideal: FRAME_H },
      frameRate: { ideal: 30 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
    },
  });
}

function push(arr: number[], v: number, max: number): void {
  arr.push(v);
  if (arr.length > max) arr.shift();
}

export function cameraCause(err: unknown): VisionErrorCause {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'blocked';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'no-camera'; // NotFoundError, OverconstrainedError, anything else
}
