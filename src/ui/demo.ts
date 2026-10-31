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

/** Removes the "first tap turns the sound on" listeners of the video playing now. */
let stopListening: (() => void) | null = null;

/**
 * Autoplay, with sound whenever the browser allows it. Browsers only allow sound once the viewer has clicked or
 * pressed something (Chrome also allows it on sites a browser visits often), so it tries with sound first and
 * falls back to muted with "Tap for sound" shown. Then the viewer's first tap or key press anywhere turns the
 * sound on, so nobody has to find the button.
 */
export function playDemo(video: HTMLVideoElement, soundBtn: HTMLButtonElement): void {
  const sync = () => (soundBtn.hidden = !video.muted || video.paused);
  video.onvolumechange = sync;
  video.onplay = sync;
  video.onpause = sync;
  const unmute = () => {
    video.muted = false;
    // Chrome pauses a video unmuted without permission: put it back to muted and playing.
    void video.play().catch(() => {
      video.muted = true;
      void video.play().catch(sync);
    });
  };
  soundBtn.onclick = unmute;

  stopListening?.();
  const onGesture = (e: Event) => {
    if (!video.muted || video.paused) return;
    // The video's own controls (its mute button, play/pause) keep working exactly as the viewer pressed them.
    if (e.target === video) return;
    // Esc and modifier keys don't count as permission for sound: wait for a real tap or key.
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    unmute();
  };
  document.addEventListener('click', onGesture, true);
  document.addEventListener('keydown', onGesture, true);
  stopListening = () => {
    document.removeEventListener('click', onGesture, true);
    document.removeEventListener('keydown', onGesture, true);
    stopListening = null;
  };

  video.muted = false;
  video.play().catch(() => {
    video.muted = true;
    video.play().catch(sync);
  });
  sync();
}

export function stopDemo(video: HTMLVideoElement): void {
  stopListening?.();
  video.pause();
  if (video.readyState > 0) video.currentTime = 0;
}
