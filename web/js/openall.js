// Opens a whole folder, or whatever the list shows, each link in a tab of its
// own. Past a handful it asks first, since thirty tabs are not undone by Esc.
//
// A browser lets one click open one window; the rest of a burst is blocked
// unless pop-ups are allowed for this site. A blocked open is told apart
// here (window.open gives null for it) and the toast says what to do. That
// is also why there is no `noopener` in the call: with it, window.open gives
// null every time, opened or not. The opener is cut by hand instead.

import * as store from './store.js';
import { confirmDialog, toast, plural } from './ui.js';

export const ASK_ABOVE = 10;

export async function openAll(links, label = 'these') {
  const urls = links.filter((b) => b && /^https?:/i.test(b.url || ''));
  if (!urls.length) { toast('No links to open here'); return 0; }
  if (urls.length > ASK_ABOVE) {
    const yes = await confirmDialog({
      title: `Open ${plural(urls.length, 'link')}?`,
      text: `Every link in ${label}, each in a tab of its own.`,
      ok: `Open ${urls.length}`,
      danger: false,
    });
    if (!yes) return 0;
  }
  let opened = 0;
  for (const b of urls) {
    const w = window.open(b.url, '_blank');
    if (!w) continue;
    try { w.opener = null; } catch { /* another origin already */ }
    opened += 1;
    store.registerOpen(b.id);
  }
  const blocked = urls.length - opened;
  if (blocked) {
    toast(`The browser blocked ${blocked} of ${urls.length}. Allow pop-ups for this site, then open them again.`,
      { error: true, ms: 9000 });
  } else {
    toast(`Opened ${plural(opened, 'link')}`);
  }
  return opened;
}
