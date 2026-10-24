import '@fontsource/titan-one/latin-400.css';
import '@fontsource/rubik/latin-400.css';
import '@fontsource/rubik/latin-500.css';
import '@fontsource/rubik/latin-700.css';
import '@fontsource/rubik/latin-900.css';
import './styles.css';

import { beep, buzzer, ding, unlockAudio } from './audio';
import { BiteDetector, median } from './detector';
import * as R from './round';
import {
  addResult,
  allResults,
  getRound,
  rankOf,
  recoverSavedRound,
  removeResult,
  restoreResult,
  setRound,
  settings,
  shortOfBoard,
  takeExpired,
  updateResult,
  type Result,
  type Settings,
} from './store';
import { chaseLine, renderBoard } from './ui/board';
import { $, clock, hideToast, notice, plural, show, text, toast, toastActionShowing } from './ui/dom';
import { updateBlocked } from './update';
import { CameraStage } from './ui/overlay';
import { initSetup, openScoreDialog } from './ui/setup';
import { Vision } from './vision/client';
import type { VisionResult } from './vision/protocol';

const FACE_LOST_MS = 3000;
const ESC_CONFIRM_MS = 2000;
const NO_FACE_HINT_MS = 1000;
const UNDO_MS = 5000;
/** A third quick Esc right after ending early must not skip the score reveal. */
const RESULT_ESC_GUARD_MS = 1500;
const SW_UPDATE_POLL_MS = 15000;

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
    mode: settings.detection,
    drop: settings.drop,
    windowMs: settings.windowSeconds * 1000,
  });
  vision.hands = settings.requireHand;
}
detectorFromSettings();

function applyEventLine(): void {
  const eyebrow = $('idle-eyebrow');
  text(eyebrow, settings.eventLine.trim());
  show(eyebrow, settings.eventLine.trim() !== '');
}

const setup = initSetup({
  vision,
  detector,
  applySettings(prev: Settings) {
    detectorFromSettings();
    if (prev.cameraId !== settings.cameraId) void vision.start(settings.cameraId);
    text($('idle-seconds'), `${settings.roundSeconds} seconds`);
    applyEventLine();
  },
  onBoardChanged: renderBoards,
});

/** Camera is unusable: offline after a failure, or an error before it ever worked. */
function cameraOff(): boolean {
  return vision.offline || vision.status.state === 'error';
}

// Camera lost mid-round: waiting bites can't be shown or verified any more (O16).
vision.onOffline = () => commit(R.goOffline(getRound()));
// Back online: a half-seen bite from before the outage must not complete (R4).
vision.onRecover = () => {
  detector.reset({ keepCooldown: true });
  toast('Camera back');
};

vision.onStatus = () => {
  if (vision.status.state === 'ready') void setup.listCameras();
};

vision.on((r) => {
  latest = r;
  const now = performance.now();
  if (r.faceFound) lastFaceAt = now;
  if (r.handNear) lastHandAt = now;

  let round = getRound();
  // Resting baseline ignores frames with a hand at the mouth (O11).
  if (round.phase === 'arming' && r.ratio != null && !r.handNear) baselineSamples.push(r.ratio);
  if (r.faceSwitched) detector.reset({ keepCooldown: true }); // never finish a bite across faces (O9)

  const ev = detector.push({ t: r.t, ratio: r.ratio, handNear: r.handNear });
  if (!ev) return;
  setup.logEvent(ev, now - r.t);
  if (ev.kind !== 'candidate') return;
  const openedAt = Date.now() - (performance.now() - ev.openedAt);
  round = R.candidate(round, { at: Date.now(), openedAt, peak: ev.peak, confidence: ev.confidence, hand: ev.hand }, settings.mode, Date.now());
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
/** Name to put back in the field after a cancelled countdown (DD7). */
let keepName = '';

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
    input.value = keepName;
    keepName = '';
    input.focus();
  }
  if (v === 'result') {
    renderBoards();
    $<HTMLButtonElement>('btn-next').focus(); // a late Space/Enter can't hit Re-run or Discard (O13)
  }
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
/** Results changed by Fix score / Edit a score, for the "Adjusted by referee" chip (DD12). */
const adjusted = new Set<string>();

function pop(el: HTMLElement, cls: string): void {
  el.classList.remove('pop', 'shake');
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Persist a new round state and react to what changed (sounds, saving the result). */
function commit(next: R.RoundState): void {
  const before = prev;
  if (next.phase === 'result' && !next.resultId) {
    const saved = addResult({
      name: next.name,
      score: next.count,
      rejected: next.rejected,
      notCounted: next.notCounted,
      seconds: Math.round(next.durationMs / 1000),
      at: Math.min(Date.now(), next.resultAt || Date.now()), // ties go to whoever finished first
    });
    next = { ...next, resultId: saved.id };
  }
  setRound(next);
  prev = next;

  const active = (p: R.Phase) => p === 'live' || p === 'buzzer' || p === 'paused' || p === 'result';
  if (before.phase !== 'idle' && before.phase !== 'arming' && active(next.phase)) {
    if (next.count > before.count) {
      ding(settings.sound);
      pop($('live-count'), 'pop');
    } else if (next.count < before.count && next.rejected > before.rejected) {
      pop($('live-count'), 'shake'); // Auto-mode undo (DD9)
    }
  }
  if (before.phase === 'arming' && next.phase === 'live') {
    detector.reset();
    detector.setBaseline(median(baselineSamples));
    setup.drawThresholds();
    beep(settings.sound, true);
  }
  if (R.buzzerDue(before, next)) buzzer(settings.sound);
  if (next.phase === 'idle' && before.phase !== 'idle') {
    detector.setBaseline(null);
    setup.drawThresholds();
  }
}

function roundOptions(): R.StartOptions {
  return {
    windowMs: settings.windowSeconds * 1000,
    autoConfirmMs: settings.mode === 'hybrid' ? settings.autoConfirmSeconds * 1000 : 0,
  };
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
  if (undo && !undo.rerun) {
    undo = null; // a new round closes a pending Discard undo
    hideToast();
  }
  input.blur();
  commit(R.start(name, settings.roundSeconds * 1000, Date.now(), roundOptions()));
}

// ---------- undo for Discard / Re-run (DD12, R12, O17) ----------
interface Undo {
  result: Result;
  round: R.RoundState;
  /** Re-run undo works only while the new countdown runs. */
  rerun: boolean;
  until: number;
}
let undo: Undo | null = null;

function offerUndo(u: Undo, message: string): void {
  undo = u;
  toast(message, { label: 'Undo (⌘/Ctrl Z)', run: doUndo, ms: u.until - Date.now() });
}

function doUndo(): void {
  const u = undo;
  if (!u || Date.now() > u.until) return;
  // Only from the screen it was offered on: never over the next contestant's round.
  if (u.rerun ? getRound().phase !== 'arming' : getRound().phase !== 'idle') return;
  // A Discard undo lives only as long as its toast button; a later toast replacing it ends the
  // offer. A Re-run undo stays valid for the whole countdown, even after its toast is replaced.
  if (!u.rerun && !toastActionShowing()) return;
  undo = null;
  restoreResult(u.result);
  commit({ ...u.round, resultAt: Date.now() });
  renderBoards();
  toast(`${u.result.name}'s score restored`);
}

function rerun(): void {
  const r = getRound();
  const removed = r.resultId ? removeResult(r.resultId) : null;
  baselineSamples = [];
  commit(R.start(r.name, settings.roundSeconds * 1000, Date.now(), roundOptions()));
  if (removed) offerUndo({ result: removed, round: r, rerun: true, until: Date.now() + R.ARMING_MS }, `${r.name}'s score removed for a re-run`);
}

function discard(): void {
  const r = getRound();
  const removed = r.resultId ? removeResult(r.resultId) : null;
  commit(R.IDLE);
  if (removed) offerUndo({ result: removed, round: r, rerun: false, until: Date.now() + UNDO_MS }, `${r.name}'s score removed`);
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
  adjusted.add(r.resultId);
  commit(fixed);
  renderBoards();
}

let escArmedUntil = 0;
function endPressed(): void {
  const r = getRound();
  const now = Date.now();
  if (r.phase === 'arming') {
    if (undo?.rerun && now <= undo.until) return doUndo(); // cancelling a re-run restores the old score (O17)
    keepName = r.name;
    return commit(R.end(r, now));
  }
  if (now < escArmedUntil) {
    escArmedUntil = 0;
    commit(R.end(r, now));
  } else {
    escArmedUntil = now + ESC_CONFIRM_MS;
  }
}

// ---------- fullscreen (keyboard lock keeps Esc for the app, O1) + wake lock (O7) ----------
interface KeyboardLock {
  lock(keys: string[]): Promise<void>;
  unlock(): void;
}
const keyboardLock = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

function enterFullscreen(): void {
  if (document.fullscreenElement) return;
  void document.documentElement
    .requestFullscreen?.()
    .then(() => keyboardLock?.lock(['Escape']))
    .catch(() => {});
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else enterFullscreen();
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) keyboardLock?.unlock();
});

let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake(): Promise<void> {
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (wl && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await wl.request('screen');
      (wakeLock as unknown as EventTarget).addEventListener?.('release', () => (wakeLock = null));
    }
  } catch {
    wakeLock = null; // no permission or unsupported: the README display-sleep step covers it
  }
}
document.addEventListener('visibilitychange', () => void keepAwake());

function openSetup(): void {
  if (R.isInRound(getRound())) return toast('Setup opens after this round');
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
$('btn-reject').addEventListener('click', () => commit(R.reject(getRound(), Date.now(), settings.mode)));
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
  const id = r.resultId;
  openScoreDialog(id, () => {
    const saved = allResults().find((x) => x.id === id);
    if (!saved) return commit(R.IDLE);
    if (saved.score !== getRound().count) adjusted.add(id);
    commit({ ...getRound(), count: saved.score, resultAt: Date.now() });
    renderBoards();
  });
});
$('btn-back').addEventListener('click', closeSetup);
$('btn-save').addEventListener('click', closeSetup);

// ---------- hotkeys ----------
function onKey(e: KeyboardEvent): void {
  // The sticky notice goes away on any key, and the key still does its normal job (O22).
  notice(null);
  const r = getRound();
  const view = viewFor(r);

  // Ctrl/Cmd+Z undoes a Discard / Re-run while the undo toast is up, even from the name field (R12).
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'z' || e.key === 'Z') && undo && Date.now() <= undo.until) {
    e.preventDefault();
    return doUndo();
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ($<HTMLDialogElement>('score-dialog').open) return;
  const target = e.target as HTMLElement;
  const typing = target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'number');
  const k = e.key;

  // One press = one action: held keys must not confirm or add several puris (O3).
  if (e.repeat && !typing) {
    if (k === ' ') e.preventDefault();
    return;
  }

  if (k === 'f' || k === 'F') {
    if (!typing) {
      e.preventDefault();
      toggleFullscreen();
    }
    return;
  }

  if (view === 'idle') {
    if (k === 'Escape' && target.id === 'name-input') return void target.blur();
    if (target instanceof HTMLButtonElement && (k === 'Enter' || k === ' ')) return; // a focused button (Undo, Setup) acts
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
      case 'Enter':
        e.preventDefault(); // never click the strip button the trackpad last focused
        return;
      case ' ':
        e.preventDefault();
        return commit(R.confirm(r, now));
      case 'x':
      case 'X':
        return commit(R.reject(r, now, settings.mode));
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
      case ' ':
        e.preventDefault(); // a late Space from the last bite must not click anything (O13)
        return;
      case 'Enter':
        if (target instanceof HTMLButtonElement && target.id !== 'btn-next') return; // let focused buttons act
        e.preventDefault();
        return next();
      case 'Escape':
        e.preventDefault();
        // A third quick Esc after ending early must not skip the score reveal.
        if (Date.now() - r.resultAt < RESULT_ESC_GUARD_MS) return;
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
// Space must never also click whatever button the trackpad last focused.
function onKeyUp(e: KeyboardEvent): void {
  const v = viewFor(getRound());
  if (e.key === ' ' && (v === 'live' || v === 'result')) e.preventDefault();
}

// ---------- render loop ----------
let lastArmDigit = 0;

function frame(): void {
  requestAnimationFrame(frame);
  const now = Date.now();
  // Commit the ticked state first: a round that ended while nobody was watching (reload, hidden
  // tab) must be saved before the result screen's idle timeout can clear it.
  if (undo && now > undo.until) undo = null; // an expired offer is gone (it also stops holding updates)
  const wasResult = getRound().phase === 'result';
  const ticked = R.tick(getRound(), now);
  if (ticked !== getRound()) commit(ticked);
  if (R.shouldReturnToIdle(getRound(), now) && !$<HTMLDialogElement>('score-dialog').open) {
    const done = getRound();
    if (!wasResult) notice(`${done.name}'s round ended while the screen was away: ${plural(done.count, 'puri')} saved.`);
    commit(R.IDLE);
  }
  const r = getRound();

  const view = viewFor(r);
  showView(view);
  stage.draw(cameraOff() ? null : latest);
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
  root.querySelector('.cam-box')?.classList.toggle('off', cameraOff()); // frozen last frame must not look live (DD6)
  const t = performance.now();
  const st = vision.status.state;
  let cls = 'warn';
  let msg = 'Starting camera…';
  if (cameraOff()) {
    cls = 'bad';
    msg = 'Camera off';
  } else if (st === 'loading') {
    msg = 'Loading face model…';
  } else if (st === 'ready') {
    const face = t - lastFaceAt < 500;
    if (vision.tooDark('crowd')) {
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
  const off = cameraOff();
  const paused = r.phase === 'paused';

  // Countdown overlay (z 60) with no-face / camera-off hint (DD7)
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
    const hint = $('arming-hint');
    const noFace = performance.now() - lastFaceAt > NO_FACE_HINT_MS;
    const hintText = off ? 'Camera off · the referee will count' : noFace ? "We can't see you, step into the oval" : 'Mouth closed, look at the camera';
    text(hint, hintText);
    hint.classList.toggle('warn', off || noFace);
  }
  lastArmDigit = digit;

  // Timer: TIME! after zero (DD3), muted with a pause glyph while paused (DD5)
  text($('live-name'), r.name);
  const left = R.remaining(r, now);
  const timer = $('live-timer');
  const afterZero = r.phase === 'buzzer' || (paused && r.pausedFrom === 'buzzer');
  text(timer, afterZero ? 'TIME!' : clock(left));
  timer.classList.toggle('low', r.phase === 'live' && left <= 10000);
  timer.classList.toggle('paused', paused);
  show($('live-pause-glyph'), paused);
  const total = r.durationMs || 1;
  $('live-progress-fill').style.transform = `scaleX(${left / total})`;
  const prog = $('live-progress');
  prog.setAttribute('aria-valuemax', String(Math.round(total / 1000)));
  prog.setAttribute('aria-valuenow', String(Math.ceil(left / 1000)));

  const chip = $('live-chip-text');
  text(chip, paused ? 'Paused' : afterZero ? 'Time!' : 'Live');
  chip.parentElement!.classList.toggle('paused', paused);

  text($('live-count'), String(r.count));
  text($('live-chase-text'), chaseLine(allResults(), r.count));

  // Camera box overlays, top to bottom: camera off (50) > paused (40) > banner (30) > step back (20) (DD17)
  $('live-cam').classList.toggle('dim', paused && !off);
  show($('off-card'), off);
  show($('paused-card'), paused && !off);

  const waiting = r.queue.length;
  const banner = $('bite-banner');
  show(banner, waiting > 0 && !off);
  if (waiting) {
    text($('bite-title'), paused ? 'Under review' : afterZero ? 'Last bite? Referee decides' : 'Bite spotted!');
    const help = banner.querySelector<HTMLElement>('.bite-help')!;
    help.classList.toggle('wrapped', help.offsetTop > $('bite-title').offsetTop + 8); // on its own line under the title
    const more = $('bite-more');
    show(more, waiting > 1);
    text(more, `+${waiting - 1} more`);
    // Auto-confirm countdown for the oldest bite (DD24); frozen while paused.
    const bar = $('auto-bar');
    show(bar, r.autoConfirmMs > 0 && r.dueAt > 0);
    if (r.autoConfirmMs > 0 && r.dueAt > 0) {
      const clockNow = paused ? r.pausedAt : now;
      const frac = Math.max(0, Math.min(1, (r.dueAt - clockNow) / r.autoConfirmMs));
      $('auto-bar-fill').style.transform = `scaleX(${frac})`;
    }
  }
  const faceGone = !off && vision.status.state === 'ready' && performance.now() - lastFaceAt > FACE_LOST_MS;
  show($('stepback'), r.phase === 'live' && faceGone);

  // Strip: the primary action follows how counting is happening right now (DD2, O16)
  const strip = $('live-strip');
  const plusPrimary = off || settings.mode === 'manual' || (settings.mode === 'auto' && !waiting);
  strip.dataset.primary = plusPrimary ? 'plus' : 'confirm';
  text($('btn-plus'), plusPrimary ? '+1 puri (+)' : '+1');
  const canUndo = settings.mode === 'auto' && r.undoable && r.count > 0;
  $<HTMLButtonElement>('btn-confirm').disabled = !waiting;
  $<HTMLButtonElement>('btn-reject').disabled = !waiting && !canUndo;
  text($('btn-reject-label'), settings.mode === 'auto' && !waiting ? 'Undo last' : 'Not a puri');
  text($('btn-pause'), paused ? 'Resume (P)' : 'Pause (P)');

  const armed = now < escArmedUntil;
  const end = $('btn-end');
  text(end, armed ? (waiting ? `Press Esc again to end (${plural(waiting, 'bite')} waiting)` : 'Press Esc again to end') : 'End round (Esc)');
  end.classList.toggle('armed', armed);

  text($('live-last'), stripStatus(r, off));
}

function stripStatus(r: R.RoundState, off: boolean): string {
  if (off) return 'Camera off: press + for each puri';
  const mode =
    settings.mode === 'manual'
      ? 'manual counting'
      : settings.mode === 'auto'
        ? 'auto counting'
        : settings.autoConfirmSeconds > 0
          ? `auto-confirm after ${settings.autoConfirmSeconds}s`
          : 'auto-confirm off';
  const conf = r.queue.length ? `confidence ${r.queue[0].confidence.toFixed(2)} · ` : ''; // DD1: confidence lives here
  let last: string;
  if (!r.last) last = r.count ? `Count ${r.count}` : 'No puris yet';
  else if (r.last.count === r.count) last = `Last: puri ${r.last.count} confirmed at ${clock(r.last.remaining)}`;
  else if (r.count < r.last.count) last = `Referee removed puri ${r.last.count}`;
  else last = `Count adjusted to ${r.count}`;
  return `${conf}${last} · ${mode}`;
}

function renderResult(r: R.RoundState, now: number): void {
  text($('res-name'), r.name);
  text($('res-count'), String(r.count));
  text($('res-unit'), r.count === 1 ? 'puri' : 'puris');

  // Outcome pill (DD11)
  const rank = r.resultId ? rankOf(r.resultId) : 0;
  let pill: string;
  let trophy = true;
  if (r.count === 0) {
    pill = `Good try, ${r.name}!`;
    trophy = false;
  } else if (rank === 1) pill = 'New #1 on the board!';
  else if (rank > 0 && rank <= 10) pill = `New #${rank} on the board`;
  else {
    const k = r.resultId ? shortOfBoard(r.count, r.resultId) : 0;
    pill = k > 0 ? `${k} more would have made the board` : `#${rank} tonight`;
    trophy = false;
  }
  text($('res-rank'), pill);
  show(document.getElementById('res-trophy')!, trophy);
  show($('res-adjusted'), !!r.resultId && adjusted.has(r.resultId));

  // Subline (DD10)
  const secs = Math.round(r.durationMs / 1000);
  const parts = [`In ${secs} seconds`];
  if (r.rejected) parts.push(`${r.rejected} rejected by the referee`);
  if (r.notCounted) parts.push(`${r.notCounted} not counted`);
  text($('res-sub'), parts.join(' · '));
  const back = Math.max(0, Math.ceil((R.RESULT_IDLE_MS - (now - r.resultAt)) / 1000));
  text($('res-countdown'), `Back to sign-up in ${back}s`);
}

// ---------- boot ----------
const CLAIM_WAIT_MS = 1500;

/**
 * One stall, one tab: a second tab would open the camera again and overwrite the board on save. Waits for
 * the lock (a reload's old page lets go a moment later); if it is still held after CLAIM_WAIT_MS, `onWait`
 * shows the "already open" screen. Resolves once this tab owns the stall.
 */
function claimTab(onWait: () => void): Promise<void> {
  if (!navigator.locks) return Promise.resolve();
  return new Promise((resolve) => {
    const wait = window.setTimeout(onWait, CLAIM_WAIT_MS);
    const granted = () => {
      clearTimeout(wait);
      resolve();
    };
    navigator.locks
      .request('ppc-stall', () => {
        granted();
        return new Promise<void>(() => {}); // hold it for the life of the page
      })
      .catch(granted); // locks unavailable here: run as the only tab
  });
}

let waitedForTab = false;
void claimTab(() => {
  waitedForTab = true;
  $('stage').inert = true; // the app under the overlay must not take focus, clicks or a form submit
  show($('other-tab'), true);
}).then(() => {
  // The other tab went away. This page's copy of the board is from before it closed: start fresh.
  if (waitedForTab) return location.reload();
  boot();
});

/** Runs once this tab owns the stall; until then nothing listens and the inert stage blocks the rest. */
function boot(): void {
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKeyUp);
  recoverSavedRound();
  prev = getRound();
  text($('idle-seconds'), `${settings.roundSeconds} seconds`);
  applyEventLine();
  renderBoards();
  requestAnimationFrame(frame);
  void vision.start(settings.cameraId);
  void keepAwake();
  addEventListener('pointerdown', () => void keepAwake(), { once: true });
  addEventListener('keydown', () => void keepAwake(), { once: true });

  // A round saved before a crash and too old to resume (DD8, O12 + review fix).
  const e = takeExpired();
  if (e) {
    const time = new Date(e.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    notice(
      e.saved > 0
        ? `${e.name}'s round (${time}) was recovered: ${plural(e.saved, 'puri')} saved.`
        : `${e.name}'s round (${time}) expired, not saved. Re-run from sign-up.`,
    );
  }

  if (import.meta.env.PROD && 'serviceWorker' in navigator) void registerServiceWorker();
}

/** Whether a waiting deploy would interrupt the referee right now (see update.ts). */
function updateIsBlocked(): boolean {
  return updateBlocked(
    {
      phase: getRound().phase,
      setupOpen,
      dialogOpen: $<HTMLDialogElement>('score-dialog').open,
      undoUntil: undo?.until ?? null,
      name: $<HTMLInputElement>('name-input').value,
      noticeShown: !$('notice').hidden,
    },
    Date.now(),
  );
}

/** A new version waits; it takes over (and the page reloads) only when nothing on screen would be lost. */
async function registerServiceWorker(): Promise<void> {
  // First visit: the new worker claims the page, but nothing old is running, so no reload.
  let hadController = !!navigator.serviceWorker.controller;
  const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  let pendingReload = false;
  const reloadWhenSafe = () => {
    if (pendingReload && !updateIsBlocked()) location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true; // first claim of a fresh tab; later updates must reload
      return;
    }
    pendingReload = true;
    reloadWhenSafe();
  });
  const promote = () => {
    // Same rule as the reload: activating deletes the old build's cache, so the page must reload at once.
    if (reg.waiting && navigator.serviceWorker.controller && !updateIsBlocked()) {
      reg.waiting.postMessage({ type: 'skip-waiting' });
    }
  };
  reg.addEventListener('updatefound', () => {
    reg.installing?.addEventListener('statechange', promote);
  });
  promote();
  window.setInterval(() => {
    promote(); // picks the next quiet moment if the referee was busy
    reloadWhenSafe();
  }, SW_UPDATE_POLL_MS);
}
