// End-to-end smoke test in real Chrome with a fake camera (no face, so bites are seeded).
// Usage: npm run e2e   (builds, serves dist on :4174, runs, then tests offline with the server stopped)
// Needs Google Chrome installed; set CHROME_PATH to use another Chromium.
import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const PORT = 4174;
const PROXY_PORT = 4184;
const URL = `http://127.0.0.1:${PORT}/`;
const results = [];
let server;

function startServer() {
  server = spawn('node_modules/.bin/vite', ['preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  return waitFor(async () => (await fetch(URL).catch(() => null))?.ok, 'preview server');
}

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The UI renders on the next animation frame, so DOM assertions poll briefly. */
async function expectText(page, sel, expected, ms = 4000) {
  const end = Date.now() + ms;
  let actual;
  while (Date.now() < end) {
    actual = await page.textContent(sel).catch(() => null);
    if (expected instanceof RegExp ? expected.test(actual ?? '') : actual === expected) return;
    await page.waitForTimeout(50);
  }
  assert.fail(`${sel}: expected ${expected}, got ${JSON.stringify(actual)}`);
}

async function expectVisible(page, sel, visible = true) {
  await page.waitForSelector(sel, { state: visible ? 'visible' : 'hidden', timeout: 4000 });
}

/** The app boots once it holds the tab lock; until then the stage is inert and no hotkeys listen. */
async function booted(p) {
  await p.waitForFunction(() => document.getElementById('view-idle')?.inert === false, null, { timeout: 10000 });
}

async function check(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message.split('\n').filter(Boolean).slice(0, 4).join(' / ')]);
  }
}

const IDLE = {
  phase: 'idle', name: '', durationMs: 60000, detectMs: 1500, autoConfirmMs: 0, count: 0, rejected: 0, notCounted: 0,
  armingEndsAt: 0, endsAt: 0, detectUntil: 0, capAt: 0, pausedRemaining: 0, pausedAt: 0, pausedFrom: null, resultAt: 0,
  queue: [], dueAt: 0, last: null, undoable: false, resultId: null,
};

await startServer();
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Any Content-Security-Policy violation (a blocked worker, wasm or model fetch) counts as a page error.
  await ctx.addInitScript(() => addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  page.on('console', (m) => m.type() === 'error' && m.text().startsWith('CSP violation') && errors.push(m.text()));
  const text = (s) => page.textContent(s);
  const seed = async (round, settings) => {
    await page.evaluate(([r, s]) => {
      localStorage.setItem('ppc.round.v1', JSON.stringify(r));
      if (s) localStorage.setItem('ppc.settings.v1', JSON.stringify(s));
    }, [round, settings]);
    await page.reload();
    await booted(page);
    await page.waitForSelector('#view-live:not([hidden]), #view-idle:not([hidden]), #view-result:not([hidden])');
  };

  const first = await page.goto(URL);
  await page.waitForSelector('#view-idle:not([hidden])');
  await booted(page);
  await check('serves the Content-Security-Policy that keeps frames on the laptop', async () => {
    const csp = first.headers()['content-security-policy'] ?? '';
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /form-action 'none'/);
  });

  await check('keyboard loop: name, countdown, +/-, end twice, result', async () => {
    await page.fill('#name-input', 'Priya');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#view-live:not([hidden])');
    await page.waitForSelector('#arming', { state: 'hidden', timeout: 5000 });
    for (let i = 0; i < 4; i++) await page.keyboard.press('+');
    await page.keyboard.press('-');
    await expectText(page, '#live-count', '3');
    await page.keyboard.press('Escape');
    await expectText(page, '#btn-end', /Press Esc again/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#view-result:not([hidden])');
    await expectText(page, '#res-count', '3');
    await expectText(page, '#res-rank', 'New #1 on the board!');
  });

  await check('discard then Cmd/Ctrl+Z restores the score', async () => {
    await page.click('#btn-discard');
    await page.waitForSelector('#view-idle:not([hidden])');
    await expectText(page, '#toast-text', /Priya's score removed/);
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForSelector('#view-result:not([hidden])');
    await expectText(page, '#res-count', '3');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#view-idle:not([hidden])');
  });

  await check('refresh mid-round keeps the count', async () => {
    const now = await page.evaluate(() => Date.now());
    await seed({ ...IDLE, phase: 'live', name: 'Ravi', count: 6, endsAt: now + 40000, savedAt: now });
    await page.reload();
    await booted(page);
    await page.waitForSelector('#view-live:not([hidden])');
    await expectText(page, '#live-count', '6');
  });

  await check('seeded bites: banner, +N more, auto-confirm bar, Esc waiting count', async () => {
    const now = await page.evaluate(() => Date.now());
    const bite = (dt) => ({ at: now - dt, openedAt: now - dt - 300, peak: 0.6, confidence: 0.8, hand: false });
    await seed(
      // Auto-confirm far enough out that a slow boot can't confirm a bite before the test does.
      { ...IDLE, phase: 'live', name: 'Arjun', count: 2, endsAt: now + 50000, autoConfirmMs: 60000, queue: [bite(400), bite(100)], dueAt: now + 59000, savedAt: now },
      { mode: 'hybrid', autoConfirmSeconds: 60 },
    );
    await expectVisible(page, '#bite-banner');
    await expectText(page, '#bite-more', '+1 more');
    await expectVisible(page, '#auto-bar');
    await page.keyboard.press('Escape');
    await expectText(page, '#btn-end', 'Press Esc again to end (2 bites waiting)');
    await expectText(page, '#btn-end', 'End round (Esc)'); // Esc arm lapses after 2 s
    await page.keyboard.press(' ');
    await expectText(page, '#live-count', '3');
  });

  await check('pause shows the referee card and freezes the clock', async () => {
    await page.keyboard.press('p');
    await expectVisible(page, '#paused-card');
    const t1 = await text('#live-timer');
    // gstack-timing-ok: proving the clock does NOT move needs a fixed wait longer than one timer tick (1 s).
    await page.waitForTimeout(1200);
    assert.equal(await text('#live-timer'), t1);
    await page.keyboard.press('p');
    await expectVisible(page, '#paused-card', false);
    // End through the UI: the open page owns the round and would write it back over storage.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-result');
    await page.waitForTimeout(1600); // a quick extra Esc can't skip the score reveal
    await page.click('#btn-discard');
    await expectVisible(page, '#view-idle');
  });

  await check('a pending Discard undo cannot replace the next round', async () => {
    await page.fill('#name-input', 'Kiran');
    await page.keyboard.press('Enter');
    await expectVisible(page, '#arming');
    await page.keyboard.press('ControlOrMeta+z');
    // gstack-timing-ok: a negative check (undo must NOT fire); give a wrongful restore a few frames to show.
    await page.waitForTimeout(200);
    await expectVisible(page, '#arming');
    await expectText(page, '#arming-name', 'Kiran');
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-idle');
  });

  // Generated by /ship coverage audit (pass 1).
  // Value: protects=holding + during a live round adds exactly one puri (O3); fails_when=the e.repeat guard in onKey is removed or
  //   moved below the live-key switch; why_new=no unit or e2e check sends auto-repeat keydowns; seam=none;
  //   no_claim=physical keyboard repeat rate (Playwright synthesizes repeat keydowns)
  await check('a held + key adds one puri, not one per auto-repeat (O3)', async () => {
    await page.fill('#name-input', 'Tara');
    await page.keyboard.press('Enter');
    await expectVisible(page, '#arming');
    await page.waitForSelector('#arming', { state: 'hidden', timeout: 5000 });
    await page.evaluate(() => {
      window.__repeats = 0;
      addEventListener('keydown', (e) => e.repeat && window.__repeats++);
    });
    await page.keyboard.down('=');
    for (let i = 0; i < 3; i++) await page.keyboard.down('=');
    await page.keyboard.up('=');
    // gstack-timing-ok: below, extra repeats would raise the count within a frame; the wait lets them render.
    assert.ok((await page.evaluate(() => window.__repeats)) >= 3, 'no auto-repeat keydowns were delivered');
    await page.waitForTimeout(100);
    await expectText(page, '#live-count', '1');
  });

  // Generated by /ship coverage audit (pass 1).
  // Value: protects=an Esc pressed right after ending a round early leaves the score reveal on screen; fails_when=the 1.5 s
  //   resultAt guard on Esc in the result view is removed; why_new=the pause check only waits 1.6 s and never presses the extra Esc;
  //   seam=none; no_claim=none beyond protects
  await check('a quick extra Esc after ending early cannot skip the score reveal', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-result');
    await page.keyboard.press('Escape');
    // gstack-timing-ok: a negative check (the extra Esc must NOT leave the result); wait a few frames, well under the 1.5 s guard.
    await page.waitForTimeout(300);
    await expectVisible(page, '#view-result');
    await expectText(page, '#res-count', '1');
  });

  // Generated by /ship coverage audit (pass 1).
  // Value: protects=+ on the result screen fixes the saved leaderboard entry and shows the Adjusted chip (DD12); fails_when=fixScore
  //   stops calling updateResult or the result-view +/- keys are unbound; why_new=fix-score is only unit-tested via R.adjust, never
  //   the saved entry; seam=none; no_claim=the Fix score dialog path (btn-fix) is not exercised
  await check('Fix score with + on the result screen updates the saved board entry', async () => {
    await page.keyboard.press('=');
    await page.keyboard.press('=');
    await expectText(page, '#res-count', '3');
    await expectVisible(page, '#res-adjusted');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ppc.results.v1')).filter((r) => r.name === 'Tara'));
    assert.deepEqual(saved.map((r) => r.score), [3]);
  });

  // Generated by /ship coverage audit (pass 1).
  // Value: protects=Re-run removes the score, and Esc during the new countdown puts the old score back (O17); fails_when=endPressed
  //   loses its undo.rerun branch or doUndo rejects the arming phase; why_new=only the Discard undo is covered by e2e; seam=none;
  //   no_claim=undo via the toast button click is not exercised (Esc path only)
  await check('Re-run then Esc during the countdown restores the old score', async () => {
    await page.click('#btn-rerun');
    await expectVisible(page, '#arming');
    // Read the board and press Esc right away: the re-run undo lasts only the 3 s countdown.
    const during = await page.evaluate(() => JSON.parse(localStorage.getItem('ppc.results.v1')).filter((r) => r.name === 'Tara').length);
    const toastText = await text('#toast-text');
    await page.keyboard.press('Escape');
    assert.equal(during, 0, 'score should be off the board during the re-run countdown');
    assert.match(toastText, /Tara's score removed for a re-run/);
    await expectVisible(page, '#view-result');
    await expectText(page, '#res-count', '3');
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('ppc.results.v1')).filter((r) => r.name === 'Tara').map((r) => r.score));
    assert.deepEqual(after, [3]);
    await page.keyboard.press('Enter');
    await expectVisible(page, '#view-idle');
  });

  // Value: protects=clicking the toast's Undo button after Discard restores the score; fails_when=the toast hides itself
  //   before running the action, so doUndo sees no offer; why_new=other checks undo with Cmd/Ctrl+Z only; seam=none;
  //   no_claim=none beyond protects
  await check('discard then clicking the Undo button restores the score', async () => {
    await page.fill('#name-input', 'Usha');
    await page.keyboard.press('Enter');
    await expectVisible(page, '#arming');
    await page.waitForSelector('#arming', { state: 'hidden', timeout: 5000 });
    await page.keyboard.press('=');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-result');
    await page.click('#btn-discard');
    await expectVisible(page, '#view-idle');
    await page.click('#toast-action');
    await expectVisible(page, '#view-result');
    await expectText(page, '#res-count', '1');
    await page.waitForTimeout(1600); // past the result-screen Esc guard; gstack-timing-ok: waits out a fixed product timer
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-idle');
  });

  // Value: protects=a round whose end passed while the page was closed (reload 30 s-5 min later) is saved, with a notice;
  //   fails_when=frame() swaps in IDLE before committing the finished round; why_new=store-load tests cover only saves
  //   older than 5 min; seam=none; no_claim=a real Chrome crash (simulated by seeding storage and reloading)
  await check('a round that ended while the page was closed is saved, not lost', async () => {
    const now = await page.evaluate(() => Date.now());
    await seed({ ...IDLE, phase: 'live', name: 'Late', count: 4, endsAt: now - 60000, savedAt: now - 65000 });
    await expectVisible(page, '#view-idle');
    // Saved on the first frame after boot.
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ppc.results.v1') || '[]').some((r) => r.name === 'Late'), null, { timeout: 5000 });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ppc.results.v1')).filter((r) => r.name === 'Late').map((r) => r.score));
    assert.deepEqual(saved, [4]);
    await expectText(page, '#notice', /Late's round ended while the screen was away: 4 puris saved/);
    await page.keyboard.press('Shift');
  });

  // Undo state-matrix cells found untested in the /ship review. Each starts and ends at sign-up.
  const board = (name) => page.evaluate((n) => JSON.parse(localStorage.getItem('ppc.results.v1') || '[]').filter((r) => r.name === n).map((r) => r.score), name);
  async function playRound(name, puris) {
    await expectVisible(page, '#view-idle');
    await page.fill('#name-input', name);
    await page.keyboard.press('Enter');
    await expectVisible(page, '#arming');
    await page.waitForSelector('#arming', { state: 'hidden', timeout: 5000 });
    for (let i = 0; i < puris; i++) await page.keyboard.press('=');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-result');
    await expectText(page, '#res-count', String(puris));
  }
  async function backToIdle() {
    await page.waitForTimeout(1600); // gstack-timing-ok: waits out the fixed 1.5 s result-screen Esc guard
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-idle');
  }

  // Value: protects=the toast's Undo button during a re-run countdown restores the old score; fails_when=doUndo rejects a
  //   button-driven re-run undo; why_new=re-run undo was checked only via Esc; seam=none; no_claim=none beyond protects
  await check('Re-run then the Undo button restores the old score', async () => {
    await playRound('Ira', 2);
    await page.click('#btn-rerun');
    await expectVisible(page, '#arming');
    await page.click('#toast-action');
    await expectVisible(page, '#view-result');
    assert.deepEqual(await board('Ira'), [2]);
    await backToIdle();
  });

  // Value: protects=Cmd/Ctrl+Z during a re-run countdown restores the old score; fails_when=the Ctrl+Z path or the arming
  //   check in doUndo breaks; why_new=Ctrl+Z was checked only after Discard; seam=none; no_claim=none beyond protects
  await check('Re-run then Cmd/Ctrl+Z restores the old score', async () => {
    await playRound('Jai', 3);
    await page.click('#btn-rerun');
    await expectVisible(page, '#arming');
    await page.keyboard.press('ControlOrMeta+z');
    await expectVisible(page, '#view-result');
    assert.deepEqual(await board('Jai'), [3]);
    await backToIdle();
  });

  // Value: protects=once the re-run countdown ends, undo is gone and the new round runs; fails_when=doUndo ignores the
  //   arming check and drops the live round; why_new=no check waited out the countdown; seam=none; no_claim=none beyond protects
  await check('after the re-run countdown, undo no longer restores the old score', async () => {
    await playRound('Kavi', 2);
    await page.click('#btn-rerun');
    await expectVisible(page, '#arming');
    await page.waitForSelector('#arming', { state: 'hidden', timeout: 5000 });
    await page.keyboard.press('ControlOrMeta+z');
    // gstack-timing-ok: a negative check (undo must NOT fire); give a wrongful restore a few frames to show.
    await page.waitForTimeout(200);
    await expectVisible(page, '#view-live');
    assert.deepEqual(await board('Kavi'), []);
    await page.keyboard.press('=');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-result');
    assert.deepEqual(await board('Kavi'), [1]);
    await backToIdle();
  });

  // Value: protects=Esc at sign-up does not cancel a pending Discard undo; fails_when=Esc handling clears the offer;
  //   why_new=no check mixed Esc with the undo window; seam=none; no_claim=none beyond protects
  await check('Discard, Esc at sign-up, then Cmd/Ctrl+Z still restores', async () => {
    await playRound('Lata', 1);
    await page.click('#btn-discard');
    await expectVisible(page, '#view-idle');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+z');
    await expectVisible(page, '#view-result');
    assert.deepEqual(await board('Lata'), [1]);
    await backToIdle();
  });

  // Value: protects=a Discard undo expires with its 5 s toast; fails_when=the UNDO_MS expiry check is dropped; why_new=no
  //   check waited past the window; seam=none; no_claim=none beyond protects
  await check('Discard undo expires after 5 s', async () => {
    await playRound('Mani', 1);
    await page.click('#btn-discard');
    await expectVisible(page, '#view-idle');
    await page.waitForTimeout(5300); // gstack-timing-ok: waits out the fixed 5 s undo window
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(200); // gstack-timing-ok: negative check, a wrongful restore gets a few frames
    await expectVisible(page, '#view-idle');
    assert.deepEqual(await board('Mani'), []);
  });

  // Value: protects=holding Space confirms one waiting bite, not one per auto-repeat (O3); fails_when=the e.repeat guard
  //   stops covering Space; why_new=the held-key check covers only +; seam=none; no_claim=physical repeat rate
  await check('a held Space confirms one waiting bite, not one per auto-repeat (O3)', async () => {
    const now = await page.evaluate(() => Date.now());
    const bite = (dt) => ({ at: now - dt, openedAt: now - dt - 300, peak: 0.6, confidence: 0.8, hand: false });
    await seed(
      { ...IDLE, phase: 'live', name: 'Hold', count: 0, endsAt: now + 50000, autoConfirmMs: 60000, queue: [bite(500), bite(300), bite(100)], dueAt: now + 59000, savedAt: now },
      { mode: 'hybrid', autoConfirmSeconds: 60 },
    );
    await page.keyboard.down(' ');
    for (let i = 0; i < 3; i++) await page.keyboard.down(' ');
    await page.keyboard.up(' ');
    await page.waitForTimeout(150); // gstack-timing-ok: extra repeats would confirm more bites within a frame
    await expectText(page, '#live-count', '1');
    await expectText(page, '#bite-more', '+1 more');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-result');
    await backToIdle();
  });

  // Value: protects=a second tab of the app shows "already open" and never boots; fails_when=the stall lock is removed or
  //   not checked; why_new=new behavior; seam=none; no_claim=two separate browser profiles (locks are per profile)
  await check('a second tab shows "already open", writes nothing and does not take over', async () => {
    const stored = () => page.evaluate(() => [localStorage.getItem('ppc.results.v1'), localStorage.getItem('ppc.round.v1')]);
    // A stale saved round with a score: a tab that ran recovery would save it and rewrite the round.
    await page.evaluate((idle) => localStorage.setItem('ppc.round.v1', JSON.stringify({ ...idle, phase: 'live', name: 'Ghost', count: 3, endsAt: Date.now() - 3600e3, savedAt: Date.now() - 3600e3 })), IDLE);
    const before = await stored();
    const second = await ctx.newPage();
    await second.addInitScript(() => {
      window.__swRegistered = 0;
      const sw = navigator.serviceWorker;
      if (sw) {
        const register = sw.register.bind(sw);
        sw.register = (...a) => (window.__swRegistered++, register(...a));
      }
    });
    await second.goto(URL);
    await second.waitForSelector('#other-tab', { state: 'visible', timeout: 5000 });
    // Keys, focus and an implicit form submit must all be dead under the overlay.
    await second.evaluate(() => document.getElementById('name-input').focus()); // inert: focus must not land
    await second.keyboard.type('Zed');
    await second.keyboard.press('Enter');
    assert.notEqual(await second.evaluate(() => document.activeElement?.id), 'name-input', 'focus landed under the overlay');
    assert.equal(await second.inputValue('#name-input'), '', 'typing reached the name field under the overlay');
    assert.equal(await second.evaluate(() => document.getElementById('other-tab').inert), false, 'the overlay itself is inert');
    await second.keyboard.press('Escape');
    await second.keyboard.press('s');
    assert.ok(await second.isHidden('#view-setup'), 'the second tab reacted to a key');
    assert.equal(await second.evaluate(() => window.__swRegistered), 0, 'the second tab registered the service worker');
    assert.deepEqual(await stored(), before, 'the second tab wrote to storage');
    await second.reload();
    await second.waitForSelector('#other-tab', { state: 'visible', timeout: 5000 });
    await second.close();
    await page.evaluate(() => localStorage.setItem('ppc.round.v1', JSON.stringify({ phase: 'idle' })));
    await page.bringToFront();
  });

  // Value: protects=when the stall tab closes, the waiting tab takes over and resumes the saved round; fails_when=the
  //   later lock grant never boots, or boots with the stale in-memory board; why_new=the two-tab check closes the waiting
  //   tab, never the owner; seam=none; no_claim=a real browser crash of the owner
  await check('closing the stall tab hands over to the waiting tab with the round intact', async () => {
    const other = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions: ['camera'] });
    try {
      const owner = await other.newPage();
      await owner.goto(URL);
      await owner.waitForSelector('#view-idle:not([hidden])');
      const waiting = await other.newPage();
      await waiting.goto(URL);
      await waiting.waitForSelector('#other-tab', { state: 'visible', timeout: 5000 });
      await owner.evaluate((idle) => localStorage.setItem('ppc.round.v1', JSON.stringify({ ...idle, phase: 'live', name: 'Hand', count: 3, endsAt: Date.now() + 40000, savedAt: Date.now() })), IDLE);
      await owner.close();
      await waiting.bringToFront();
      await waiting.waitForSelector('#view-live:not([hidden])', { timeout: 10000 });
      await expectText(waiting, '#live-count', '3');
      assert.ok(await waiting.isHidden('#other-tab'), 'the overlay stayed up after takeover');
    } finally {
      await other.close();
      await page.bringToFront();
    }
  });

  // Value: protects=a plain toast (camera back, board empty) never replaces a live Undo; it shows after the undo;
  //   fails_when=toast() lets a plain message wipe the action toast, so the advertised undo silently fails;
  //   why_new=no check raised a second toast during a Discard undo; seam=none (the board-empty toast is real UI);
  //   no_claim=camera toasts (same toast() path, not driven here)
  await check('a later toast does not cancel a Discard undo', async () => {
    await page.evaluate(() => localStorage.setItem('ppc.results.v1', '[]'));
    await page.reload();
    await booted(page);
    await expectVisible(page, '#view-idle');
    await playRound('Nila', 1);
    await page.click('#btn-discard'); // the board is empty again
    const discardedAt = Date.now();
    await expectVisible(page, '#view-idle');
    await page.keyboard.press('Escape');
    await page.keyboard.press('s');
    await expectVisible(page, '#view-setup');
    await page.click('#btn-clear');
    await expectText(page, '#toast-text', "Nila's score removed"); // still the Undo toast
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-idle');
    assert.ok(Date.now() - discardedAt < 4500, 'too slow: the undo window would close on its own');
    await page.keyboard.press('ControlOrMeta+z');
    await expectVisible(page, '#view-result');
    assert.deepEqual(await board('Nila'), [1]);
    await expectText(page, '#toast-text', "Nila's score restored");
    // The queued "Board is already empty" described the state the undo reversed: it must not follow.
    await page.waitForSelector('#toast', { state: 'hidden', timeout: 5000 });
    await page.waitForTimeout(500); // gstack-timing-ok: negative check, a wrongful follow-up toast gets time to show
    assert.ok(await page.isHidden('#toast'), 'a stale queued toast followed the undo');
    await backToIdle();
  });

  // Value: protects=starting the next round drops a toast still queued behind a Discard undo (it is stale by then), and
  //   − at 0 on the result screen changes nothing (no "Adjusted" chip); fails_when=hideToast flushes the queue again, or
  //   fixScore marks a no-op as adjusted; why_new=neither path was driven; seam=none; no_claim=camera toasts
  await check('a new round drops a stale queued toast; − at 0 is not an adjustment', async () => {
    await playRound('Zero', 0);
    await page.keyboard.press('-');
    await page.waitForTimeout(200); // gstack-timing-ok: negative check, a wrongful chip gets a few frames
    assert.ok(await page.isHidden('#res-adjusted'), '"Adjusted by referee" shown for an unchanged score');
    await backToIdle(); // a reload from the result screen would restore the result
    await page.evaluate(() => localStorage.setItem('ppc.results.v1', '[]'));
    await page.reload();
    await booted(page);
    await expectVisible(page, '#view-idle');
    await playRound('Olu', 1);
    await page.click('#btn-discard'); // board empty again
    await expectVisible(page, '#view-idle');
    await page.keyboard.press('Escape');
    await page.keyboard.press('s');
    await expectVisible(page, '#view-setup');
    await page.click('#btn-clear'); // "Board is already empty" queues behind the Undo
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-idle');
    await page.fill('#name-input', 'Next');
    await page.keyboard.press('Enter');
    await expectVisible(page, '#arming');
    await page.waitForTimeout(2600); // gstack-timing-ok: longer than a plain toast lasts; nothing may show
    assert.ok(await page.isHidden('#toast'), 'a stale queued toast appeared over the countdown');
    await page.keyboard.press('Escape'); // cancel the countdown
    await expectVisible(page, '#view-idle');
    await page.fill('#name-input', '');
  });

  await check('a Re-run undo survives a later toast during the countdown', async () => {
    await playRound('Om', 2);
    await page.click('#btn-rerun');
    await expectVisible(page, '#arming');
    await page.evaluate(() => document.getElementById('idle-setup').click());
    await expectText(page, '#toast-text', /score removed for a re-run/); // the Setup message waits behind the Undo
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-result');
    assert.deepEqual(await board('Om'), [2]);
    await backToIdle();
  });

  // Generated by /ship coverage audit (pass 1).
  // Value: protects=the Fix score dialog's Save updates the result screen, pill, chip and board, and Remove entry returns to
  //   sign-up (syncResultToBoard); fails_when=the dialog's onDone stops re-syncing the shown result or the deleted-entry path
  //   stops going idle; why_new=e2e fixes scores only with +/- keys and only "New #1" pill is asserted; seam=none;
  //   no_claim=Setup › Edit a score (same onBoardChanged callback, not driven here); the 60 s dialog idle close
  await check('Fix score dialog: Save resyncs the result and pill, Remove entry goes back to sign-up', async () => {
    const tens = Array.from({ length: 10 }, (_, i) => ({ id: `seed-${i}`, name: `Seed${i}`, score: 5, rejected: 0, notCounted: 0, seconds: 60, at: 1000 + i }));
    await page.evaluate((list) => localStorage.setItem('ppc.results.v1', JSON.stringify(list)), tens);
    await page.reload();
    await booted(page);
    await playRound('Pia', 2);
    await expectText(page, '#res-rank', '4 more would have made the board');
    await page.click('#btn-fix');
    await expectVisible(page, '#score-dialog');
    await page.fill('#score-value', '7');
    await page.click('#score-save');
    await expectText(page, '#res-count', '7');
    await expectText(page, '#res-rank', 'New #1 on the board!');
    await expectVisible(page, '#res-adjusted');
    assert.deepEqual(await board('Pia'), [7]);
    await page.click('#btn-fix');
    await expectVisible(page, '#score-dialog');
    page.once('dialog', (d) => d.accept());
    await page.click('#score-delete');
    await expectVisible(page, '#view-idle');
    assert.deepEqual(await board('Pia'), []);
    await page.evaluate(() => localStorage.setItem('ppc.results.v1', '[]'));
    await page.reload();
    await booted(page);
    await expectVisible(page, '#view-idle');
  });

  // Value: protects=Setup › Edit a score, opened from the result screen, keeps the shown result, pill and chip in step
  //   with the board; fails_when=onBoardChanged goes back to only re-rendering the boards; why_new=the Fix score check
  //   covers the dialog's own button path only; seam=none; no_claim=Clear board from the result screen
  await check('Setup › Edit a score from the result screen resyncs the shown result', async () => {
    await playRound('Ravi', 2);
    await page.keyboard.press('s'); // Setup opens from the result screen
    await expectVisible(page, '#view-setup');
    await page.click('#btn-edit');
    await expectVisible(page, '#score-dialog');
    const id = await page.evaluate(() => JSON.parse(localStorage.getItem('ppc.results.v1')).find((r) => r.name === 'Ravi').id);
    await page.selectOption('#score-pick', id);
    await page.fill('#score-value', '6');
    await page.click('#score-save');
    await page.keyboard.press('Escape'); // back from Setup to the result
    await expectVisible(page, '#view-result');
    await expectText(page, '#res-count', '6');
    await expectVisible(page, '#res-adjusted');
    assert.deepEqual(await board('Ravi'), [6]);
    await backToIdle();
  });

  // Value: protects=typing a corrected score and pressing Enter in the Edit a score dialog saves it; fails_when=the
  //   dialog's default (first) submit button is Cancel, so Enter discards the correction; why_new=the other dialog checks
  //   click Save; seam=none; no_claim=none beyond protects
  await check('Enter in the score dialog saves the corrected score', async () => {
    await playRound('Enter', 2);
    await page.click('#btn-fix');
    await expectVisible(page, '#score-dialog');
    await page.fill('#score-value', '5');
    await page.press('#score-value', 'Enter');
    await expectVisible(page, '#score-dialog', false);
    await expectText(page, '#res-count', '5');
    assert.deepEqual(await board('Enter'), [5]);
    await backToIdle();
  });

  // Value: protects=a cleared score field cannot overwrite a saved score with 0 (Enter is blocked, Esc keeps the score);
  //   fails_when=the score input is not required or onclose saves an empty value as 0; why_new=Enter-to-save made a
  //   stray Backspace+Enter a one-keystroke wipe; seam=none; no_claim=none beyond protects
  await check('an empty score field never saves the score as 0', async () => {
    await playRound('Empty', 3);
    await page.click('#btn-fix');
    await expectVisible(page, '#score-dialog');
    await page.fill('#score-value', '');
    await page.press('#score-value', 'Enter');
    await expectVisible(page, '#score-dialog');
    await page.keyboard.press('Escape');
    await expectVisible(page, '#score-dialog', false);
    await expectText(page, '#res-count', '3');
    assert.deepEqual(await board('Empty'), [3]);
    await backToIdle();
  });

  const denied = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const p2 = await denied.newPage();
  await check('camera blocked: camera-off card, + becomes primary, named cause', async () => {
    await p2.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await p2.bringToFront(); // background pages get throttled animation frames
    await p2.goto(URL);
    await booted(p2);
    await p2.fill('#name-input', 'Meera');
    await p2.keyboard.press('Enter');
    await expectVisible(p2, '#arming');
    await p2.waitForSelector('#arming', { state: 'hidden', timeout: 10000 });
    await expectVisible(p2, '#off-card');
    await p2.waitForSelector("#live-strip[data-primary='plus']", { timeout: 4000 });
    await expectText(p2, '#live-last', 'Camera off: press + for each puri');
    await p2.keyboard.press('Escape');
    await p2.keyboard.press('Escape');
    await p2.keyboard.press('Enter');
    await p2.waitForSelector('#view-idle:not([hidden])');
    await p2.keyboard.press('Escape');
    await p2.keyboard.press('s');
    await expectText(p2, '#set-status', 'Camera blocked (allow in Chrome)');
  });
  await denied.close();


  // Value: protects=on a slow network the service worker serves the cached page after ~3 s; fails_when=the navigation
  //   timeout is removed or never falls back; why_new=the offline check only covers an instant network failure;
  //   seam=none (a delaying proxy in front of the preview server); no_claim=captive-portal HTML responses
  await check('slow network: the cached page appears after the 3 s timeout', async () => {
    let delayMs = 0;
    let mode = 'pass'; // 'pass' | 'slow-marked' | 'error'
    const proxy = http.createServer((req, res) => {
      const isPage = req.url === '/' || req.url === '/index.html';
      if (isPage && mode === 'error') {
        res.writeHead(503, { 'content-type': 'text/html' });
        return res.end('<h1>Service Unavailable</h1>');
      }
      if (isPage && mode === 'slow-marked') {
        // A late page from a "newer deploy": must never become the offline shell.
        return setTimeout(() => {
          http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (r) => {
            let body = '';
            r.on('data', (c) => (body += c));
            r.on('end', () => {
              res.writeHead(200, { 'content-type': 'text/html' });
              res.end(body.replace('</body>', '<!-- LATE-DEPLOY --></body>'));
            });
          });
        }, delayMs);
      }
      const forward = () => {
        const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        });
        up.on('error', () => res.destroy());
        req.pipe(up);
      };
      forward();
    });
    await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
    const slowCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const sp = await slowCtx.newPage();
    try {
      const origin = `http://127.0.0.1:${PROXY_PORT}/`;
      await sp.goto(origin);
      await sp.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 });
      await sp.waitForFunction(async () => (await caches.keys()).some((k) => /^ppc-[0-9a-f]+$/.test(k)), null, { timeout: 30000 });
      mode = 'slow-marked';
      delayMs = 5000;
      const t0 = Date.now();
      await sp.reload({ waitUntil: 'domcontentloaded', timeout: 12000 });
      await sp.waitForSelector('#view-idle:not([hidden])', { timeout: 12000 });
      const took = Date.now() - t0;
      assert.ok(took >= 2500 && took < 8000, `page took ${took} ms (expected the ~3 s cache fallback)`);
      await sp.waitForTimeout(3500); // gstack-timing-ok: lets the late 5 s page land, then checks it was not cached
      assert.ok(await sp.isHidden('#other-tab'), 'a reload showed the "already open" screen');
      const shell = await sp.evaluate(async () => (await (await caches.match('./')).text()));
      assert.ok(!shell.includes('LATE-DEPLOY'), 'a late page replaced the offline shell');
      // An error page from the server (mid-deploy 5xx) falls back to the cached app, fast.
      mode = 'error';
      const t1 = Date.now();
      await sp.reload({ waitUntil: 'domcontentloaded', timeout: 12000 });
      await sp.waitForSelector('#view-idle:not([hidden])', { timeout: 12000 });
      assert.ok(Date.now() - t1 < 2500, 'the error page was not replaced by the cached app quickly');
    } finally {
      await slowCtx.close();
      await new Promise((r) => proxy.close(r));
    }
  });

  await page.bringToFront();
  // Start the offline check from a known idle state, whatever earlier checks left behind.
  await page.evaluate(() => localStorage.setItem('ppc.round.v1', JSON.stringify({ phase: 'idle' })));
  await check('offline: page, fonts and models load with the server stopped', async () => {
    await page.reload();
    await booted(page);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 });
    // The model files are large; wait until the install finished precaching them.
    await page.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith('ppc-models-')) && (await navigator.serviceWorker.ready).active?.state === 'activated', null, { timeout: 60000 });
    server.kill();
    await waitFor(async () => !(await fetch(URL).catch(() => null)), 'server to stop');
    await page.reload();
    await booted(page);
    await page.waitForSelector('#view-idle:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#view-idle [data-cam-text]')?.textContent !== 'Loading face model…' && document.querySelector('#view-idle [data-cam-text]')?.textContent !== 'Starting camera…', null, { timeout: 30000 });
    const status = await text('#view-idle [data-cam-text]');
    assert.notEqual(status, 'Camera off', `vision failed offline: ${status}`);
    assert.ok(await page.evaluate(() => document.fonts.check('48px "Titan One"')), 'Titan One not loaded');
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));

} finally {
  await browser.close();
  server?.kill();
}

for (const [status, name, why] of results) console.log(`${status.padEnd(4)} ${name}${why ? `\n     ${why}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
