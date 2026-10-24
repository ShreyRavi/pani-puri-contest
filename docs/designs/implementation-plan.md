# Pani Puri Challenge: implementation plan

This plan executes the reviewed design in [pani-puri-challenge.md](pani-puri-challenge.md): the merged tasks M1-M10, eng decisions R1-R14 and O1-O22, and design decisions DD1-DD24. It adds review and QA checkpoints, ships through a PR, and deploys with the Vercel CLI.

**What GO authorizes:** commits and pushes to `github.com/ShreyRavi/pani-puri-contest`, one PR (merged by /ship), and Vercel preview and production deploys under the `shreyravi` account.

**Out of scope:** deleting anything outside the repo, changing GitHub or Vercel account settings, and buying anything.

## Phase 0: Baseline (~5 min)
1. `main` has no commits yet. Commit the current working app to `main` as "Initial stall app (pre-review baseline)" and push it. This gives /review and /ship a real base.
2. Create the branch `feat/reviewed-build` from `main`. All later work lands here.
3. Gate: `npm test` (24 tests) and `npm run build` both green on the baseline.

## Phase 1: Core logic, in parallel worktrees (~60 min CC)
| Lane | Task | Files |
|---|---|---|
| A | M1 round logic, then M4 store (they share the saved round and result shape) | src/round.ts, src/store.ts, test/round.test.ts, test/store.test.ts |
| B | M2 detector: Relative + Absolute modes, Absolute default (O21) | src/detector.ts, test/detector.test.ts |
| C | M3 vision: sticky face, watchdog, named causes, darkness | src/vision/*, new unit tests |
| D | M8 offline/infra: build-time precache manifest, versioned cache, `--strictPort` | vite.config.ts, public/sw.js, package.json |

- Merge order: A, B, C, D, then reconcile the settings shape (M4 first).
- Gate:
  - `npm run typecheck`;
  - `npm test`, which must keep every existing assertion except the intentional changes listed in R9/O15;
  - `npm run build`.

**Checkpoint 1: `/review`** on the branch diff. Fix findings, rerun the gate, then commit "Core logic: queue, timing model, detector modes, vision health, store, offline".

## Phase 2: UI wiring (~90 min CC, sequential because index.html is shared)
1. **M5** main and the live/result views:
   - hotkeys: keyboard lock, `e.repeat`, result-screen Space, Ctrl/Cmd+Z undo, Esc restores a Re-run, notice key passthrough;
   - buzzer at 0:00;
   - strip primary follows the mode;
   - banner with the "+N" pill and auto-confirm bar;
   - paused and camera-off cards, with the z-order;
   - result pill and Adjusted chip;
   - undo toast and sticky notice;
   - wake lock.
2. **M6** Setup: rebalanced panels, detection toggle, Close/Drop slot, mode-true meter, honest copy, event line.
3. **M7** styles: `--chilli-surface`, contrast swaps, caret and selection, z-order tokens, toasts at top 48px.
4. Gate: typecheck, unit tests, build.

**Checkpoint 2: `/qa`** against `npm run stall` (local preview) in headless Chrome with the fake camera:
- the full keyboard round;
- seeded paused, queued, grace-hold and camera-off states;
- result variants: 0 puris, rank 11+, Adjusted;
- Discard followed by Ctrl/Cmd+Z;
- Setup fitting 1080px in both detection modes;
- a screenshot of every screen at 1920x1080.

Fix bugs inline, then commit "UI: live, result, setup per design review".

## Phase 3: Tests and docs (~35 min CC)
1. **M9:**
   - store and board unit tests;
   - `test/contrast.test.ts` (every crowd pair at least 4.5:1);
   - `npm run e2e` checked into the repo. It covers the keyboard loop, refresh mid-round, seeded states, Discard and undo, and offline with the server stopped.
2. **M10:**
   - DESIGN.md;
   - README: F for fullscreen, the detection modes and the rehearsal go/no-go, how to run from Vercel versus locally, and a note that the board lives per origin, so use one URL all night.
3. Gate: `npm test && npm run e2e && npm run build`.

**Checkpoint 3: `/review`** on the full diff, then **`/qa`** for a final full pass with screenshots. Fix anything found, then commit "Tests, e2e, DESIGN.md, README".

## Phase 4: Vercel preview (~10 min)
1. Add `vercel.json`:
   - framework `vite`, build `npm run build` (the prebuild step fetches models on Vercel's build machine), output `dist`;
   - headers: `sw.js` with `Cache-Control: no-cache`;
   - `/mediapipe/*` and `/assets/*` as `public, max-age=31536000, immutable`.
2. `vercel link` to a new project named `pani-puri-challenge` under `shreyravi`, then `vercel` for a preview deploy.
3. Smoke the preview URL in headless Chrome:
   - the page loads over HTTPS;
   - the camera permission flow works with the fake device;
   - the face model loads from `/mediapipe`;
   - the service worker installs;
   - reload while offline still works;
   - no console errors.

## Phase 5: Ship and production (~10 min)
1. **`/ship`:** test gate, final diff review, VERSION and CHANGELOG, push, open the PR into `main`, merge.
2. `vercel --prod` from the merged `main`, then repeat the Phase 4 smoke against the production URL.
3. Re-run **`/plan-eng-review`** against the shipped code to clear the required gate, then print the final dashboard.

## Stop conditions (pause and ask instead of pushing on)
- A gate fails three times on the same issue.
- /review or /qa finds something that would change an approved decision.
- A Vercel build fails for a reason outside the repo, such as account limits or the model download being blocked.
- Any step would need a credential, payment or account change.

## What stays manual (yours, after ship)
- The dress rehearsal at the stall with real people. It's the go/no-go for switching to Relative detection (O21), plus tuning the open line, drop/close and gap.
- On the stall laptop:
  - open the production URL once on wifi;
  - allow the camera ("always");
  - turn off display sleep;
  - keep the laptop plugged in.
- Real latency, p95 under 150 ms, measured on the stall laptop in Setup.

## Estimate
About 5-6 hours of Claude Code time end to end, including three review/QA checkpoints. The Vercel and ship steps take minutes.
