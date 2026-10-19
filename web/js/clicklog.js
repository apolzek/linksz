// Every click in the app, for the audit page. Clicks are queued and sent in
// batches, a few seconds apart and when the tab is hidden, so logging never
// costs a request per click. Only what was clicked is recorded, never what was
// typed: an input reports its name, not its value.

import { getToken } from './http.js';

const FLUSH_MS = 4000;
const BATCH = 200;
const KEEP = 1000;

const queue = [];
let timer = 0;

const CLICKABLE = [
  'button', 'a', 'summary', 'label', 'input', 'select', 'textarea',
  '[data-act]', '[role="option"]', '[role="treeitem"]', '.row', '.orow', '.node', '.group',
].join(',');

const clip = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// What a person would call the thing: its text, or the tooltip of an icon.
function labelOf(el) {
  if (el.matches('input, select, textarea')) {
    return clip(el.getAttribute('aria-label') || el.placeholder || el.name || el.id || el.type, 160);
  }
  const row = el.closest('.row, .orow');
  const text = clip(el.innerText || el.textContent, 160);
  if (row && !text) return clip(row.querySelector('.row-title, .orow-title, a')?.textContent, 160);
  return text || clip(el.getAttribute('aria-label') || el.title, 160);
}

// Enough to find the element again: tag, id, first class, its action.
function targetOf(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  else if (el.classList.length) s += `.${el.classList[0]}`;
  if (el.dataset.act) s += `[${el.dataset.act}]`;
  const scope = el.closest('[id]');
  if (scope && scope !== el && scope.id) s = `#${scope.id} ${s}`;
  return clip(s, 160);
}

export function describe(el) {
  const hit = el.closest?.(CLICKABLE) || el;
  if (!hit || hit === document.body || hit === document.documentElement) return null;
  const href = hit.closest('a')?.getAttribute('href') || '';
  return {
    at: Date.now(),
    route: location.hash || '#/',
    label: labelOf(hit),
    target: targetOf(hit),
    href: /^(https?:|#)/i.test(href) ? href : '',
  };
}

function onClick(e) {
  if (!getToken() || document.querySelector('#shell')?.hidden) return;
  const c = describe(e.target);
  if (!c || (!c.label && !c.target)) return;
  queue.push(c);
  if (queue.length > KEEP) queue.splice(0, queue.length - KEEP);
  clearTimeout(timer);
  timer = setTimeout(flush, FLUSH_MS);
}

// Sends what is queued. `keepalive` lets the last batch leave with the tab.
export async function flush() {
  clearTimeout(timer);
  if (!queue.length || !getToken()) return;
  const batch = queue.splice(0, BATCH);
  try {
    const res = await fetch('/api/audit/clicks', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ clicks: batch }),
    });
    if (res.status >= 500) throw new Error();
  } catch {
    // Offline or a restart: back to the front of the line for the next try.
    queue.unshift(...batch);
    if (queue.length > KEEP) queue.splice(KEEP);
    return;
  }
  if (queue.length) await flush();
}

export function init() {
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', (e) => { if (e.button === 1) onClick(e); }, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}
