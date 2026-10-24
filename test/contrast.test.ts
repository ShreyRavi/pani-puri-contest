// WCAG contrast for every crowd-visible text/background pair (4.5:1 minimum, DD18/DD19/DD23).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));

function color(v: string): string {
  const hex = v.startsWith('#') ? v : tokens[v];
  if (!hex) throw new Error(`unknown token --${v}`);
  return hex;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(color(fg)), luminance(color(bg))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// [foreground, background, where it shows]
const PAIRS: [string, string, string][] = [
  ['cream', 'chilli-surface', 'result card, Start round, Step back, Not a puri, LIVE chip'],
  ['peach', 'chilli-surface', 'result "ate" line and subline'],
  ['cream', 'ground', 'count, timer, titles'],
  ['marigold', 'ground', 'names, eyebrow, "+N more" pill'],
  ['sand', 'ground', 'labels, "Now eating"'],
  ['muted', 'ground', 'paused timer'],
  ['#ff7a66', 'ground', 'countdown warning hint, low timer'],
  ['sand', 'panel', 'board footer note'],
  ['muted', 'empty-row', 'open board rows'],
  ['cream', 'panel', 'paused and camera-off cards, board names'],
  ['marigold', 'panel', 'board title, chase line'],
  ['ground', 'marigold', 'bite banner, outcome pill, Adjusted chip, top row'],
  ['ground', 'cream', 'toast'],
  ['chutney-deep', 'chutney', 'Count it, +1 puri'],
  ['cream', 'panel-edge', 'board rows'],
];

describe('contrast tokens', () => {
  it('reads the tokens from styles.css', () => {
    expect(tokens['chilli-surface']).toBe('#b82e1d');
  });

  it.each(PAIRS)('%s on %s (%s) passes 4.5:1', (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps bright chilli off text surfaces', () => {
    expect(contrast('cream', 'chilli')).toBeLessThan(4.5); // why --chilli-surface exists
  });
});
