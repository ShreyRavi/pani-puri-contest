# Design system: night stall

What the Pani Puri Challenge screens are built from. It documents what exists in [src/styles.css](src/styles.css); it is not a source of new aesthetics. The visual source is the [Design canvas](https://claude.ai/code/artifact/a11882ba-97e9-4c74-ac93-0bd68c03f250), and the reasoning behind each rule is in [docs/designs/pani-puri-challenge.md](docs/designs/pani-puri-challenge.md) (DD1–DD24).

The stage is a fixed 1920×1080 canvas, scaled to fit the window, because it is mirrored to a TV.

## Rules

1. **Crowd text is at least 28px.** Anything the queue reads from a few metres away. Operator-only text (strip, Setup) is 18–24px.
2. **Text contrast is at least 4.5:1.** Every crowd pair is checked by [test/contrast.test.ts](test/contrast.test.ts).
3. **Bright chilli never carries text.** Use `--chilli-surface` for any chilli background with words on it.
4. **48px TV safe margin** at the top for toasts; 64px side padding on every screen.
5. **Color states, not decoration.** Striped meter fill = detector waiting; muted timer = paused; marigold banner = referee decision needed.
6. **Motion is short and functional** (pop on count, shake on undo, slide-up banner) and is switched off under `prefers-reduced-motion`.

## Color tokens

| Token | Hex | Used for |
| --- | --- | --- |
| `--ground` | #1B0E2B | page background, text on marigold/cream |
| `--panel` | #2A1540 | board, score card, Setup panels, overlay cards |
| `--panel-edge` | #341B4D | panel borders, board rows |
| `--strip` | #22123A | operator strip |
| `--well` | #0E0618 | camera box |
| `--empty-row` | #22123A | "open" board rows |
| `--marigold` | #FFB627 | names, banner, pills, progress, focus accents |
| `--chilli` | #E8432F | non-text accents only: open line, text shadows |
| `--chilli-surface` | #B82E1D | result card, Start round, Step back, Not a puri, LIVE chip |
| `--chilli-deep` | #9E2518 | button and card shadows |
| `--chutney` | #4CC27A | Count it / +1 puri, close line, OK dot |
| `--chutney-deep` | #0E2A17 | text on chutney |
| `--cream` | #FFF4DC | primary text, count, toast background |
| `--peach` | #FFE1B3 | secondary text on the result card |
| `--sand` | #CDBB9C | labels, board footer |
| `--muted` | #8E7FA3 | paused timer, empty rows, operator meta |
| `--warn-text` | #FF7A66 | countdown warning, low timer, error status |
| `--marigold-deep` | #C98A12 | second stripe of the meter's waiting fill (non-text) |
| `--line` | #6E5F85 | borders of outline buttons, inputs and Setup toggles; idle status dot (non-text) |

### Measured contrast

| Text on background | Ratio |
| --- | --- |
| cream on chilli-surface | 5.58 |
| peach on chilli-surface | 4.84 |
| cream on ground | 16.80 |
| marigold on ground | 10.46 |
| sand on ground | 9.77 |
| muted on ground (paused timer) | 4.99 |
| #FF7A66 on ground | 7.19 |
| sand on panel (board footer) | 8.74 |
| muted on empty-row | 4.70 |
| cream on panel | 15.02 |
| marigold on panel | 9.36 |
| ground on marigold | 10.46 |
| ground on cream (toast) | 16.80 |
| chutney-deep on chutney | 6.83 |
| *cream on bright chilli (not allowed)* | *3.64* |

Selection is ground on marigold; the text caret is marigold.

## Type

Titan One for display, Rubik (400/500/700/900) for everything else. Both are bundled, no network.

| Size | Font | Element |
| --- | --- | --- |
| 420 | Titan One | live count, countdown digit |
| 400 | Titan One | result count |
| 150 | Titan One | TIME! |
| 140 | Titan One | live timer |
| 120 | Titan One | title |
| 96 | Titan One | "already open" screen title |
| 80 | Titan One | paused card |
| 64 | Titan One | contestant name, step back |
| 56 | Titan One | board title, camera-off card |
| 44 / 36 | Titan One | banner title / +N more pill |
| 28–40 | Rubik | crowd text: pills, eyebrow, board rows, footer, toasts |
| 18–24 | Rubik | operator: strip, Setup |

## Spacing and shape

- Screen padding 64px sides; 48px from the top for toasts.
- Radii: 28 panels and camera box, 20 big inputs and Start, 12 buttons, 999 pills and chips.
- Big buttons cast a solid 8px shadow in the darker shade of their color.

## Components

- **Status pill:** dot (chutney ok, marigold waiting, chilli bad) + 28px text, top-left of the camera box.
- **Operator strip:** primary actions first. Hybrid: Count it (chutney) and Not a puri (chilli-surface) lead. Manual, Auto, or camera off: **+1 puri (+)** leads in chutney and the others turn outline; in Auto the X button reads **Discount** and is enabled while the round has camera counts to take back (DD2). Keys never change.
- **Bite banner:** marigold bar along the bottom of the camera box. Title ("Bite spotted!", "Last bite? Referee decides", "Under review"), optional "+N more" pill, referee help. A 6px ground bar along its top shrinks for auto-confirm.
- **Overlay card:** centered in the camera box on panel color. Paused uses a 6px marigold dashed border and 80px text; camera off uses 56px text.
- **Toast:** cream on ground-text, top 48px, optional Undo button. The sticky notice uses the same style, holds the 48px slot until a key is pressed, and pushes a toast below it.
- **Board row:** rank, name, points. Top row marigold; your row on the result screen marigold with a cream outline; empty rows read "open" in muted.
- **Long board (more than 10):** #1 pinned above a scroll box holding #2 down; no scrollbar. Passive motion: hold on the top 8 s, glide down ~1 row/s, hold 4 s, glide up at 4x, repeat. Reduced motion pages instead of gliding. A trackpad/wheel scroll pauses it for 15 s. Soft 56px fade at the bottom while there's more below, 32px at the top once scrolled. Sign-up board label reads "All N" instead of "Top 10".
- **Dialog:** panel-colored card (4px panel-edge border, radius 24, 28px padding, 560px wide) over a dimmed ground backdrop. Edit a score and every yes/no question (Clear board, Remove entry, Reset settings) use it; the browser's own confirm() and validation bubbles are never shown. Buttons sit on the right with the action last: gold for a normal action, chilli-surface for a destructive one. Cancel has focus, Esc cancels, and an unanswered dialog closes as "no" after a minute. Field errors are 20px warn-text under the field.
- **Demo dialog (How it works):** the same card, up to 1000px wide and sized so the 16:9 video, the four steps and the actions fit a laptop screen without scrolling. On phones it fills the width and the steps stack. The video always tries to play with sound; when the browser refuses (no click yet), it plays muted with a gold *Tap for sound* pill on it, and the first tap or key press anywhere turns the sound on. The small-screen variant adds a marigold-bordered note on top and the gold button reads *Continue anyway*.
- **Help button:** 40px round, strip fill with a line border, at 70% opacity in the viewport's top-right corner (in the letterbox on a 16:10 laptop); full opacity with a marigold border on hover or focus. Hidden during a live round.
- **Already-open screen:** full stage on ground, 96px Titan One marigold title, 40px Rubik cream line (max 1200px). Shown when another tab holds the stall; the app beneath is inert.
- **Meter (Setup):** marigold fill, chilli open line, chutney close line (dashed and moving with the peak in Relative mode), striped while waiting.

## Overlay order (z-index)

Top to bottom:

| z | Layer |
| --- | --- |
| 80 | "already open in another tab" screen |
| 70 | toast, sticky notice |
| 60 | 3-2-1 countdown |
| 50 | camera-off card |
| 40 | paused card |
| 30 | bite banner |
| 20 | step back card |
| 10 | status pill, camera tag |

Suppression: step back hides while paused or camera off; the banner hides while camera off (Count it / Not a puri stay usable in the strip); the paused card hides under camera off.

## Icon

[public/icons/app-icon.svg](public/icons/app-icon.svg): a marigold puri with a chilli offset shadow (the title's shadow), its cracked top full of chutney-green pani and a drop above, on a ground tile with a dashed marigold stall border. [public/favicon.svg](public/favicon.svg) is the same puri without the border for 16–32px.
