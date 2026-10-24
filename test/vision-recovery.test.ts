// Value: protects=camera/worker outages mid-event recover on their own: a bumped USB cable reopens the camera with the
//   warm model, a camera that reopens without frames gets a fresh worker, a failing camera keeps retrying, and a respawned
//   worker gets its first-frame grace instead of a respawn loop; fails_when=the retry ladder in Vision.retry or the
//   offline/recover hooks change; why_new=only the pure health/pick helpers were tested; seam=none (fakes only the
//   browser: Worker, getUserMedia, document); no_claim=real MediaPipe timing or a physical unplug
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeTrack {
  stopped = false;
  private ended: Array<() => void> = [];
  addEventListener(type: string, fn: () => void): void {
    if (type === 'ended') this.ended.push(fn);
  }
  stop(): void {
    this.stopped = true;
  }
  getSettings(): { deviceId: string } {
    return { deviceId: 'cam-1' };
  }
  end(): void {
    for (const fn of this.ended) fn();
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getTracks(): FakeTrack[] {
    return [this.track];
  }
  getVideoTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeWorker {
  static all: FakeWorker[] = [];
  terminated = false;
  sent: Array<{ type: string }> = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: { type: string }): void {
    this.sent.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const result = () => ({ type: 'result', t: performance.now(), faceFound: true, faceSwitched: false, ratio: 0.1, mouth: null, faceWidth: 100, handDist: null, handNear: false, lips: [], luma: 120 });

let cameraWorks = true;
let streams: FakeStream[] = [];
const getUserMedia = vi.fn(async () => {
  if (!cameraWorks) throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
  const s = new FakeStream();
  streams.push(s);
  return s;
});

async function readyVision() {
  const { Vision } = await import('../src/vision/client');
  const v = new Vision();
  const offline = vi.fn();
  const recover = vi.fn();
  v.onOffline = offline;
  v.onRecover = recover;
  const started = v.start('');
  await vi.advanceTimersByTimeAsync(0);
  FakeWorker.all[0].emit({ type: 'ready', delegate: 'GPU' });
  await started;
  FakeWorker.all[0].emit(result());
  return { v, offline, recover };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  FakeWorker.all = [];
  streams = [];
  cameraWorks = true;
  getUserMedia.mockClear();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: async () => [] } });
  vi.stubGlobal('document', {
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({ setAttribute: () => {}, play: () => Promise.resolve(), srcObject: null, readyState: 0 }),
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Vision recovery after the first ready', () => {
  it('a camera unplug reopens the camera with the warm model and recovers on the next frame', async () => {
    const { v, offline, recover } = await readyVision();
    streams[0].track.end(); // USB cable bumped
    expect(v.offline).toBe(true);
    expect(v.status).toMatchObject({ state: 'error', cause: 'stalled' });
    expect(offline).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0); // camera-only retry
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(FakeWorker.all).toHaveLength(1); // same worker kept
    expect(FakeWorker.all[0].terminated).toBe(false);

    FakeWorker.all[0].emit(result());
    expect(v.offline).toBe(false);
    expect(v.status).toMatchObject({ state: 'ready' });
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('a camera that reopens but sends no frames gets a fresh worker on the next retry', async () => {
    const { v } = await readyVision();
    streams[0].track.end();
    await vi.advanceTimersByTimeAsync(0); // camera-only reopen, no frames follow
    expect(FakeWorker.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000); // CAMERA_ONLY_MS
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(v.offline).toBe(true);
  });

  it('a camera that stays gone keeps being retried without respawning the model', async () => {
    const { v } = await readyVision();
    cameraWorks = false;
    streams[0].track.end();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(getUserMedia.mock.calls.length).toBeGreaterThanOrEqual(4); // start + 3 retries
    expect(FakeWorker.all).toHaveLength(1);
    expect(v.status).toMatchObject({ state: 'error', cause: 'no-camera' });

    cameraWorks = true; // plugged back in
    await vi.advanceTimersByTimeAsync(3000);
    FakeWorker.all[0].emit(result());
    expect(v.offline).toBe(false);
  });

  it('a respawned worker gets its first-frame grace instead of being killed mid-compile', async () => {
    const { v, recover } = await readyVision();
    FakeWorker.all[0].onerror?.({ message: 'crash' });
    expect(v.status).toMatchObject({ state: 'error', cause: 'worker-crashed' });
    await vi.advanceTimersByTimeAsync(0); // respawn
    expect(FakeWorker.all).toHaveLength(2);
    FakeWorker.all[1].emit({ type: 'ready', delegate: 'GPU' });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(6000); // slow first inference: longer than RETRY_MS, shorter than FIRST_FRAME_MS
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[1].terminated).toBe(false);
    FakeWorker.all[1].emit(result());
    expect(v.offline).toBe(false);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('the stall watchdog takes the camera offline when results stop', async () => {
    const { v, offline } = await readyVision();
    await vi.advanceTimersByTimeAsync(2600); // STALL_MS + a watchdog tick
    expect(v.offline).toBe(true);
    expect(offline).toHaveBeenCalledTimes(1);
  });
});
