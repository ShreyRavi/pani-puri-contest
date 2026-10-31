// "How it works": the demo video plus a four-step walkthrough. One copy of the steps feeds both the
// in-app help dialog and the shareable /demo page, so they never drift apart.

export const DEMO_VIDEO = '/media/pani-puri-demo.mp4';
export const DEMO_POSTER = '/media/pani-puri-demo.jpg';

export const DEMO_STEPS: readonly { title: string; body: string }[] = [
  {
    title: 'Set up the stall',
    body: 'Open panipurigame.com on a laptop with a webcam, mirror it to a TV and allow the camera. Video stays on the laptop and nothing is recorded.',
  },
  { title: 'Sign up', body: "Type the contestant's first name and press Enter. A 3-2-1 countdown starts the round." },
  {
    title: 'Eat!',
    body: "The camera adds +1 for every bite it sees. If it counts one it shouldn't, the referee presses X to discount it. + and - fix the count by hand.",
  },
  {
    title: 'Climb the board',
    body: "When time is up the score lands on tonight's board. Between rounds, press S for Setup: round length, counting mode and sounds.",
  },
];

/** Phones and small windows: the stall is meant for a laptop or desktop mirrored to a TV. */
export const SMALL_SCREEN_QUERY = '(max-width: 819px), (max-height: 499px)';

const KEYS = { seen: 'ppc.demo.v1', smallOk: 'ppc.smallok.v1' } as const;

export type BootDemo = 'small' | 'first' | null;

/**
 * What to show when the app opens: the small-screen notice (until "Continue anyway" on this device), the
 * demo on a first visit, or nothing. A round in progress always wins: the TV must not be covered.
 */
export function bootDemo(store: Pick<Storage, 'getItem'>, small: boolean, inRound: boolean): BootDemo {
  if (inRound) return null;
  const get = (k: string) => {
    try {
      return store.getItem(k);
    } catch {
      return null;
    }
  };
  if (small && !get(KEYS.smallOk)) return 'small';
  if (!get(KEYS.seen)) return 'first';
  return null;
}

/** Remember the demo was seen (and, from the small-screen notice, that this device chose to carry on). */
export function rememberDemo(store: Pick<Storage, 'setItem'>, kind: BootDemo): void {
  try {
    store.setItem(KEYS.seen, '1');
    if (kind === 'small') store.setItem(KEYS.smallOk, '1');
  } catch {
    // storage blocked: the demo just shows again next time
  }
}

export function renderSteps(list: HTMLOListElement): void {
  list.replaceChildren(
    ...DEMO_STEPS.map((s) => {
      const li = document.createElement('li');
      const b = document.createElement('strong');
      b.textContent = s.title;
      li.append(b, ` ${s.body}`);
      return li;
    }),
  );
}

/**
 * Autoplay. Browsers only allow sound after the viewer has clicked or pressed something, so sound is tried
 * when `withSound` (opened from the ? button) and the video falls back to muted, with "Tap for sound" shown.
 */
export function playDemo(video: HTMLVideoElement, soundBtn: HTMLButtonElement, withSound: boolean): void {
  const sync = () => (soundBtn.hidden = !video.muted || video.paused);
  video.onvolumechange = sync;
  video.onplay = sync;
  video.onpause = sync;
  soundBtn.onclick = () => {
    video.muted = false;
    void video.play().catch(() => {});
  };
  video.muted = !withSound;
  video.play().catch(() => {
    if (video.muted) return sync();
    video.muted = true;
    video.play().catch(sync);
  });
  sync();
}

export function stopDemo(video: HTMLVideoElement): void {
  video.pause();
  if (video.readyState > 0) video.currentTime = 0;
}
