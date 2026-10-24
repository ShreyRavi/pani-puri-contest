// Setup + calibration screen (operator only).

import type { BiteDetector, DetectorEvent } from '../detector';
import { allResults, clearResults, ranked, removeResult, resultsCsv, saveSettings, settings, updateResult, type Settings } from '../store';
import type { CountMode } from '../round';
import type { Vision } from '../vision/client';
import type { VisionResult } from '../vision/protocol';
import { $, hhmmss, show, text, toast } from './dom';

const LOG_LINES = 6;

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
    modes.forEach((m) => (m.checked = m.value === settings.mode));
    text($('set-sens-val'), settings.open.toFixed(2));
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

  function drawThresholds(): void {
    const close = deps.detector.closeThreshold;
    const open = settings.open;
    $('meter-close-line').style.left = `${close * 100}%`;
    $('meter-open-line').style.left = `${open * 100}%`;
    const cl = $('meter-close-label');
    const ol = $('meter-open-label');
    cl.style.left = `${close * 100}%`;
    ol.style.left = `${open * 100}%`;
    text(cl, `close ${close.toFixed(2)}`);
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
      text(label, v.status.message);
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

    show($('set-dark'), v.status.state === 'ready' && v.tooDark());
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
      all.length ? `${all.length} contestant${all.length === 1 ? '' : 's'} tonight · high score ${top.score} · saved on this laptop` : 'No contestants yet',
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
  dialog.onclose = () => {
    const r = current();
    if (dialog.returnValue === 'save' && r) {
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
