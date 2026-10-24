# Pani Puri Challenge

A single-page app for a live pani puri eating contest at a wedding stall. One laptop, mirrored over HDMI to a 1920×1080 TV, runs the crowd display, the 60-second timer, the counting and the leaderboard.

- **Solo time trials:** most puris in the round wins. The board shows the top 10, and every round is kept on the laptop.
- **Hybrid counting:** the webcam spots a bite, and the referee confirms with **Space** or rejects with **X**. Manual **+ / −** always works. Setup can switch to Auto or Manual.
- **Private:** no video leaves the laptop and nothing is recorded. Frames go only to an in-page Web Worker.
- **Offline:** MediaPipe models, WASM and fonts are bundled. After one load the service worker serves everything, so venue wifi doesn't matter.

Design source: [Design canvas](https://claude.ai/code/artifact/a11882ba-97e9-4c74-ac93-0bd68c03f250). Design record: [docs/designs/pani-puri-challenge.md](docs/designs/pani-puri-challenge.md).

## Where to run it: local or Vercel

Two ways to open the app. Pick **one URL for the whole night**, because the board and settings live in that URL's browser storage: `localhost:4173` and the hosted site keep separate boards.

- **Local (most reliable):** `npm run stall` on the laptop. No network needed at all.
- **Hosted:** open the Vercel URL once at home on wifi, wait ~10 s for the models to cache, then it works offline too. No Node needed at the venue.

## Set up the stall laptop (do this at home, on wifi)

Requirements: Node 20+ and **Google Chrome** (WebGL in workers gives the lowest latency).

```sh
npm install
npm run stall        # fetches models, builds, serves on http://localhost:4173 and opens Chrome
```

1. When Chrome asks, allow the camera. Choose "Allow on every visit".
2. Leave the page open for ~10 seconds so the service worker caches the models.
3. **Real offline test:** turn off wifi *and* stop the server (Ctrl+C in the terminal), then reload. The page, fonts and the camera with face tracking should all come up. If they don't, reconnect, reload once, wait 10 s and try again.

At the venue you only need `npm run preview` (or `npm run stall`). Neither needs a network.

If `npm run stall` says the port is in use, an old server is still running: close that terminal window, or run `lsof -i :4173` and quit the listed process.

### Keep the laptop awake

The page asks Chrome to keep the screen on while it's open, but set this too: **System Settings › Lock Screen › Turn display off: Never** (macOS) or **Power › Screen: Never** (Windows), and plug in the charger.

### TV

1. Plug in HDMI and set the display to **mirror** at 1920×1080.
2. Press **F** for fullscreen (F again exits). Fullscreen also starts automatically when a round starts. The first time, Chrome shows a "Press and hold Esc to exit" bubble: ignore it, a normal Esc press stays with the app.
3. The layout is a fixed 1920×1080 stage that scales to fit, so it looks the same on the laptop screen and on the TV.

## Calibrate in 60 seconds (before the first contestant)

Press **Esc** then **S** on the sign-up screen to open Setup.

1. **Light (10s):** stand where contestants will stand, about 1 m from the camera. Status should read *Face found · ~30 fps*. If *Too dark* shows, turn a light toward the contestant's face. Backlight from the stall's string lights is the usual cause.
2. **Latency (5s):** check that the *Latency* line reads **p95 under 150 ms**. If it's over, close other apps and check that the status shows `GPU`, not `CPU`.
3. **Meter (20s):** open your mouth wide, then close it. The bar should cross the **red line (open)** and then the **green line (close)**. While a bite is in progress the bar turns striped and reads *Waiting for close*. The test log should show *bite candidate … would ask referee*.
   - If wide-open bites don't reach red, lower the **Mouth-open line** (try 0.40).
   - If talking or laughing triggers candidates, raise it (0.50) or tick **Require hand near mouth**.
4. **Real bite (20s):** eat one puri the way a contestant would, hand to mouth. The log should show one candidate. If it shows two, raise **Minimum gap between bites**.
5. **Mode:** leave **Hybrid** unless there's no referee, in which case use Manual and tap + per puri. Set the round length, sounds and the **Event line** (shown above the title), then press **Done (Esc)**. Settings save as you change them.

Write the final Mouth-open line and gap values on a sticky note and tape it to the laptop.

### Bite rule: Absolute or Relative (rehearsal go/no-go)

- **Absolute (default):** a bite is the mouth opening past the open line, then closing below the close line.
- **Relative:** a bite is opening past the open line, then dropping by **Drop** (default 0.15) from its peak. It still works when someone chews with their mouth half open and never gets below the close line.

At rehearsal, have three people eat five puris each. **Go with Absolute** if the log catches at least 4 of every 5. If people regularly stay above the green line between bites (the bar sits striped on *Waiting for close*), switch **Bite rule** to Relative and repeat. Either way the referee still confirms every bite in Hybrid.

## Running a round

| Screen | What happens | Keys |
| --- | --- | --- |
| Who's next | Contestant types a first name | **Enter** starts |
| 3-2-1 | Countdown. Contestant keeps their mouth closed while the resting baseline is captured | **Esc** cancels |
| Live | Camera flags a bite and the banner pops up (*+N more* when several wait) | **Space** count it · **X** not a puri · **+ / −** manual · **P** pause · **Esc Esc** end early |
| Time! | Score saved to the board. Returns to sign-up after 20s | **Enter** next · **+ / −** fix score |

Other keys: **F** toggles fullscreen. **S** opens Setup from sign-up (press **Esc** first if the name box is focused) or from the result screen. **⌘/Ctrl Z** undoes a Discard or Re-run while its toast is showing. Holding a key down counts once.

How it behaves:
- **Ending early:** press **Esc** twice within 2 seconds. A single stray Esc can't end someone's round.
- **Contestant leaves the frame:** after 3 seconds a *Step back in!* banner appears, and the timer keeps running.
- **Bite flagged in the last moment:** bites that started before the buzzer still show up for about 1.5 s after it, and the screen holds on *TIME!* until the referee decides (10 s at most; anything left is listed as *not counted*).
- **Auto-confirm:** with Setup › Auto-confirm above 0, a waiting bite counts by itself after that many seconds. A bar on the banner shows the time left.
- **Camera drops out mid-round:** the camera box shows *Camera off · referee is counting*, **+1** becomes the main button, and the timer keeps going. When the camera comes back a *Camera back* toast appears.
- **Refresh or crash mid-round:** reload the page. The round resumes with the right count and time remaining. If it's more than 5 minutes old, a score above 0 is saved to the board and a notice says so.
- **Re-run round / Discard** on the result screen remove that score from the board, with a 5 s Undo (⌘/Ctrl Z, or **Esc** during the re-run countdown).
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
- **Bite candidate:** the ratio rises above **open** (default 0.45), then falls below **close** (0.20) within the **bite window** (1.2 s), with at least **cooldown** (1.5 s) since the last candidate. In Relative mode the fall is "Drop below the peak" instead of below a fixed line.
- **Baseline:** captured during the 3-2-1. If someone's resting mouth sits above the close line, close is raised to baseline + 0.05 for that round.
- **Hand gate (optional):** a fingertip within 80 px of the mouth center in the 600 ms before the open. The 80 px is scaled by face size, so distance from the camera doesn't matter.
- **Too dark:** a face was found in fewer than half the frames over the last 2 s, or the picture's mean brightness is below 45/255. Face Landmarker gives no per-face confidence score, so these two signals stand in for one.
- **Latency:** measured from the camera's capture timestamp to the bite decision on the main thread. Setup shows p50 and p95 over the last 100 frames. The count paints on the next frame.

Code map: [src/detector.ts](src/detector.ts) (pure detector) · [src/round.ts](src/round.ts) (pure state machine) · [src/vision/](src/vision/) (camera + worker) · [src/store.ts](src/store.ts) (localStorage) · [src/main.ts](src/main.ts) (views, hotkeys, loop) · [public/sw.js](public/sw.js) (offline cache).

## Development

```sh
npm run dev          # http://localhost:5173 (service worker disabled in dev)
npm test             # unit tests: detector, round machine, store, board, contrast, service worker manifest
npm run e2e          # builds, then drives real Chrome with a fake camera (incl. offline with the server stopped)
npm run typecheck
```

`npm run fetch-models` copies the MediaPipe WASM out of `node_modules` and downloads the two `.task` models into `public/mediapipe/`, which is gitignored. It runs automatically before `dev` and `build`, and skips models that are already there.

## Troubleshooting

- **"Camera blocked":** click the camera icon in Chrome's address bar, choose Allow, then reload.
- **"Camera is busy in another app":** quit Zoom, FaceTime or Photo Booth.
- **"Camera stopped sending frames":** unplug and replug the webcam; the app retries on its own.
- **External webcam not used:** pick it under Setup › Camera.
- **Status says CPU and latency is high:** in Chrome, enable *Use graphics acceleration when available* and restart Chrome.
- **Board needs a reset for the next event:** Setup › Clear board (asks twice).
