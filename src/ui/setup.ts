// Setup + calibration screen (operator only).

import type { BiteDetector, DetectorEvent, DetectorMode } from '../detector';
import { allResults, clearResults, ranked, removeResult, resultsCsv, saveSettings, settings, updateResult, type Settings } from '../store';
import type { CountMode } from '../round';
import type { Vision } from '../vision/client';
import type { VisionResult } from '../vision/protocol';
import { $, hhmmss, plural, show, text, toast } from './dom';

const LOG_LINES = 6;
const DIALOG_IDLE_MS = 60_000;

export interface SetupDeps {
  vision: Vision;
  detector: BiteDetector;
  applySettings: (prev: Settings) => void;
  onBoardChanged: () => void;
}

export function initSetup(deps: SetupDeps) {
  const cam = $<HTMLSelectElement>('set-camera');
  const seconds = $<HTMLInputElement>('set-seconds');
  const autoconfirm = $<HTMLInputElement>('set-autoconfirm');
  const sound = $<HTMLSelectElement>('set-sound');
  const sens = $<HTMLInputElement>('set-sens');
  const cooldown = $<HTMLInputElement>('set-cooldown');
  const hand = $<HTMLInputElement>('set-hand');
  const eventLine = $<HTMLInputElement>('set-event');
  const drop = $<HTMLInputElement>('set-drop');
  const close = $<HTMLInputElement>('set-close');
  const windowEl = $<HTMLInputElement>('set-window');
  const detections = document.querySelectorAll<HTMLInputElement>('input[name="detection"]');
  const modes = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');
  const log = $<HTMLUListElement>('set-log');
  let logStarted = false;

  function fill(): void {
    seconds.value = String(settings.roundSeconds);
    autoconfirm.value = String(settings.autoConfirmSeconds);
    sound.value = settings.sound;
    sens.value = String(settings.open);
    cooldown.value = String(settings.cooldownSeconds);
    hand.checked = settings.requireHand;
    if (document.activeElement !== eventLine) eventLine.value = settings.eventLine;
    drop.value = String(settings.drop);
    close.value = String(settings.close);
    windowEl.value = String(settings.windowSeconds);
    modes.forEach((m) => (m.checked = m.value === settings.mode));
    detections.forEach((m) => (m.checked = m.value === settings.detection));
    // One slot, two sliders: Absolute tunes the close line, Relative tunes the drop (DD20).
    const relative = settings.detection === 'relative';
    show($('field-drop'), relative);
    show($('field-close'), !relative);
    text($('set-sens-val'), settings.open.toFixed(2));
    text($('set-drop-val'), settings.drop.toFixed(2));
    text($('set-close-val'), settings.close.toFixed(2));
    text($('set-window-val'), `${settings.windowSeconds.toFixed(1)} s`);
    text($('set-cooldown-val'), `${settings.cooldownSeconds.toFixed(1)} s`);
    drawThresholds();
  }

  function change(patch: Partial<Settings>): void {
    const prev = { ...settings };
    saveSettings(patch);
    deps.applySettings(prev);
    fill();
  }

  const clampNum = (el: HTMLInputElement, fallback: number) => {
    const v = Number(el.value);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(Number(el.max), Math.max(Number(el.min), v));
  };

  cam.addEventListener('change', () => change({ cameraId: cam.value }));
  seconds.addEventListener('change', () => change({ roundSeconds: Math.round(clampNum(seconds, 60)) }));
  autoconfirm.addEventListener('change', () => change({ autoConfirmSeconds: clampNum(autoconfirm, 0) }));
  sound.addEventListener('change', () => change({ sound: sound.value as Settings['sound'] }));
  sens.addEventListener('input', () => change({ open: Number(sens.value) }));
  cooldown.addEventListener('input', () => change({ cooldownSeconds: Number(cooldown.value) }));
  hand.addEventListener('change', () => change({ requireHand: hand.checked }));
  eventLine.addEventListener('input', () => change({ eventLine: eventLine.value.slice(0, 40) }));
  drop.addEventListener('input', () => change({ drop: Number(drop.value) }));
  close.addEventListener('input', () => change({ close: Number(close.value) }));
  windowEl.addEventListener('input', () => change({ windowSeconds: Number(windowEl.value) }));
  detections.forEach((m) => m.addEventListener('change', () => m.checked && change({ detection: m.value as DetectorMode })));
  modes.forEach((m) => m.addEventListener('change', () => m.checked && change({ mode: m.value as CountMode })));

  $('btn-csv').addEventListener('click', () => {
    const blob = new Blob([resultsCsv()], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pani-puri-board-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('btn-clear').addEventListener('click', () => {
    if (!allResults().length) return toast('Board is already empty');
    if (!confirm('Clear the whole leaderboard?')) return;
    if (!confirm('Really clear it? This cannot be undone.')) return;
    clearResults();
    deps.onBoardChanged();
    toast('Board cleared');
  });

  $('btn-edit').addEventListener('click', () => {
    if (!allResults().length) return toast('No scores to edit yet');
    openScoreDialog(null, deps.onBoardChanged);
  });

  async function listCameras(): Promise<void> {
    const list = await deps.vision.cameras().catch(() => []);
    const current = settings.cameraId || deps.vision.currentDeviceId();
    cam.replaceChildren(
      ...list.map((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Camera ${i + 1}`;
        o.selected = d.deviceId === current;
        return o;
      }),
    );
    if (!list.length) cam.append(new Option('No camera found', ''));
  }

  /** Meter lines show the rule actually in force: a fixed close line, or Relative's moving "peak minus drop" (DD20). */
  function drawThresholds(): void {
    const st = deps.detector.state;
    const open = settings.open;
    const closeAt = Number.isFinite(st.closeLine) ? st.closeLine : null;
    const cl = $('meter-close-label');
    const ol = $('meter-open-label');
    const closeLine = $('meter-close-line');
    show(closeLine, closeAt != null);
    closeLine.classList.toggle('dashed', st.mode === 'relative');
    if (closeAt != null) {
      const pct = `${Math.max(0, closeAt) * 100}%`;
      closeLine.style.left = pct;
      cl.style.left = pct;
    }
    $('meter-open-line').style.left = `${open * 100}%`;
    ol.style.left = `${open * 100}%`;
    show(cl, closeAt != null);
    // Near each other the two centred labels would overlap: hang close to the left of its line, open to the right.
    const tight = closeAt != null && open - closeAt < 0.16;
    cl.style.transform = tight ? 'translateX(-100%)' : '';
    ol.style.transform = tight ? 'translateX(0)' : '';
    text(cl, st.mode === 'relative' ? `drop ${settings.drop.toFixed(2)}` : `close ${(closeAt ?? 0).toFixed(2)}`);
    text(ol, `open ${open.toFixed(2)}`);
  }

  function logEvent(e: DetectorEvent, latencyMs: number): void {
    if (!logStarted) {
      log.replaceChildren();
      logStarted = true;
    }
    const li = document.createElement('li');
    const when = hhmmss();
    if (e.kind === 'candidate') {
      const verdict = settings.mode === 'auto' ? 'would count' : settings.mode === 'hybrid' ? 'would ask referee' : 'manual mode, not counted';
      li.className = 'hit';
      li.textContent = `${when} · bite candidate · ratio peak ${e.peak.toFixed(2)} · hand ${e.hand ? 'yes' : 'no'} · ${verdict} · ${Math.round(latencyMs)} ms`;
    } else {
      const why = {
        timeout: `open without close in ${(deps.detector.config.windowMs / 1000).toFixed(1)}s`,
        cooldown: `too soon after last bite (${settings.cooldownSeconds.toFixed(1)}s gap)`,
        'no-hand': 'no hand near mouth',
      }[e.reason];
      li.textContent = `${when} · ${why} · peak ${e.peak.toFixed(2)} · ignored`;
    }
    log.prepend(li);
    while (log.children.length > LOG_LINES) log.lastElementChild?.remove();
  }

  function update(r: VisionResult | null): void {
    const v = deps.vision;
    const status = $('set-status');
    const [dot, label] = [status.children[0] as HTMLElement, status.children[1] as HTMLElement];
    let cls = '';
    if (v.status.state === 'error') {
      cls = 'bad';
      text(label, v.status.message); // named cause: blocked, busy, no camera, model, worker, stalled
    } else if (v.status.state !== 'ready') {
      text(label, 'Loading face model…');
    } else if (r?.faceFound) {
      cls = 'ok';
      text(label, `Face found · ${Math.round(v.fps())} fps · ${v.status.delegate}`);
    } else {
      cls = 'bad';
      text(label, `No face · ${Math.round(v.fps())} fps`);
    }
    status.className = `status-line ${cls}`;
    dot.className = `dot ${cls}`;

    const ratio = r?.ratio ?? null;
    text($('meter-value'), ratio == null ? '–' : ratio.toFixed(2));
    $('meter-fill').style.width = `${Math.min(1, ratio ?? 0) * 100}%`;
    $('meter').setAttribute('aria-valuenow', (ratio ?? 0).toFixed(2));
    const waiting = deps.detector.state.phase !== 'closed';
    show($('meter-wait'), waiting);
    text($('meter-wait'), settings.detection === 'relative' ? 'Waiting for drop' : 'Waiting for close');
    $('meter').classList.toggle('waiting', waiting);
    if (settings.detection === 'relative') drawThresholds(); // the close line follows the peak

    show($('set-dark'), v.status.state === 'ready' && v.tooDark('setup'));
    const lat = v.latency();
    const latEl = $('set-latency');
    if (lat.p50 > 0) {
      text(latEl, `Latency p50 ${Math.round(lat.p50)} ms · p95 ${Math.round(lat.p95)} ms ${lat.p95 < 150 ? '✓ under 150' : '✗ over 150'}`);
      latEl.classList.toggle('over', lat.p95 >= 150);
    }

    const all = allResults();
    const top = ranked(all)[0];
    text(
      $('set-board-stats'),
      all.length ? `${plural(all.length, 'contestant')} tonight · high score ${top.score} · saved here` : 'No contestants yet',
    );
  }

  fill();
  return { fill, update, logEvent, listCameras, drawThresholds };
}

/** Edit dialog. With `id`, edits that one entry (result screen "Fix score"); else lets you pick. */
export function openScoreDialog(id: string | null, onDone: () => void): void {
  const dialog = $<HTMLDialogElement>('score-dialog');
  const pick = $<HTMLSelectElement>('score-pick');
  const value = $<HTMLInputElement>('score-value');
  const list = ranked();
  show($('score-pick-field'), id == null);
  pick.replaceChildren(...list.map((r, i) => new Option(`#${i + 1} ${r.name} · ${r.score}`, r.id, false, r.id === id)));
  const current = () => list.find((r) => r.id === pick.value);
  const sync = () => (value.value = String(current()?.score ?? 0));
  pick.onchange = sync;
  sync();

  $('score-delete').onclick = () => {
    const r = current();
    if (r && confirm(`Remove ${r.name} (${r.score}) from the board?`)) {
      removeResult(r.id);
      dialog.close('deleted');
    }
  };
  // A forgotten dialog must not hold the stall: close unsaved after a minute without input.
  let idle = 0;
  const poke = () => {
    clearTimeout(idle);
    idle = window.setTimeout(() => dialog.open && dialog.close(''), DIALOG_IDLE_MS);
  };
  dialog.oninput = poke;
  dialog.onkeydown = poke;
  poke();
  dialog.onclose = () => {
    clearTimeout(idle);
    const r = current();
    // A cleared field is not a zero: never overwrite a saved score with nothing typed.
    if (dialog.returnValue === 'save' && r && value.value.trim() !== '') {
      const score = Math.max(0, Math.round(Number(value.value) || 0));
      updateResult(r.id, { score });
    }
    onDone();
  };
  dialog.returnValue = '';
  dialog.showModal();
  (id == null ? pick : value).focus();
  if (id != null) value.select();
}
