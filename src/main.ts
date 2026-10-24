import '@fontsource/titan-one/latin-400.css';
import '@fontsource/rubik/latin-400.css';
import '@fontsource/rubik/latin-500.css';
import '@fontsource/rubik/latin-700.css';
import '@fontsource/rubik/latin-900.css';
import './styles.css';

import { beep, buzzer, ding, unlockAudio } from './audio';
import { BiteDetector, median } from './detector';
import * as R from './round';
import { addResult, allResults, getRound, rankOf, removeResult, setRound, settings, updateResult, type Settings } from './store';
import { chaseLine, renderBoard } from './ui/board';
import { $, clock, show, text, toast } from './ui/dom';
import { CameraStage } from './ui/overlay';
import { initSetup, openScoreDialog } from './ui/setup';
import { Vision } from './vision/client';
import type { VisionResult } from './vision/protocol';

const FACE_LOST_MS = 3000;
const ESC_CONFIRM_MS = 2000;

// ---------- stage scaling ----------
function fitStage(): void {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  document.documentElement.style.setProperty('--scale', String(s));
}
addEventListener('resize', fitStage);
fitStage();

// ---------- vision + detection ----------
const vision = new Vision();
const detector = new BiteDetector();
const stage = new CameraStage(vision.video);
let latest: VisionResult | null = null;
let lastFaceAt = 0;
let lastHandAt = 0;
let baselineSamples: number[] = [];

function detectorFromSettings(): void {
  detector.setConfig({
    open: settings.open,
    close: settings.close,
    cooldownMs: settings.cooldownSeconds * 1000,
    requireHand: settings.requireHand,
  });
  vision.hands = settings.requireHand;
}
detectorFromSettings();

const setup = initSetup({
  vision,
  detector,
  applySettings(prev: Settings) {
    detectorFromSettings();
    if (prev.cameraId !== settings.cameraId) void vision.start(settings.cameraId);
    text($('idle-seconds'), `${settings.roundSeconds} seconds`);
  },
  onBoardChanged: renderBoards,
});

vision.onStatus = () => {
  if (vision.status.state === 'ready') void setup.listCameras();
};

vision.on((r) => {
  latest = r;
  const now = performance.now();
  if (r.faceFound) lastFaceAt = now;
  if (r.handNear) lastHandAt = now;

  let round = getRound();
  if (round.phase === 'arming' && r.ratio != null) baselineSamples.push(r.ratio);

  const ev = detector.push({ t: r.t, ratio: r.ratio, handNear: r.handNear });
  if (!ev) return;
  setup.logEvent(ev, now - r.t);
  if (ev.kind !== 'candidate' || round.phase !== 'live') return;
  round = R.candidate(round, { at: Date.now(), peak: ev.peak, confidence: ev.confidence, hand: ev.hand }, settings.mode, Date.now());
  commit(round);
});

// ---------- views ----------
type View = 'idle' | 'live' | 'result' | 'setup';
const views: Record<View, HTMLElement> = {
  idle: $('view-idle'),
  live: $('view-live'),
  result: $('view-result'),
  setup: $('view-setup'),
};
let setupOpen = false;
let currentView: View | null = null;

function viewFor(round: R.RoundState): View {
  if (setupOpen) return 'setup';
  if (round.phase === 'idle') return 'idle';
  if (round.phase === 'result') return 'result';
  return 'live';
}

function showView(v: View): void {
  if (v === currentView) return;
  currentView = v;
  for (const [k, el] of Object.entries(views)) show(el, k === v);
  stage.mount(views[v].querySelector('[data-cam-slot]'));
  if (v === 'idle') {
    renderBoards();
    const input = $<HTMLInputElement>('name-input');
    input.value = '';
    input.focus();
  }
  if (v === 'result') renderBoards();
  if (v === 'setup') {
    setup.fill();
    $<HTMLButtonElement>('btn-back').focus();
  }
}

function renderBoards(): void {
  const results = allResults();
  renderBoard($<HTMLOListElement>('idle-board'), results);
  renderBoard($<HTMLOListElement>('res-board'), results, getRound().resultId);
}

// ---------- round actions ----------
let prev = getRound();

/** Persist a new round state and react to what changed (sounds, saving the result). */
function commit(next: R.RoundState): void {
  const before = prev;
  if (next.phase === 'result' && !next.resultId) {
    const saved = addResult({
      name: next.name,
      score: next.count,
      rejected: next.rejected,
      seconds: Math.round(next.durationMs / 1000),
      at: Date.now(),
    });
    next = { ...next, resultId: saved.id };
  }
  setRound(next);
  prev = next;

  const inPlay = (p: R.Phase) => p === 'live' || p === 'buzzer' || p === 'paused';
  if (next.count > before.count && (inPlay(next.phase) || next.phase === 'result') && before.phase !== 'idle') {
    ding(settings.sound);
    const el = $('live-count');
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }
  if (before.phase === 'arming' && next.phase === 'live') {
    detector.reset();
    detector.setBaseline(median(baselineSamples));
    setup.drawThresholds();
    beep(settings.sound, true);
  }
  if (inPlay(before.phase) && !inPlay(next.phase)) {
    buzzer(settings.sound);
  }
  if (next.phase === 'idle' && before.phase !== 'idle') {
    detector.setBaseline(null);
    setup.drawThresholds();
  }
}

function startRound(): void {
  const input = $<HTMLInputElement>('name-input');
  const name = input.value.trim();
  if (!name) {
    input.classList.remove('shake');
    void input.offsetWidth;
    input.classList.add('shake');
    input.focus();
    return;
  }
  unlockAudio();
  enterFullscreen();
  baselineSamples = [];
  input.blur();
  commit(R.start(name, settings.roundSeconds * 1000, Date.now()));
}

function rerun(): void {
  const r = getRound();
  if (r.resultId) removeResult(r.resultId);
  baselineSamples = [];
  commit(R.start(r.name, settings.roundSeconds * 1000, Date.now()));
}

function discard(): void {
  const r = getRound();
  if (r.resultId) removeResult(r.resultId);
  toast(`Discarded ${r.name}'s round`);
  commit(R.IDLE);
}

function next(): void {
  commit(R.IDLE);
}

/** +/- on the result screen fixes the saved score. */
function fixScore(delta: number): void {
  const r = getRound();
  if (!r.resultId) return;
  const fixed = { ...R.adjust(r, delta, Date.now()), resultAt: Date.now() };
  updateResult(r.resultId, { score: fixed.count });
  commit(fixed);
  renderBoards();
}

let escArmedUntil = 0;
function endPressed(): void {
  const r = getRound();
  const now = Date.now();
  if (r.phase === 'arming' || now < escArmedUntil) {
    escArmedUntil = 0;
    commit(R.end(r, now));
  } else {
    escArmedUntil = now + ESC_CONFIRM_MS;
  }
}

function enterFullscreen(): void {
  if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else enterFullscreen();
}

function openSetup(): void {
  if (R.isInRound(getRound())) return;
  setupOpen = true;
}

function closeSetup(): void {
  setupOpen = false;
}

// ---------- buttons ----------
$<HTMLFormElement>('signup').addEventListener('submit', (e) => {
  e.preventDefault();
  startRound();
});
$('idle-setup').addEventListener('click', openSetup);
$('btn-confirm').addEventListener('click', () => commit(R.confirm(getRound(), Date.now())));
$('btn-reject').addEventListener('click', () => commit(R.reject(getRound())));
$('btn-plus').addEventListener('click', () => commit(R.adjust(getRound(), 1, Date.now())));
$('btn-minus').addEventListener('click', () => commit(R.adjust(getRound(), -1, Date.now())));
$('btn-pause').addEventListener('click', () => commit(R.togglePause(getRound(), Date.now())));
$('btn-end').addEventListener('click', endPressed);
$('btn-next').addEventListener('click', next);
$('btn-rerun').addEventListener('click', rerun);
$('btn-discard').addEventListener('click', discard);
$('btn-fix').addEventListener('click', () => {
  const r = getRound();
  if (!r.resultId) return;
  openScoreDialog(r.resultId, () => {
    const saved = allResults().find((x) => x.id === r.resultId);
    if (!saved) return commit(R.IDLE);
    commit({ ...getRound(), count: saved.score, resultAt: Date.now() });
    renderBoards();
  });
});
$('btn-back').addEventListener('click', closeSetup);
$('btn-save').addEventListener('click', () => {
  toast('Settings saved');
  closeSetup();
});

// ---------- hotkeys ----------
function onKey(e: KeyboardEvent): void {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ($<HTMLDialogElement>('score-dialog').open) return;
  const target = e.target as HTMLElement;
  const typing = target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'number');
  const k = e.key;
  const r = getRound();
  const view = viewFor(r);

  if (k === 'f' || k === 'F') {
    if (!typing) {
      e.preventDefault();
      toggleFullscreen();
    }
    return;
  }

  if (view === 'idle') {
    if (k === 'Escape' && target.id === 'name-input') return void target.blur();
    if (!typing && (k === 's' || k === 'S')) {
      e.preventDefault();
      return openSetup();
    }
    if (!typing && k === 'Enter') {
      e.preventDefault();
      return void $<HTMLInputElement>('name-input').focus();
    }
    return; // Enter in the name field submits the form
  }

  if (view === 'setup') {
    if (k === 'Escape') {
      e.preventDefault();
      closeSetup();
    }
    return;
  }

  if (view === 'live') {
    unlockAudio();
    const now = Date.now();
    switch (k) {
      case ' ':
        e.preventDefault();
        return commit(R.confirm(r, now));
      case 'x':
      case 'X':
        return commit(R.reject(r));
      case '+':
      case '=':
        e.preventDefault();
        return commit(R.adjust(r, 1, now));
      case '-':
      case '_':
        e.preventDefault();
        return commit(R.adjust(r, -1, now));
      case 'p':
      case 'P':
        return commit(R.togglePause(r, now));
      case 'Escape':
        e.preventDefault();
        return endPressed();
    }
    return;
  }

  if (view === 'result') {
    switch (k) {
      case 'Enter':
        if (target instanceof HTMLButtonElement && target.id !== 'btn-next') return; // let focused buttons act
        e.preventDefault();
        return next();
      case 'Escape':
        e.preventDefault();
        return next();
      case '+':
      case '=':
        return fixScore(1);
      case '-':
      case '_':
        return fixScore(-1);
      case 's':
      case 'S':
        return openSetup();
    }
  }
}
addEventListener('keydown', onKey);
// Space must never also click whatever button the trackpad last focused.
addEventListener('keyup', (e: KeyboardEvent) => {
  if (e.key === ' ' && viewFor(getRound()) === 'live') e.preventDefault();
});

// ---------- render loop ----------
let lastArmDigit = 0;

function frame(): void {
  requestAnimationFrame(frame);
  const now = Date.now();
  let r = R.tick(getRound(), now, settings.mode === 'hybrid' ? settings.autoConfirmSeconds * 1000 : 0);
  if (R.shouldReturnToIdle(r, now) && !$<HTMLDialogElement>('score-dialog').open) r = R.IDLE;
  if (r !== getRound()) commit(r);

  const view = viewFor(r);
  showView(view);
  stage.draw(latest);
  renderCamStatus(view);

  if (view === 'live') renderLive(r, now);
  else if (view === 'result') renderResult(r, now);
  else if (view === 'setup') setup.update(latest);
}

function renderCamStatus(view: View): void {
  const root = views[view];
  const dot = root.querySelector<HTMLElement>('[data-cam-dot]');
  const label = root.querySelector<HTMLElement>('[data-cam-text]');
  if (!dot || !label) return;
  const t = performance.now();
  let cls = 'warn';
  let msg = 'Starting camera…';
  if (vision.status.state === 'error') {
    cls = 'bad';
    msg = 'Camera off · referee counting';
  } else if (vision.status.state === 'ready') {
    const face = t - lastFaceAt < 500;
    if (vision.tooDark()) {
      cls = 'bad';
      msg = 'Too dark · need more light';
    } else if (!face) {
      msg = 'Looking for a face…';
    } else if (view === 'idle') {
      cls = 'ok';
      msg = 'Camera ready · face found';
    } else {
      cls = 'ok';
      msg = settings.requireHand && t - lastHandAt < 600 ? 'Tracking mouth · hand near mouth' : 'Tracking mouth';
    }
  }
  dot.className = `dot ${cls}`;
  text(label, msg);
}

function renderLive(r: R.RoundState, now: number): void {
  // Countdown overlay
  const digit = R.armingCount(r, now);
  show($('arming'), r.phase === 'arming');
  if (r.phase === 'arming') {
    text($('arming-name'), r.name);
    const d = $('arming-digit');
    text(d, String(Math.max(1, digit)));
    if (digit !== lastArmDigit && digit > 0) {
      beep(settings.sound);
      d.classList.remove('tick');
      void d.offsetWidth;
      d.classList.add('tick');
    }
  }
  lastArmDigit = digit;

  text($('live-name'), r.name);
  const left = R.remaining(r, now);
  const timer = $('live-timer');
  text(timer, clock(left));
  timer.classList.toggle('low', r.phase === 'live' && left <= 10000);
  const total = r.durationMs || 1;
  $('live-progress-fill').style.transform = `scaleX(${left / total})`;
  const prog = $('live-progress');
  prog.setAttribute('aria-valuemax', String(Math.round(total / 1000)));
  prog.setAttribute('aria-valuenow', String(Math.ceil(left / 1000)));

  const chip = $('live-chip-text');
  text(chip, r.phase === 'paused' ? 'Paused' : r.phase === 'buzzer' ? 'Time!' : 'Live');
  chip.parentElement!.classList.toggle('paused', r.phase === 'paused');

  text($('live-count'), String(r.count));
  text($('live-chase-text'), chaseLine(allResults(), r.count));

  const banner = $('bite-banner');
  show(banner, !!r.pending);
  if (r.pending) {
    text($('bite-title'), r.phase === 'buzzer' ? 'Last bite?' : 'Bite spotted!');
    text($('bite-conf'), `confidence ${r.pending.confidence.toFixed(2)}`);
  }
  const faceGone = vision.status.state === 'ready' && performance.now() - lastFaceAt > FACE_LOST_MS;
  show($('stepback'), r.phase === 'live' && faceGone);

  $<HTMLButtonElement>('btn-confirm').disabled = !r.pending;
  $<HTMLButtonElement>('btn-reject').disabled = !r.pending;
  text($('btn-pause'), r.phase === 'paused' ? 'Resume (P)' : 'Pause (P)');
  const armed = now < escArmedUntil;
  const end = $('btn-end');
  text(end, armed ? 'Press Esc again to end' : 'End round (Esc)');
  end.classList.toggle('armed', armed);

  const mode =
    settings.mode === 'manual'
      ? 'manual counting'
      : settings.mode === 'auto'
        ? 'auto counting'
        : settings.autoConfirmSeconds > 0
          ? `auto-confirm after ${settings.autoConfirmSeconds}s`
          : 'auto-confirm off';
  const last = !r.last
    ? 'No puris yet'
    : r.last.count === r.count
      ? `Last: puri ${r.last.count} confirmed at ${clock(r.last.remaining)}`
      : `Count adjusted to ${r.count}`;
  text($('live-last'), `${last} · ${mode}`);
}

function renderResult(r: R.RoundState, now: number): void {
  text($('res-name'), r.name);
  text($('res-count'), String(r.count));
  text($('res-unit'), r.count === 1 ? 'puri' : 'puris');
  const rank = r.resultId ? rankOf(r.resultId) : 0;
  text($('res-rank'), rank === 1 ? 'New #1 on the board!' : rank > 0 && rank <= 10 ? `New #${rank} on the board` : `#${rank} tonight`);
  const secs = Math.round(r.durationMs / 1000);
  const rej = r.rejected ? ` · ${r.rejected} bite${r.rejected === 1 ? '' : 's'} rejected by the referee` : '';
  text($('res-sub'), `In ${secs} seconds${rej}`);
  const back = Math.max(0, Math.ceil((R.RESULT_IDLE_MS - (now - r.resultAt)) / 1000));
  text($('res-countdown'), `Back to sign-up in ${back}s`);
}

// ---------- boot ----------
text($('idle-seconds'), `${settings.roundSeconds} seconds`);
renderBoards();
requestAnimationFrame(frame);
void vision.start(settings.cameraId);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}
