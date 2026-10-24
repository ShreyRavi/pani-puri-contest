// Messages between the main thread and the inference worker.

export interface InitMessage {
  type: 'init';
  base: string;
  hands: boolean;
}

export interface FrameMessage {
  type: 'frame';
  bitmap: ImageBitmap;
  /** performance.now() at capture, echoed back for latency */
  t: number;
  hands: boolean;
}

export type ToWorker = InitMessage | FrameMessage;

export interface Point {
  x: number;
  y: number;
}

export interface VisionResult {
  type: 'result';
  t: number;
  faceFound: boolean;
  /** true on the frame the tracked face changed to a different (wider) person */
  faceSwitched: boolean;
  ratio: number | null;
  /** mouth center in frame px (640x480) */
  mouth: Point | null;
  faceWidth: number;
  /** closest fingertip distance to mouth center in px, null when no hand */
  handDist: number | null;
  handNear: boolean;
  /** outer + inner lip contour in normalized coords for the overlay */
  lips: Point[];
  /** mean luma 0..255 */
  luma: number;
  inferMs: number;
}

export type FromWorker =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  | VisionResult;
