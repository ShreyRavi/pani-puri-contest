# Pani Puri Challenge

A single-page app for a live pani puri eating contest at a wedding stall. One laptop, mirrored over HDMI to a 1920×1080 TV, runs the crowd display, the 60-second timer, the counting and the leaderboard.

- **Solo time trials:** most puris in the round wins. The board shows the top 10, and every round is kept on the laptop.
- **Hybrid counting:** the webcam spots a bite, and the referee confirms with **Space** or rejects with **X**. Manual **+ / −** always works. Setup can switch to Auto or Manual.
- **Private:** no video leaves the laptop and nothing is recorded. Frames go only to an in-page Web Worker.
- **Offline:** MediaPipe models, WASM and fonts are bundled. After one load the service worker serves everything, so venue wifi doesn't matter.

Design source: [Design canvas](https://claude.ai/code/artifact/a11882ba-97e9-4c74-ac93-0bd68c03f250). Design record: [docs/designs/pani-puri-challenge.md](docs/designs/pani-puri-challenge.md).

## Set up the stall laptop (do this at home, on wifi)

Requirements: Node 20+ and **Google Chrome** (WebGL in workers gives the lowest latency).

```sh
npm install
npm run stall        # fetches models, builds, serves on http://localhost:4173 and opens Chrome
```

1. When Chrome asks, allow the camera. Choose "Allow on every visit".
2. Leave the page open for ~10 seconds so the service worker caches the models.
3. Test offline: turn off wifi and reload. The page and the camera should still come up.

At the venue you only need `npm run preview` (or `npm run stall`). Neither needs a network.

### TV

1. Plug in HDMI and set the display to **mirror** at 1920×1080.
2. Press **F** for fullscreen. Fullscreen also starts automatically when a round starts.
3. The layout is a fixed 1920×1080 stage that scales to fit, so it looks the same on the laptop screen and on the TV.

## Calibrate in 60 seconds (before the first contestant)

Press **Esc** then **S** on the sign-up screen to open Setup.

1. **Light (10s):** stand where contestants will stand, about 1 m from the camera. Status should read *Face found · ~30 fps*. If *Too dark* shows, turn a light toward the contestant's face. Backlight from the stall's string lights is the usual cause.
2. **Latency (5s):** check that the *Latency* line reads **p95 under 150 ms**. If it's over, close other apps and check that the status shows `GPU`, not `CPU`.
3. **Meter (20s):** open your mouth wide, then close it. The bar should cross the **red line (open)** and then the **green line (close)**. The test log should show *bite candidate … would ask referee*.
   - If wide-open bites don't reach red, lower **Sensitivity** (try 0.40).
   - If talking or laughing triggers candidates, raise Sensitivity (0.50) or tick **Require hand near mouth**.
4. **Real bite (20s):** eat one puri the way a contestant would, hand to mouth. The log should show one candidate. If it shows two, raise **Minimum gap between bites**.
5. **Mode:** leave **Hybrid** unless there's no referee, in which case use Manual and tap + per puri. Set the round length and sounds, then press **Save settings**. Settings are saved immediately.

Write the final Sensitivity and gap values on a sticky note and tape it to the laptop.

## Running a round

| Screen | What happens | Keys |
| --- | --- | --- |
| Who's next | Contestant types a first name | **Enter** starts |
| 3-2-1 | Countdown. Contestant keeps their mouth closed while the resting baseline is captured | **Esc** cancels |
| Live | Camera flags a bite and the banner pops up | **Space** count it · **X** not a puri · **+ / −** manual · **P** pause · **Esc Esc** end early |
| Time! | Score saved to the board. Returns to sign-up after 20s | **Enter** next · **+ / −** fix score |

Other keys: **F** toggles fullscreen. **S** opens Setup from sign-up (press **Esc** first if the name box is focused) or from the result screen.

How it behaves:
- **Ending early:** press **Esc** twice within 2 seconds. A single stray Esc can't end someone's round.
- **Contestant leaves the frame:** after 3 seconds a *Step back in!* banner appears, and the timer keeps running.
- **Bite flagged in the last moment:** the referee gets 1.5 s after the buzzer to confirm it.
- **Refresh or crash mid-round:** reload the page. The round resumes with the right count and time remaining.
- **Re-run round / Discard** on the result screen remove that score from the board.
- **Fix score** opens an editor. **Setup › Edit a score** fixes any entry, and **Export CSV** downloads the night's board.

## How detection works

```
webcam 640×480 ─▶ main thread: createImageBitmap (one frame in flight)
                     │ transfer
                     ▼
             Web Worker: MediaPipe Face Landmarker (+ Hand Landmarker if gated)
                     │ ratio, mouth center, hand distance, brightness
                     ▼
             main thread: BiteDetector ─▶ RoundMachine ─▶ TV
```

- **Mouth-open ratio:** inner-lip gap (landmarks 13–14) divided by mouth width (61–291).
- **Bite candidate:** the ratio rises above **open** (default 0.45), then falls below **close** (0.20) within 1.2 s, with at least **cooldown** (1.5 s) since the last candidate.
- **Baseline:** captured during the 3-2-1. If someone's resting mouth sits above the close line, close is raised to baseline + 0.05 for that round.
- **Hand gate (optional):** a fingertip within 80 px of the mouth center in the 600 ms before the open. The 80 px is scaled by face size, so distance from the camera doesn't matter.
- **Too dark:** a face was found in fewer than half the frames over the last 2 s, or the picture's mean brightness is below 45/255. Face Landmarker gives no per-face confidence score, so these two signals stand in for one.
- **Latency:** measured from the camera's capture timestamp to the bite decision on the main thread. Setup shows p50 and p95 over the last 100 frames. The count paints on the next frame.

Code map: [src/detector.ts](src/detector.ts) (pure detector) · [src/round.ts](src/round.ts) (pure state machine) · [src/vision/](src/vision/) (camera + worker) · [src/store.ts](src/store.ts) (localStorage) · [src/main.ts](src/main.ts) (views, hotkeys, loop) · [public/sw.js](public/sw.js) (offline cache).

## Development

```sh
npm run dev          # http://localhost:5173 (service worker disabled in dev)
npm test             # detector + round machine unit tests
npm run typecheck
```

`npm run fetch-models` copies the MediaPipe WASM out of `node_modules` and downloads the two `.task` models into `public/mediapipe/`, which is gitignored. It runs automatically before `dev` and `build`, and skips models that are already there.

## Troubleshooting

- **"Camera blocked":** click the camera icon in Chrome's address bar, choose Allow, then reload.
- **"Camera is busy":** quit Zoom, FaceTime or Photo Booth.
- **External webcam not used:** pick it under Setup › Camera.
- **Status says CPU and latency is high:** in Chrome, enable *Use graphics acceleration when available* and restart Chrome.
- **Board needs a reset for the next event:** Setup › Clear board (asks twice).
