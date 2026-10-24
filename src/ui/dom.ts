export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

/** Set text only when it changed, so the 60fps loop doesn't thrash the DOM. */
export function text(el: HTMLElement, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

export function show(el: Element, visible: boolean): void {
  el.toggleAttribute('hidden', !visible); // no-op when already in that state
}

export function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "1 puri", "3 puris". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function hhmmss(d = new Date()): string {
  return d.toTimeString().slice(0, 8);
}

export interface ToastAction {
  label: string;
  run: () => void;
  /** how long the toast (and its action) stays up */
  ms?: number;
}

let toastTimer = 0;
/** Short operator message at the top of the TV safe area, optionally with one action button. */
export function toast(message: string, action?: ToastAction): void {
  const el = $('toast');
  const btn = $<HTMLButtonElement>('toast-action');
  $('toast-text').textContent = message;
  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => {
      // Run first: the action may check that its offer is still on screen, or show its own toast.
      const shown = toastTimer;
      action.run();
      if (toastTimer === shown) el.hidden = true;
    };
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), Math.max(1000, action?.ms ?? 2200));
}

/** Take the toast down now, action and timer included. */
export function hideToast(): void {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
  $<HTMLButtonElement>('toast-action').onclick = null;
}

/** True while a toast with an action button is on screen. */
export function toastActionShowing(): boolean {
  return !$('toast').hidden && !$('toast-action').hidden;
}

/** Sticky notice that stays until the next key press (DD8, O22). Pass null to dismiss. */
export function notice(message: string | null): void {
  const el = $('notice');
  if (message == null) {
    if (!el.hidden) el.hidden = true;
    return;
  }
  el.textContent = message;
  el.hidden = false;
}
