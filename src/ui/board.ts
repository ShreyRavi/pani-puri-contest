import { ranked, type Result } from '../store';

/** Rows the board always shows; "open" fills the gaps until this many have played. */
export const ROWS = 10;

/**
 * Render the whole board: #1 in `pin` (always visible), #2 down in `list` (the scrolling part).
 * At least ROWS rows, more once more people have played. `highlightId` gets the "me" style on the
 * result screen.
 */
export function renderBoard(pin: HTMLOListElement, list: HTMLOListElement, results: readonly Result[], highlightId: string | null = null): void {
  const all = ranked(results);
  const rows = Math.max(ROWS, all.length);
  const row = (i: number): HTMLLIElement => {
    const r = all[i];
    const li = document.createElement('li');
    li.className = 'board-row';
    if (!r) li.classList.add('empty');
    else if (highlightId) li.classList.toggle('me', r.id === highlightId);
    else if (i === 0) li.classList.add('top');
    li.append(cell('rank', String(i + 1)), cell('name', r ? r.name : 'open'), cell('pts', r ? String(r.score) : '–'));
    return li;
  };
  pin.replaceChildren(row(0));
  const frag = document.createDocumentFragment();
  for (let i = 1; i < rows; i++) frag.append(row(i));
  list.replaceChildren(frag);
}

function cell(cls: string, value: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = value;
  return s;
}

/** "2 more to pass Arjun" for the live score card. Ties go to whoever set the score first. */
export function chaseLine(results: readonly Result[], count: number): string {
  const board = ranked(results);
  if (!board.length) return count ? 'Leading the board!' : 'First on the board tonight';
  if (count > board[0].score) return 'Leading the board!';
  const ahead = board.filter((r) => r.score >= count);
  const target = ahead[ahead.length - 1];
  const need = target.score - count + 1;
  return `${need} more to pass ${target.name}`;
}
