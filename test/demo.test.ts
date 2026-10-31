// Value: protects=the how-it-works demo opening once on a first visit, the small-screen notice until "Continue anyway",
//   and never covering a round in progress; fails_when=the boot rule or what is remembered changes; why_new=new module;
//   seam=a fake Storage; no_claim=autoplay and the dialog itself (e2e covers the DOM wiring)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootDemo, DEMO_STEPS, playDemo, rememberDemo, stopDemo } from '../src/ui/demo';

function fakeStorage(init: Record<string, string> = {}) {
  const data = { ...init };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
}

describe('how-it-works demo at boot', () => {
  it('opens on a first visit, then never again once closed', () => {
    const s = fakeStorage();
    expect(bootDemo(s, false, false)).toBe('first');
    rememberDemo(s, 'first');
    expect(bootDemo(s, false, false)).toBe(null);
  });

  it('a phone sees the laptop notice, even after the demo, until it chooses Continue anyway', () => {
    const s = fakeStorage();
    rememberDemo(s, 'first'); // seen on this device before, at a larger size
    expect(bootDemo(s, true, false)).toBe('small');
    rememberDemo(s, 'small');
    expect(bootDemo(s, true, false)).toBe(null);
    expect(bootDemo(s, false, false)).toBe(null);
  });

  it('never covers a round in progress', () => {
    expect(bootDemo(fakeStorage(), false, true)).toBe(null);
    expect(bootDemo(fakeStorage(), true, true)).toBe(null);
  });

  it('blocked storage still boots (the demo just shows again)', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(bootDemo(blocked, false, false)).toBe('first');
    expect(() => rememberDemo(blocked, 'small')).not.toThrow();
  });

  it('the walkthrough has four steps, each with a title and copy', () => {
    expect(DEMO_STEPS).toHaveLength(4);
    for (const s of DEMO_STEPS) expect(s.title && s.body).toBeTruthy();
  });
});

// A video under the browser's autoplay rule: playing with sound is refused until the viewer has tapped or pressed a key.
let activated = false;
let listeners: Record<string, ((e: Event) => void)[]> = {};

function fakeVideo() {
  const v = {
    muted: false,
    paused: true,
    readyState: 4,
    currentTime: 0,
    onvolumechange: null as null | (() => void),
    onplay: null as null | (() => void),
    onpause: null as null | (() => void),
    play() {
      if (!v.muted && !activated) {
        v.paused = true;
        return Promise.reject(new DOMException('needs a gesture', 'NotAllowedError'));
      }
      v.paused = false;
      v.onplay?.();
      return Promise.resolve();
    },
    pause() {
      v.paused = true;
    },
  };
  return v;
}
const btn = () => ({ hidden: true, onclick: null as null | (() => void) });
const fire = (type: string, target: object = {}) => listeners[type]?.forEach((fn) => fn({ target } as unknown as Event));
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('demo video sound', () => {
  beforeEach(() => {
    activated = false;
    listeners = {};
    vi.stubGlobal('navigator', { userActivation: { get isActive() { return activated; } } });
    vi.stubGlobal('document', {
      addEventListener: (t: string, fn: (e: Event) => void) => (listeners[t] = [...(listeners[t] ?? []), fn]),
      removeEventListener: (t: string, fn: (e: Event) => void) => (listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn)),
    });
  });

  it('plays with sound when the browser allows it', async () => {
    activated = true; // e.g. opened from the ? button
    const v = fakeVideo();
    const b = btn();
    playDemo(v as unknown as HTMLVideoElement, b as unknown as HTMLButtonElement);
    await settle();
    expect(v.muted).toBe(false);
    expect(v.paused).toBe(false);
    expect(b.hidden).toBe(true);
  });

  it('otherwise starts muted with Tap for sound, and the first tap anywhere turns the sound on', async () => {
    const v = fakeVideo();
    const b = btn();
    playDemo(v as unknown as HTMLVideoElement, b as unknown as HTMLButtonElement);
    await settle();
    expect(v.muted).toBe(true);
    expect(v.paused).toBe(false);
    expect(b.hidden).toBe(false);
    activated = true;
    fire('click');
    await settle();
    expect(v.muted).toBe(false);
    expect(v.paused).toBe(false);
  });

  it('a key that grants no permission (Esc) leaves it muted and playing; a later key press unmutes', async () => {
    const v = fakeVideo();
    playDemo(v as unknown as HTMLVideoElement, btn() as unknown as HTMLButtonElement);
    await settle();
    fire('keydown');
    await settle();
    expect(v.muted).toBe(true);
    expect(v.paused).toBe(false);
    activated = true;
    fire('keydown');
    await settle();
    expect(v.muted).toBe(false);
  });

  it("the video's own controls are left alone (its mute button must not be undone)", async () => {
    const v = fakeVideo();
    playDemo(v as unknown as HTMLVideoElement, btn() as unknown as HTMLButtonElement);
    await settle();
    activated = true;
    fire('click', v);
    expect(v.muted).toBe(true);
  });

  it('closing the demo while it is still starting never restarts it in the background', async () => {
    const v = fakeVideo();
    let abort: (e: DOMException) => void = () => {};
    v.play = () => new Promise((_, reject) => (abort = reject)); // still loading
    playDemo(v as unknown as HTMLVideoElement, btn() as unknown as HTMLButtonElement);
    stopDemo(v as unknown as HTMLVideoElement);
    abort(new DOMException('interrupted by pause()', 'AbortError'));
    await settle();
    expect(v.paused).toBe(true);
    expect(v.muted).toBe(false); // left alone, not flipped to muted and replayed
  });

  it('closing the demo stops listening, so stall keys never touch the video', async () => {
    const v = fakeVideo();
    playDemo(v as unknown as HTMLVideoElement, btn() as unknown as HTMLButtonElement);
    await settle();
    stopDemo(v as unknown as HTMLVideoElement);
    expect(listeners.click).toEqual([]);
    expect(listeners.keydown).toEqual([]);
  });
});
