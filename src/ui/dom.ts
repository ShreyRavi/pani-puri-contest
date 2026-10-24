export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

/** Set text only when it changed, so the 60fps loop doesn't thrash the DOM. */
export function text(el: HTMLElement, value: string): void {
  if (el.textContent !== value) el.textContent = value;
}

export function show(el: HTMLElement, visible: boolean): void {
  if (el.hidden === visible) el.hidden = !visible;
}

export function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function hhmmss(d = new Date()): string {
  return d.toTimeString().slice(0, 8);
}

let toastTimer = 0;
export function toast(message: string): void {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 2200);
}
