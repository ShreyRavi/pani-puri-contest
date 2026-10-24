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
    await page.waitForSelector('#view-live:not([hidden]), #view-idle:not([hidden]), #view-result:not([hidden])');
  };

  const first = await page.goto(URL);
  await page.waitForSelector('#view-idle:not([hidden])');
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
    await second.keyboard.press('Escape');
    await second.keyboard.press('s');
    assert.ok(await second.isHidden('#view-setup'), 'the second tab reacted to a key');
    assert.equal(await second.evaluate(() => window.__swRegistered), 0, 'the second tab registered the service worker');
    assert.deepEqual(await stored(), before, 'the second tab wrote to storage');
    await second.reload();
    await second.waitForSelector('#other-tab', { state: 'visible', timeout: 5000 });
    await second.close();
    await page.bringToFront();
  });

  // Value: protects=a later toast replacing the Undo button ends a Discard undo; fails_when=doUndo stops checking that its
  //   toast is still up; why_new=undo checks never replaced the toast; seam=none (the board-empty toast is real UI);
  //   no_claim=camera toasts (same code path, not driven here)
  await check('a later toast ends a Discard undo', async () => {
    await page.evaluate(() => localStorage.setItem('ppc.results.v1', '[]'));
    await page.reload();
    await expectVisible(page, '#view-idle');
    await playRound('Nila', 1);
    await page.click('#btn-discard'); // the board is empty again
    await expectVisible(page, '#view-idle');
    await page.keyboard.press('Escape');
    await page.keyboard.press('s');
    await expectVisible(page, '#view-setup');
    await page.click('#btn-clear');
    await expectText(page, '#toast-text', 'Board is already empty');
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-idle');
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(200); // gstack-timing-ok: negative check, a wrongful restore gets a few frames
    await expectVisible(page, '#view-idle');
    assert.deepEqual(await board('Nila'), []);
  });

  // Value: protects=a Re-run undo survives a later toast for the whole countdown; fails_when=the toast-showing check is
  //   applied to re-run undos too; why_new=re-run undo checks never replaced the toast; seam=none (clicks the existing
  //   Setup control, hidden during the round, which answers with a real toast); no_claim=camera toasts
  await check('a Re-run undo survives a later toast during the countdown', async () => {
    await playRound('Om', 2);
    await page.click('#btn-rerun');
    await expectVisible(page, '#arming');
    await page.evaluate(() => document.getElementById('idle-setup').click());
    await expectText(page, '#toast-text', 'Setup opens after this round');
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-result');
    assert.deepEqual(await board('Om'), [2]);
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
    const proxy = http.createServer((req, res) => {
      const forward = () => {
        const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        });
        up.on('error', () => res.destroy());
        req.pipe(up);
      };
      const isPage = req.url === '/' || req.url === '/index.html';
      if (isPage && delayMs) setTimeout(forward, delayMs);
      else forward();
    });
    await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
    const slowCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const sp = await slowCtx.newPage();
    try {
      const origin = `http://127.0.0.1:${PROXY_PORT}/`;
      await sp.goto(origin);
      await sp.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 });
      await sp.waitForFunction(async () => (await caches.keys()).some((k) => /^ppc-[0-9a-f]+$/.test(k)), null, { timeout: 30000 });
      delayMs = 15000;
      const t0 = Date.now();
      await sp.reload({ waitUntil: 'domcontentloaded', timeout: 12000 });
      await sp.waitForSelector('#view-idle:not([hidden]), #other-tab:not([hidden])', { timeout: 12000 });
      const took = Date.now() - t0;
      assert.ok(took >= 2500 && took < 8000, `page took ${took} ms (expected the ~3 s cache fallback)`);
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
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 });
    // The model files are large; wait until the install finished precaching them.
    await page.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith('ppc-models-')) && (await navigator.serviceWorker.ready).active?.state === 'activated', null, { timeout: 60000 });
    server.kill();
    await waitFor(async () => !(await fetch(URL).catch(() => null)), 'server to stop');
    await page.reload();
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
