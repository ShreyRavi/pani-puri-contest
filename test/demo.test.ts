// Value: protects=the how-it-works demo opening once on a first visit, the small-screen notice until "Continue anyway",
//   and never covering a round in progress; fails_when=the boot rule or what is remembered changes; why_new=new module;
//   seam=a fake Storage; no_claim=autoplay and the dialog itself (e2e covers the DOM wiring)
import { describe, expect, it } from 'vitest';
import { bootDemo, DEMO_STEPS, rememberDemo } from '../src/ui/demo';

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
