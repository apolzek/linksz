'use strict';

// The audit trail: what happened to each link, and every click in the app.
//
// Changes are worked out on the server, by comparing a row before and after a
// write. Every path that writes a link (the form, a move, an import, a folder
// renamed, a sync from another device) goes through the same comparison, so
// none of them can forget to log, and a write that changed nothing, like an
// open counted or a stale sync that lost, logs nothing.

const EDIT_FIELDS = ['title', 'url', 'category', 'tags', 'description'];

const ACTIONS = ['create', 'edit', 'move', 'delete', 'restore'];

// Clicks are a recent history, not a record: pruned on write, like the opens.
const CLICK_DAYS = 90;
const CLICK_BATCH = 200;

/**
 * What a write did to one link, or null when it did nothing worth logging.
 * `before` is the row as it was (undefined if there was none), `after` the row
 * as it is now. Both are rows of the bookmarks table.
 */
function describeChange(before, after) {
  if (!after) return null;
  const wasLive = Boolean(before) && !before.deleted;
  const isLive = !after.deleted;

  if (!wasLive && !isLive) return null;
  if (!wasLive) return { action: before ? 'restore' : 'create', changes: {} };
  if (!isLive) return { action: 'delete', changes: {} };

  const changes = {};
  for (const f of EDIT_FIELDS) {
    if ((before[f] ?? '') !== (after[f] ?? '')) changes[f] = [before[f] ?? '', after[f] ?? ''];
  }
  const edited = Object.keys(changes).length > 0;
  const moved = (before.folder ?? '') !== (after.folder ?? '');
  if (moved) changes.folder = [before.folder ?? '', after.folder ?? ''];
  if (!edited && !moved) return null;
  return { action: edited ? 'edit' : 'move', changes };
}

const clip = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// One click as the app reported it, trimmed to what the table holds. The time
// is the browser's, so a batch sent late still says when each click happened,
// unless it is so far off that it can only be a wrong clock.
function normClick(c, ts) {
  if (!c || typeof c !== 'object') return null;
  const at = Number(c.at);
  const label = clip(c.label, 160);
  const target = clip(c.target, 160);
  if (!label && !target) return null;
  return {
    at: at > ts - 86400000 && at <= ts + 60000 ? Math.floor(at) : ts,
    route: clip(c.route, 80),
    label,
    target,
    href: clip(c.href, 500),
  };
}

module.exports = { describeChange, normClick, ACTIONS, EDIT_FIELDS, CLICK_DAYS, CLICK_BATCH };
