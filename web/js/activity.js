// Activity: what gets opened, and when, from the server's log of opens. The
// log is on the server, so this is the same on every device.

import { api } from './http.js';
import { $, $$, esc, plural, hostOf } from './ui.js';

let days = 7;

async function load() {
  for (const b of $$('#act-range button')) b.classList.toggle('on', Number(b.dataset.days) === days);
  $('#act-chart').innerHTML = '<span class="muted">Loading…</span>';
  try {
    paint(await api(`/api/insights?days=${days}`));
  } catch (err) {
    $('#act-chart').innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
}

function paint(r) {
  $('#act-total').textContent = r.total.toLocaleString();
  const peak = Math.max(1, ...r.daily.map((d) => d.count));
  // A month of labels is a smudge: past two weeks, every few days.
  const every = Math.ceil(r.daily.length / 10);
  $('#act-chart').innerHTML = r.daily.map((d, i) => {
    const [, m, day] = d.day.split('-');
    const label = (r.daily.length - 1 - i) % every === 0 ? `${day}/${m}` : '';
    const h = Math.round((d.count / peak) * 100);
    return `<div class="bar-col" title="${d.day}: ${plural(d.count, 'open')}">
      <span class="bar-val">${d.count && (label || r.daily.length <= 14) ? d.count : ''}</span>
      <div class="bar${d.count ? '' : ' zero'}" style="height:${h}%"></div>
      <span class="bar-day">${label}</span></div>`;
  }).join('');

  const ever = new Map(r.top_ever.map((b) => [b.id, b.total]));
  const top = r.top.length ? r.top : r.top_ever.map((b) => ({ ...b, hits: 0 }));
  $('#act-top').innerHTML = top.map((b) => {
    const total = ever.get(b.id) ?? b.total ?? 0;
    return `<li><a class="grow" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" title="${esc(b.url)}">${esc(b.title || hostOf(b.url) || b.url)}</a>
      <span class="num">${b.hits ? `${b.hits}× · ` : ''}${total} total</span></li>`;
  }).join('') || '<li class="muted">Nothing opened yet.</li>';

  $('#act-log').innerHTML = r.log.slice(0, 60).map((row) => {
    const when = new Date(row.at).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<li><span class="num">${when}</span><a class="grow" href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">${esc(row.title || row.url)}</a></li>`;
  }).join('') || '<li class="muted">No opens in this window.</li>';
}

export function init() {
  for (const b of $$('#act-range button')) b.onclick = () => { days = Number(b.dataset.days); load(); };
}

export function show() {
  load();
}
