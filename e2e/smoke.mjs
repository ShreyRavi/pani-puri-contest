// End-to-end smoke test in real Chrome with a fake camera (no face, so bites are seeded).
// Usage: npm run e2e   (builds, serves dist on :4174, runs, then tests offline with the server stopped)
// Needs Google Chrome installed; set CHROME_PATH to use another Chromium.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const PORT = 4174;
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
  const text = (s) => page.textContent(s);
  const seed = async (round, settings) => {
    await page.evaluate(([r, s]) => {
      localStorage.setItem('ppc.round.v1', JSON.stringify(r));
      if (s) localStorage.setItem('ppc.settings.v1', JSON.stringify(s));
    }, [round, settings]);
    await page.reload();
    await page.waitForSelector('#view-live:not([hidden]), #view-idle:not([hidden]), #view-result:not([hidden])');
  };

  await page.goto(URL);
  await page.waitForSelector('#view-idle:not([hidden])');

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
    await page.waitForTimeout(200);
    await expectVisible(page, '#arming');
    await expectText(page, '#arming-name', 'Kiran');
    await page.keyboard.press('Escape');
    await expectVisible(page, '#view-idle');
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


  await page.bringToFront();
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
