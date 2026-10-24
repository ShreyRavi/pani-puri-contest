/// <reference lib="webworker" />
// Inference worker: owns the MediaPipe landmarkers so the UI thread only paints.

import { FaceLandmarker, FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { mouthRatio } from '../detector';
import { pickFace, type PickState } from './pick';
import type { FromWorker, Point, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const LIPS = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191,
];
const FINGERTIPS = [4, 8, 12, 16, 20];
const HAND_NEAR_PX = 80;
const REFERENCE_FACE_PX = 200;

let base = '';
let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let face: FaceLandmarker | null = null;
let hand: HandLandmarker | null = null;
let handLoading: Promise<void> | null = null;
/** After a failed hand-model load, wait before trying again instead of refetching every frame. */
let handRetryAt = 0;
const HAND_RETRY_MS = 30000;
let delegate: 'GPU' | 'CPU' = 'GPU';
let lastTs = 0;
let pickState: PickState | null = null;
const lumaCanvas = new OffscreenCanvas(32, 24);
const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true })!;

const post = (m: FromWorker) => self.postMessage(m);

async function create<T>(make: (d: 'GPU' | 'CPU') => Promise<T>): Promise<T> {
  if (delegate === 'GPU') {
    try {
      return await make('GPU');
    } catch {
      delegate = 'CPU';
    }
  }
  return make('CPU');
}

async function init(b: string, hands: boolean): Promise<void> {
  base = b;
  fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`, true);
  face = await create((d) =>
    FaceLandmarker.createFromOptions(fileset!, {
      baseOptions: { modelAssetPath: `${base}mediapipe/face_landmarker.task`, delegate: d },
      runningMode: 'VIDEO',
      // Two faces keep the lock sticky when a bystander leans in; on the CPU fallback the second
      // face would double the per-frame cost, so track one there.
      numFaces: d === 'GPU' ? 2 : 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
  );
  if (hands) await ensureHands();
  post({ type: 'ready', delegate });
}

function ensureHands(): Promise<void> {
  if (!handLoading && performance.now() < handRetryAt) return Promise.resolve();
  handLoading ??= create((d) =>
    HandLandmarker.createFromOptions(fileset!, {
      baseOptions: { modelAssetPath: `${base}mediapipe/hand_landmarker.task`, delegate: d },
      runningMode: 'VIDEO',
      numHands: 2,
    }),
  ).then(
    (h) => {
      hand = h;
    },
    (err: unknown) => {
      // Let a later frame retry the load instead of caching the failure forever.
      handLoading = null;
      handRetryAt = performance.now() + HAND_RETRY_MS;
      post({ type: 'error', message: `hand model failed: ${String(err)}`, fatal: false, kind: 'hand' });
    },
  );
  return handLoading;
}

function luma(bitmap: ImageBitmap): number {
  lumaCtx.drawImage(bitmap, 0, 0, 32, 24);
  const d = lumaCtx.getImageData(0, 0, 32, 24).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return sum / (d.length / 4);
}

function frame(bitmap: ImageBitmap, t: number, hands: boolean): void {
  if (!face) {
    bitmap.close();
    return;
  }
  const t0 = performance.now();
  // MediaPipe requires strictly increasing timestamps per task.
  const ts = (lastTs = Math.max(lastTs + 1, Math.round(t)));
  const w = bitmap.width;
  const h = bitmap.height;
  const px = (p: NormalizedLandmark): Point => ({ x: p.x * w, y: p.y * h });

  const fr = face.detectForVideo(bitmap, ts);
  const faces = fr.faceLandmarks.map((f) => {
    const up = px(f[13]);
    const lo = px(f[14]);
    const l = px(f[61]);
    const r = px(f[291]);
    const fl = px(f[234]);
    const rt = px(f[454]);
    return {
      lm: f,
      up,
      lo,
      l,
      r,
      mouth: { x: (l.x + r.x) / 2, y: (up.y + lo.y) / 2 },
      width: Math.hypot(rt.x - fl.x, rt.y - fl.y),
    };
  });
  const pick = pickFace(faces, pickState);
  pickState = pick.state;
  const chosen = pick.index == null ? null : faces[pick.index];
  const lm = chosen?.lm;
  let ratio: number | null = null;
  let mouth: Point | null = null;
  let faceWidth = 0;
  let lips: Point[] = [];
  if (chosen && lm) {
    ratio = mouthRatio(chosen.up, chosen.lo, chosen.l, chosen.r);
    mouth = chosen.mouth;
    faceWidth = chosen.width;
    lips = LIPS.map((i) => ({ x: lm[i].x, y: lm[i].y }));
  }

  let handDist: number | null = null;
  if (hands) {
    if (!hand) void ensureHands();
    else if (mouth) {
      const hr = hand.detectForVideo(bitmap, ts);
      for (const hl of hr.landmarks) {
        for (const i of FINGERTIPS) {
          const p = px(hl[i]);
          const dist = Math.hypot(p.x - mouth.x, p.y - mouth.y);
          handDist = handDist == null ? dist : Math.min(handDist, dist);
        }
      }
    }
  }
  const limit = HAND_NEAR_PX * (faceWidth > 0 ? faceWidth / REFERENCE_FACE_PX : 1);
  const lum = luma(bitmap);
  bitmap.close();

  post({
    type: 'result',
    t,
    faceFound: !!lm,
    faceSwitched: pick.switched,
    ratio,
    mouth,
    faceWidth,
    handDist,
    handNear: handDist != null && handDist <= limit,
    lips,
    luma: lum,
    inferMs: performance.now() - t0,
  });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'init') {
    init(m.base, m.hands).catch((err: unknown) => post({ type: 'error', message: String(err), fatal: true, kind: 'init' }));
  } else if (m.type === 'frame') {
    try {
      frame(m.bitmap, m.t, m.hands);
    } catch (err) {
      m.bitmap.close();
      post({ type: 'error', message: String(err), fatal: false, kind: 'frame' });
    }
  }
};
