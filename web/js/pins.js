// Favourites: links pinned above the list, in an order of their own, and
// Alt+1 to Alt+9 for the first nine wherever the app is. `f` pins and unpins
// the link under the cursor; dragging one pin onto another puts it before it.

import * as store from './store.js';
import { $, esc, favicon, hostOf, icon } from './ui.js';

const DRAG_TYPE = 'application/x-linksz-pin';

export function openPin(n) {
  const b = store.pins()[n - 1];
  if (!b || !b.url) return false;
  store.registerOpen(b.id);
  window.open(b.url, '_blank', 'noopener');
  return true;
}

function paint() {
  const bar = $('#pins');
  const list = store.pins();
  bar.hidden = !list.length;
  bar.innerHTML = list.map((b, i) => `<a class="pin" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer"
      data-id="${esc(b.id)}" draggable="true" title="${esc(b.url)}${i < 9 ? ` (Alt+${i + 1})` : ''}">
      ${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}${favicon(b.url, b.title)}<span>${esc(b.title || hostOf(b.url) || b.url)}</span>
      <button type="button" class="pin-x" data-unpin title="Unpin">${icon('x')}</button></a>`).join('');
}

export function init() {
  const bar = $('#pins');
  bar.addEventListener('click', (e) => {
    const pin = e.target.closest('.pin');
    if (!pin) return;
    if (e.target.closest('[data-unpin]')) {
      e.preventDefault();
      store.togglePin(pin.dataset.id);
      return;
    }
    store.registerOpen(pin.dataset.id);
  });
  bar.addEventListener('dragstart', (e) => {
    const pin = e.target.closest('.pin');
    if (!pin) return;
    e.dataTransfer.setData(DRAG_TYPE, pin.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    pin.classList.add('dragging');
  });
  bar.addEventListener('dragend', (e) => e.target.closest?.('.pin')?.classList.remove('dragging'));
  bar.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes(DRAG_TYPE) && e.target.closest('.pin')) e.preventDefault();
  });
  bar.addEventListener('drop', (e) => {
    const target = e.target.closest('.pin');
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (!target || !id || target.dataset.id === id) return;
    e.preventDefault();
    const order = store.pins().map((b) => b.id).filter((x) => x !== id);
    order.splice(order.indexOf(target.dataset.id), 0, id);
    store.orderPins(order);
  });
  store.subscribe(paint);
  paint();
}
